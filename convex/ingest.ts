import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { rag } from "./rag";
import { isRateLimit } from "./embeddings";
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
// payment method on file). Pacing and 429 backoff live in the embedding model's
// governor (see `embeddings.ts`); a large repo still can't finish inside
// Convex's 600s action limit in one shot, so indexing is split into
// self-rescheduling batches (see `indexBatch`): each invocation embeds files
// until a time budget is hit, then schedules the next batch until the queue is
// drained.
//
// Kept well under the 600s action limit: the loop only checks this deadline
// *before* starting a file, so one file that then hits the governor's full
// retry ladder (~160s worst case) still has to fit. 4min budget + ~160s + I/O
// slack ≈ 420s, leaving comfortable headroom so Convex never kills the action
// mid-batch (which would strand the repo in "indexing" forever).
const BATCH_BUDGET_MS = 4 * 60 * 1000;
// When a batch is throttled, wait out (roughly) a free-tier reset window before
// retrying the remaining files, rather than hammering the limit immediately.
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
// Give up only after this many *consecutive* batches make zero progress while
// rate-limited — a genuinely exhausted quota, not a transient blip. Any file
// that succeeds resets the counter.
const MAX_STALLED_BATCHES = 6;

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
    // Count of consecutive prior batches that made zero progress due to rate
    // limiting. Absent on the first batch.
    stalls: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { repoId, sha, branch, mode, queue, totalFiles } = args;
    const repo = (await ctx.runQuery(internal.repos.getRepoInternal, {
      repoId,
    })) as RepoDoc | null;
    if (!repo) return;

    try {
      const deadline = Date.now() + BATCH_BUDGET_MS;
      const done0 = totalFiles - queue.length; // files already indexed before this batch
      let chunkTotal = args.chunkTotal;
      let i = 0;
      let rateLimited = false;
      while (i < queue.length && Date.now() < deadline) {
        const item = queue[i];
        try {
          chunkTotal += await indexOneFile(
            ctx,
            repo,
            repoId,
            sha,
            item.path,
            item.blobSha,
          );
        } catch (err) {
          // Rate limit: stop here without advancing past this file, and let the
          // batch reschedule after a cooldown so the whole repo isn't abandoned
          // in an "error" state over a transient throttle. Any other error is a
          // real fault and should surface.
          if (isRateLimit(err)) {
            rateLimited = true;
            break;
          }
          throw err;
        }
        i++;
        // Live progress: update after each file so the UI bar actually moves
        // instead of jumping only at batch boundaries.
        await ctx.runMutation(internal.repos.setProgress, {
          repoId,
          filesProcessed: done0 + i,
          filesTotal: totalFiles,
        });
      }

      const rest = queue.slice(i);
      await ctx.runMutation(internal.repos.setProgress, {
        repoId,
        filesProcessed: totalFiles - rest.length,
        filesTotal: totalFiles,
      });

      if (rest.length > 0) {
        // Track stalls only when a rate limit blocked *all* progress this batch;
        // any indexed file means we're still making headway, so reset.
        const madeProgress = i > 0;
        const stalls = rateLimited && !madeProgress ? (args.stalls ?? 0) + 1 : 0;
        if (stalls >= MAX_STALLED_BATCHES) {
          await ctx.runMutation(internal.repos.setStatus, {
            repoId,
            status: "error",
            lastError:
              "El proveedor de embeddings (Voyage) sigue limitando por rate " +
              "tras varios reintentos. Espera unos minutos y vuelve a " +
              "re-indexar, o añade un método de pago en Voyage para subir el " +
              "límite del tier gratuito.",
          });
          return;
        }
        await ctx.scheduler.runAfter(
          rateLimited ? RATE_LIMIT_COOLDOWN_MS : 0,
          internal.ingest.indexBatch,
          { ...args, queue: rest, chunkTotal, stalls },
        );
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

  // Pacing and 429 backoff are handled by the embedding model's governor
  // (see `embeddings.ts`), so this call stays a plain add.
  await rag.add(ctx, {
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
  });

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
