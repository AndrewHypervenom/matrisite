import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Data model for Matrisite.
 *
 * The vector store + chunk embeddings live inside the @convex-dev/rag
 * component (namespace = repoId). These tables hold the structural "repo map"
 * (files + symbols) and the chat history that the app renders.
 */
export default defineSchema({
  // One row per connected GitHub repository.
  repos: defineTable({
    owner: v.string(),
    name: v.string(),
    defaultBranch: v.optional(v.string()),
    lastIndexedSha: v.optional(v.string()),
    // idle | indexing | ready | error
    status: v.string(),
    lastError: v.optional(v.string()),
    fileCount: v.optional(v.number()),
    chunkCount: v.optional(v.number()),
    indexedAt: v.optional(v.number()),
    // Live progress while status === "indexing" (drained batch by batch).
    filesProcessed: v.optional(v.number()),
    filesTotal: v.optional(v.number()),
  }).index("by_owner_name", ["owner", "name"]),

  // Flattened file tree of the latest indexed commit (the "repo map").
  files: defineTable({
    repoId: v.id("repos"),
    path: v.string(),
    language: v.string(),
    blobSha: v.string(),
    size: v.number(),
    symbolCount: v.number(),
  })
    .index("by_repo", ["repoId"])
    .index("by_repo_path", ["repoId", "path"]),

  // Exported/top-level symbols, used for exact-name (keyword) lookups.
  symbols: defineTable({
    repoId: v.id("repos"),
    filePath: v.string(),
    name: v.string(),
    kind: v.string(), // function | class | interface | type | const | method | ...
    startLine: v.number(),
    endLine: v.number(),
  })
    .index("by_repo", ["repoId"])
    .index("by_repo_file", ["repoId", "filePath"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["repoId"],
    }),

  conversations: defineTable({
    repoId: v.id("repos"),
    mode: v.string(), // ask | plan
    title: v.string(),
    createdAt: v.number(),
  }).index("by_repo", ["repoId"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.string(), // user | assistant
    content: v.string(),
    // Structured citations attached to assistant messages.
    citations: v.optional(
      v.array(
        v.object({
          path: v.string(),
          startLine: v.optional(v.number()),
          endLine: v.optional(v.number()),
          url: v.string(),
          score: v.optional(v.number()),
        }),
      ),
    ),
    status: v.string(), // pending | complete | error
    createdAt: v.number(),
  }).index("by_conversation", ["conversationId"]),
});
