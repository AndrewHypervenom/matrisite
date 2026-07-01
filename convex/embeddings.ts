import { createVoyage } from "voyage-ai-provider";

/**
 * Embeddings layer — intentionally swappable.
 *
 * Default: Voyage `voyage-code-3` (free tier ~200M tokens, best-in-class for
 * code retrieval). To swap to another provider, change `getEmbeddingModel`
 * and update `EMBEDDING_DIMENSION` to match the new model's output size.
 *
 * A 100% local / no-quota alternative is Transformers.js (`@xenova/transformers`)
 * wrapped as a custom EmbeddingModelV2 — left as a documented extension point
 * so the default install stays lean.
 */

// voyage-code-3 default output dimension.
export const EMBEDDING_DIMENSION = 1024;

export function getEmbeddingModel() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it in the Convex dashboard " +
        "(Settings → Environment Variables) to enable code embeddings.",
    );
  }
  const voyage = createVoyage({ apiKey });
  const modelId = process.env.EMBEDDING_MODEL ?? "voyage-code-3";
  return voyage.textEmbeddingModel(modelId);
}
