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
const CONCURRENCY = 8;

type RepoDoc = {
  _id: any;
  owner: string;
  name: string;
  defaultBranch?: string;
};

/** Full (re)index of a repository. */
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

      let chunkTotal = 0;
      await pool(targets, CONCURRENCY, async (entry) => {
        const added = await indexOneFile(ctx, repo, repoId, sha, entry.path, entry.sha);
        chunkTotal += added;
      });

      await ctx.runMutation(internal.repos.finishIndex, {
        repoId,
        sha,
        fileCount: targets.length,
        chunkCount: chunkTotal,
        indexedAt: Date.now(),
        defaultBranch: branch,
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

    // Upserts
    const changed = [...new Set([...added, ...modified])].filter((p) =>
      shouldIndex(p),
    );
    await pool(changed, CONCURRENCY, async (path) => {
      await indexOneFile(ctx, repo, repoId, sha, path);
    });

    await ctx.runMutation(internal.repos.finishIndexIncremental, {
      repoId,
      sha,
      indexedAt: Date.now(),
    });
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

/** Bounded-concurrency map. */
async function pool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
