import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { rag } from "./rag";
import { chunkFile, extractSymbols, shouldIndex, detectLanguage } from "./chunk";
import {
  getDefaultBranch,
  getBranchSha,
  getTree,
  getFileContent,
  fileUrl,
} from "./github";

const MAX_FILES = 600; // safety cap for a single index pass
// Voyage's free tier is aggressively rate-limited (~3 requests/min without a
// payment method on file). We embed serially and back off on 429. A large repo
// therefore can't finish inside Convex's 600s action limit in one shot, so
// indexing is split into self-rescheduling batches (see `indexBatch`): each
// invocation embeds files until a time budget is hit, then schedules the next
// batch until the whole queue is drained.
//
// Keep this comfortably under the 600s action limit. Worst case a single file's
// retry ladder adds ~90s on top, leaving ample slack.
const BATCH_BUDGET_MS = 6 * 60 * 1000;

type RepoDoc = {
  _id: any;
  owner: string;
  name: string;
  defaultBranch?: string;
};

// One file's worth of work queued for a batch. `blobSha` is present for a full
// index (enables content-hash dedup) and omitted for incremental re-indexes.
const queueItem = v.object({ path: v.string(), blobSha: v.optional(v.string()) });

/** Full (re)index of a repository. Enumerates files, then hands off to batches. */
export const indexRepo = internalAction({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    const repo = (await ctx.runQuery(internal.repos.getRepoInternal, {
      repoId,
    })) as RepoDoc | null;
    if (!repo) return;

    await ctx.runMutation(internal.repos.setStatus, {
      repoId,
      status: "indexing",
    });

    try {
      const branch = repo.defaultBranch ?? (await getDefaultBranch(repo.owner, repo.name));
      const sha = await getBranchSha(repo.owner, repo.name, branch);

      const tree = await getTree(repo.owner, repo.name, sha);
      const targets = tree
        .filter((e) => shouldIndex(e.path, e.size))
        .slice(0, MAX_FILES);

      // Fresh index: clear the previous repo map (RAG entries are replaced by key).
      await ctx.runMutation(internal.repos.clearRepo, { repoId });
      await ctx.runMutation(internal.repos.setProgress, {
        repoId,
        filesProcessed: 0,
        filesTotal: targets.length,
      });

      await ctx.scheduler.runAfter(0, internal.ingest.indexBatch, {
        repoId,
        sha,
        branch,
        mode: "full",
        queue: targets.map((e) => ({ path: e.path, blobSha: e.sha })),
        totalFiles: targets.length,
        chunkTotal: 0,
      });
    } catch (err: any) {
      await ctx.runMutation(internal.repos.setStatus, {
        repoId,
        status: "error",
        lastError: String(err?.message ?? err),
      });
    }
  },
});

/** Incremental re-index triggered by a GitHub push webhook. */
export const reindexChangedPaths = internalAction({
  args: {
    repoId: v.id("repos"),
    sha: v.string(),
    added: v.array(v.string()),
    modified: v.array(v.string()),
    removed: v.array(v.string()),
  },
  handler: async (ctx, { repoId, sha, added, modified, removed }) => {
    const repo = (await ctx.runQuery(internal.repos.getRepoInternal, {
      repoId,
    })) as RepoDoc | null;
    if (!repo) return;

    // Deletions
    const ns = await rag.getNamespace(ctx, { namespace: repoId });
    for (const path of removed) {
      if (ns) {
        try {
          await rag.deleteByKey(ctx, { namespaceId: ns.namespaceId, key: path });
        } catch {
          /* entry may not exist */
        }
      }
      await ctx.runMutation(internal.repos.removeFile, { repoId, path });
    }

    // Upserts — hand off to the same batched pipeline so a large push can't
    // blow the action time limit.
    const changed = [...new Set([...added, ...modified])].filter((p) =>
      shouldIndex(p),
    );
    await ctx.runMutation(internal.repos.setProgress, {
      repoId,
      filesProcessed: 0,
      filesTotal: changed.length,
    });
    await ctx.scheduler.runAfter(0, internal.ingest.indexBatch, {
      repoId,
      sha,
      mode: "incremental",
      queue: changed.map((path) => ({ path })),
      totalFiles: changed.length,
      chunkTotal: 0,
    });
  },
});

