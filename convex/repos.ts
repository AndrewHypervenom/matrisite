import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

// --- Public API (frontend) -------------------------------------------------

export const listRepos = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("repos").order("desc").collect();
  },
});

export const getRepo = query({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    return await ctx.db.get(repoId);
  },
});

export const addRepo = mutation({
  args: { owner: v.string(), name: v.string() },
  handler: async (ctx, { owner, name }) => {
    const existing = await ctx.db
      .query("repos")
      .withIndex("by_owner_name", (q) => q.eq("owner", owner).eq("name", name))
      .unique();
    const repoId =
      existing?._id ??
      (await ctx.db.insert("repos", { owner, name, status: "idle" }));
    await ctx.scheduler.runAfter(0, internal.ingest.indexRepo, { repoId });
    return repoId;
  },
});

export const reindexRepo = mutation({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    await ctx.scheduler.runAfter(0, internal.ingest.indexRepo, { repoId });
  },
});

// --- Tool-supporting queries (used by the chat agent) ----------------------

export const getFileTree = query({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    const files = await ctx.db
      .query("files")
      .withIndex("by_repo", (q) => q.eq("repoId", repoId))
      .collect();
    return files
      .map((f) => ({ path: f.path, language: f.language, symbolCount: f.symbolCount }))
      .sort((a, b) => a.path.localeCompare(b.path));
  },
});

export const findSymbol = query({
  args: { repoId: v.id("repos"), name: v.string() },
  handler: async (ctx, { repoId, name }) => {
    const results = await ctx.db
      .query("symbols")
      .withSearchIndex("search_name", (q) =>
        q.search("name", name).eq("repoId", repoId),
      )
      .take(15);
    return results.map((s) => ({
      name: s.name,
      kind: s.kind,
      path: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
    }));
  },
});

// --- Internal mutations (ingestion) ----------------------------------------

export const getRepoInternal = internalQuery({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => ctx.db.get(repoId),
});

/**
 * Bump the index generation and return the new value. Called when a full/
 * incremental index begins and again whenever the watchdog resumes a stalled
 * one. A batch whose carried epoch is below the repo's current epoch belongs to
 * a superseded chain and must abort, which is how recoveries avoid duplicating
 * a still-alive (about-to-be-killed) batch.
 */
export const bumpIndexEpoch = internalMutation({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    const repo = await ctx.db.get(repoId);
    const epoch = ((repo?.indexEpoch ?? 0) as number) + 1;
    await ctx.db.patch(repoId, { indexEpoch: epoch });
    return epoch;
  },
});

/** Paths already written to the repo map — i.e. files finished this run (the
 * table is cleared at the start of every full index). Used by the watchdog to
 * skip completed files when resuming. */
export const indexedPaths = internalQuery({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_repo", (q) => q.eq("repoId", repoId))
      .collect();
    return rows.map((r) => r.path);
  },
});

export const findRepo = internalQuery({
  args: { owner: v.string(), name: v.string() },
  handler: async (ctx, { owner, name }) => {
    return await ctx.db
      .query("repos")
      .withIndex("by_owner_name", (q) => q.eq("owner", owner).eq("name", name))
      .unique();
  },
});

export const setStatus = internalMutation({
  args: {
    repoId: v.id("repos"),
    status: v.string(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { repoId, status, lastError }) => {
    await ctx.db.patch(repoId, { status, lastError });
  },
});

/** Update the live file-processing progress shown while indexing. */
export const setProgress = internalMutation({
  args: {
    repoId: v.id("repos"),
    filesProcessed: v.number(),
    filesTotal: v.number(),
  },
  handler: async (ctx, { repoId, filesProcessed, filesTotal }) => {
    await ctx.db.patch(repoId, { filesProcessed, filesTotal });
  },
});

/** Delete all files + symbols for a repo (start of a full re-index). */
export const clearRepo = internalMutation({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    for (const table of ["files", "symbols"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_repo", (q) => q.eq("repoId", repoId))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
  },
});

/** Replace a single file's map + symbols (incremental re-index). */
export const upsertFile = internalMutation({
  args: {
    repoId: v.id("repos"),
    path: v.string(),
    language: v.string(),
    blobSha: v.string(),
    size: v.number(),
    symbols: v.array(
      v.object({
        name: v.string(),
        kind: v.string(),
        startLine: v.number(),
        endLine: v.number(),
      }),
    ),
  },
  handler: async (ctx, { repoId, path, language, blobSha, size, symbols }) => {
    await removeFileRows(ctx, repoId, path);
    await ctx.db.insert("files", {
      repoId,
      path,
      language,
      blobSha,
      size,
      symbolCount: symbols.length,
    });
    for (const s of symbols) {
      await ctx.db.insert("symbols", { repoId, filePath: path, ...s });
    }
  },
});

export const removeFile = internalMutation({
  args: { repoId: v.id("repos"), path: v.string() },
  handler: async (ctx, { repoId, path }) => {
    await removeFileRows(ctx, repoId, path);
  },
});

export const finishIndex = internalMutation({
  args: {
    repoId: v.id("repos"),
    sha: v.string(),
    fileCount: v.number(),
    chunkCount: v.number(),
    indexedAt: v.number(),
    defaultBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoId, {
      status: "ready",
      lastIndexedSha: args.sha,
      fileCount: args.fileCount,
      chunkCount: args.chunkCount,
      indexedAt: args.indexedAt,
      defaultBranch: args.defaultBranch,
      lastError: undefined,
    });
  },
});

export const finishIndexIncremental = internalMutation({
  args: {
    repoId: v.id("repos"),
    sha: v.string(),
    indexedAt: v.number(),
  },
  handler: async (ctx, { repoId, sha, indexedAt }) => {
    const files = await ctx.db
      .query("files")
      .withIndex("by_repo", (q) => q.eq("repoId", repoId))
      .collect();
    await ctx.db.patch(repoId, {
      status: "ready",
      lastIndexedSha: sha,
      indexedAt,
      fileCount: files.length,
      lastError: undefined,
    });
  },
});

// Helper shared by upsert/remove. Not a Convex function.
async function removeFileRows(
  ctx: { db: any },
  repoId: string,
  path: string,
) {
  const file = await ctx.db
    .query("files")
    .withIndex("by_repo_path", (q: any) => q.eq("repoId", repoId).eq("path", path))
    .unique();
  if (file) await ctx.db.delete(file._id);
  const syms = await ctx.db
    .query("symbols")
    .withIndex("by_repo_file", (q: any) =>
      q.eq("repoId", repoId).eq("filePath", path),
    )
    .collect();
  for (const s of syms) await ctx.db.delete(s._id);
}
