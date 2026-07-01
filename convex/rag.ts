import { RAG } from "@convex-dev/rag";
import { components } from "./_generated/api";
import { getEmbeddingModel, EMBEDDING_DIMENSION } from "./embeddings";

/**
 * Shared RAG instance. Each repo gets its own namespace (= repoId) so searches
 * never cross repositories.
 *
 * Per-chunk metadata we store:
 *   { path, startLine, endLine, symbol, language }
 * Per-entry (one entry per file, key = path) metadata:
 *   { path, url }
 */
export type ChunkMetadata = {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  language: string;
};

export const rag = new RAG(components.rag, {
  textEmbeddingModel: getEmbeddingModel(),
  embeddingDimension: EMBEDDING_DIMENSION,
});