/**
 * Embed one time-bounded batch of the queue, then schedule the next batch (or
 * finish). Splitting the work this way keeps every invocation well under the
 * 600s action limit, so a rate-limited index always completes instead of being
 * killed mid-pass and leaving the repo stuck on "indexing".
 */
export const indexBatch = internalAction({
  args: {
    repoId: v.id("repos"),
    sha: v.string(),
    branch: v.optional(v.string()),
    mode: v.string(), // full | incremental
    queue: v.array(queueItem),
    totalFiles: v.number(),
    chunkTotal: v.number(),
  },
  handler: async (ctx, args) => {
    const { repoId, sha, branch, mode, queue, totalFiles } = args;
    const repo = (await ctx.runQuery(internal.repos.getRepoInternal, {
      repoId,
    })) as RepoDoc | null;
    if (!repo) return;

    try {
      const deadline = Date.now() + BATCH_BUDGET_MS;
      let chunkTotal = args.chunkTotal;
      let i = 0;
      while (i < queue.length && Date.now() < deadline) {
        const item = queue[i];
        chunkTotal += await indexOneFile(
          ctx,
          repo,
          repoId,
          sha,
          item.path,
          item.blobSha,
        );
        i++;
      }

      const rest = queue.slice(i);
      await ctx.runMutation(internal.repos.setProgress, {
        repoId,
        filesProcessed: totalFiles - rest.length,
        filesTotal: totalFiles,
      });

      if (rest.length > 0) {
        await ctx.scheduler.runAfter(0, internal.ingest.indexBatch, {
          ...args,
          queue: rest,
          chunkTotal,
        });
        return;
      }

      if (mode === "full") {
        await ctx.runMutation(internal.repos.finishIndex, {
          repoId,
          sha,
          fileCount: totalFiles,
          chunkCount: chunkTotal,
          indexedAt: Date.now(),
          defaultBranch: branch,
        });
      } else {
        await ctx.runMutation(internal.repos.finishIndexIncremental, {
          repoId,
          sha,
          indexedAt: Date.now(),
        });
      }
    } catch (err: any) {
      await ctx.runMutation(internal.repos.setStatus, {
        repoId,
        status: "error",
        lastError: String(err?.message ?? err),
      });
    }
  },
});

// --- helpers ---------------------------------------------------------------

async function indexOneFile(
  ctx: any,
  repo: RepoDoc,
  repoId: string,
  sha: string,
  path: string,
  blobSha?: string,
): Promise<number> {
  const content = await getFileContent(repo.owner, repo.name, sha, path);
  if (content === null || content.length === 0) return 0;

  const language = detectLanguage(path);
  const chunks = chunkFile(path, content);
  const symbols = extractSymbols(path, content);
  if (chunks.length === 0) return 0;

  await withRetry(() =>
    rag.add(ctx, {
      namespace: repoId,
      key: path,
      title: path,
      metadata: { path, url: fileUrl(repo.owner, repo.name, sha, path) },
      // Dedup: unchanged content (same hash) won't be re-embedded.
      contentHash: blobSha,
      chunks: chunks.map((c) => ({
        text: c.text,
        metadata: {
          path,
          startLine: c.startLine,
          endLine: c.endLine,
          symbol: c.symbol ?? "",
          language: c.language,
        },
        keywords: c.symbol ? `${path} ${c.symbol}` : path,
      })),
    }),
  );

  await ctx.runMutation(internal.repos.upsertFile, {
    repoId,
    path,
    language,
    blobSha: blobSha ?? sha,
    size: content.length,
    symbols,
  });

  return chunks.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a rate-limited embedding call with exponential backoff. Voyage returns
 * 429 ("Too Many Requests") when the free-tier limit is exceeded; waiting and
 * retrying lets a full index pass finish instead of aborting the whole repo.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const rateLimited = /Too Many Requests|429|rate.?limit/i.test(msg);
      if (!rateLimited || i === attempts - 1) throw err;
      lastErr = err;
      await sleep(Math.min(30_000, 3_000 * 2 ** i)); // 3s,6s,12s,24s,30s…
    }
  }
  throw lastErr;
}
