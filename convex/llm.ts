import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * LLM layer — swappable, routed per chat mode.
 *
 *  - "ask"  → Groq (Llama/Qwen): ultra-low latency for short-context onboarding Q&A.
 *  - "plan" → Gemini Flash: ~1M token context + stronger multi-step reasoning,
 *             used for the "which files do I change and why" planning agent.
 *
 * Model IDs are env-overridable so you can track the latest free models without
 * code changes. To move a mode to Claude later, add an Anthropic branch here —
 * nothing else in the codebase needs to change.
 */

export type ChatMode = "ask" | "plan";

const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function getModel(mode: ChatMode) {
  if (mode === "ask") {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      const groq = createGroq({ apiKey });
      return groq(process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
    }
    // Fall back to Gemini if Groq isn't configured, so "ask" still works.
    return gemini();
  }
  return gemini();
}

function gemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it in the Convex dashboard " +
        "(Settings → Environment Variables) to enable answering.",
    );
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google(process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL);
}
