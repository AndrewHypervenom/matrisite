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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for any error that looks like a provider rate-limit / quota rejection. */
export function isRateLimit(err: unknown): boolean {
  const anyErr = err as any;
  const msg = String(anyErr?.message ?? err);
  return (
    /Too Many Requests|429|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg) ||
    anyErr?.statusCode === 429
  );
}

/**
 * Voyage's free tier (no payment method) allows only ~3 requests/min. Two things
 * make that limit lethal if left to the defaults:
 *
 *  1. The `ai` SDK's `embedMany` retries a 429 **itself** (3 quick attempts in
 *     ~6s by default). Three requests fired inside one minute-window instantly
 *     saturate the bucket, and because that burst repeats on every outer retry
 *     the per-minute limit never gets a chance to drain — the index then fails
 *     outright with "Failed after 3 attempts. Last error: Too Many Requests".
 *  2. Firing embeddings back-to-back with no spacing trips the limit on file 2.
 *
 * So we wrap the model with a single governor around `doEmbed` that (a) paces
 * calls to at most one per `EMBED_MIN_INTERVAL_MS`, and (b) backs off and
 * retries on 429 with minute-long waits (the free-tier bucket resets per
 * minute, so shorter waits keep colliding). Because the governor resolves the
 * 429 before returning, `embedMany` sees success and never fires its own burst.
 * On final give-up it throws a plain (non-retryable) error so the SDK doesn't
 * add two more wasted retry cycles on top.
 *
 * State is module-level and resets each Convex action invocation, which is
 * exactly the scope we want: pacing only needs to hold within a single batch.
 * Set `EMBED_MIN_INTERVAL_MS=0` once a Voyage payment method lifts the cap.
 */
const EMBED_MIN_INTERVAL_MS = Number(
  process.env.EMBED_MIN_INTERVAL_MS ?? 25_000,
);
// Kept modest so a single stuck file's retry ladder (5+10+20+40+60 ≈ 135s) fits
// comfortably inside a batch's remaining time under Convex's 600s action limit.
const EMBED_MAX_RETRIES = Number(process.env.EMBED_MAX_RETRIES ?? 6);

let lastEmbedAt = 0;

function withRateLimitGovernor<M extends object>(model: M): M {
  const doEmbed = (model as any).doEmbed.bind(model);

  const governed = async (options: any) => {
    let lastErr: unknown;
    for (let i = 0; i < EMBED_MAX_RETRIES; i++) {
      if (EMBED_MIN_INTERVAL_MS > 0) {
        const wait = lastEmbedAt + EMBED_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
      try {
        const res = await doEmbed(options);
        lastEmbedAt = Date.now();
        return res;
      } catch (err) {
        lastEmbedAt = Date.now();
        if (!isRateLimit(err) || i === EMBED_MAX_RETRIES - 1) throw err;
        lastErr = err;
        // 5s,10s,20s,40s,60s… plus jitter to desync retries.
        const backoff = Math.min(60_000, 5_000 * 2 ** i);
        await sleep(backoff + Math.random() * 1_000);
      }
    }
    // Exhausted retries on a rate limit: surface a plain error so `embedMany`
    // treats it as non-retryable (no extra SDK burst). The message stays
    // matchable by isRateLimit so callers can reschedule instead of hard-fail.
    throw new Error(
      `Rate limited by the embeddings provider after ${EMBED_MAX_RETRIES} attempts: ${String(
        (lastErr as any)?.message ?? lastErr,
      )}`,
    );
  };

  // Delegate every other property to the underlying model so we stay forward-
  // compatible with the provider's exact EmbeddingModel interface.
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "doEmbed") return governed;
      return Reflect.get(target, prop, receiver);
    },
  });
}

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
  return withRateLimitGovernor(voyage.textEmbeddingModel(modelId));
}
