import { v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { rag } from "./rag";
import { getModel, type ChatMode } from "./llm";
import { getFileContent, fileUrl } from "./github";

const HISTORY_LIMIT = 12;

type Citation = {
  path: string;
  startLine?: number;
  endLine?: number;
  url: string;
  score?: number;
};

// --- Public API (frontend) -------------------------------------------------

export const listConversations = query({
  args: { repoId: v.id("repos") },
  handler: async (ctx, { repoId }) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_repo", (q) => q.eq("repoId", repoId))
      .order("desc")
      .collect();
  },
});

export const listMessages = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect();
  },
});

export const sendMessage = mutation({
  args: {
    repoId: v.id("repos"),
    conversationId: v.optional(v.id("conversations")),
    mode: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { repoId, conversationId, mode, text }) => {
    const now = Date.now();
    let convId = conversationId;
    if (!convId) {
      convId = await ctx.db.insert("conversations", {
        repoId,
        mode,
        title: text.slice(0, 60),
        createdAt: now,
      });
    }
    await ctx.db.insert("messages", {
      conversationId: convId,
      role: "user",
      content: text,
      status: "complete",
      createdAt: now,
    });
    const assistantId = await ctx.db.insert("messages", {
      conversationId: convId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: now + 1,
    });
    await ctx.scheduler.runAfter(0, internal.chat.answer, {
      repoId,
      conversationId: convId,
      assistantMessageId: assistantId,
      mode: mode as ChatMode,
    });
    return { conversationId: convId, assistantMessageId: assistantId };
  },
});

// --- Internal (agent) ------------------------------------------------------

export const getHistory = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect();
    return msgs
      .filter((m) => m.status !== "pending")
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));
  },
});

export const writeAssistant = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    status: v.string(),
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
  },
  handler: async (ctx, { messageId, content, status, citations }) => {
    await ctx.db.patch(messageId, { content, status, citations });
  },
});

export const answer = internalAction({
  args: {
    repoId: v.id("repos"),
    conversationId: v.id("conversations"),
    assistantMessageId: v.id("messages"),
    mode: v.string(),
  },
  handler: async (ctx, { repoId, conversationId, assistantMessageId, mode }) => {
    const repo = await ctx.runQuery(internal.repos.getRepoInternal, { repoId });
    if (!repo) return;
    const sha = repo.lastIndexedSha ?? repo.defaultBranch ?? "HEAD";
    const slug = `${repo.owner}/${repo.name}`;

    // Citations collected across every searchCode call this turn.
    const citations = new Map<string, Citation>();
    const recordCitation = (c: Citation) => {
      const key = `${c.path}:${c.startLine ?? 0}`;
      const prev = citations.get(key);
      if (!prev || (c.score ?? 0) > (prev.score ?? 0)) citations.set(key, c);
    };

    const tools = {
      searchCode: tool({
        description:
          "Semantic + keyword search over the indexed codebase. Use this first to find relevant files/functions before answering.",
        inputSchema: z.object({
          query: z.string().describe("Natural-language or code query"),
          limit: z.number().min(1).max(15).optional(),
        }),
        execute: async ({ query, limit }) => {
          const { results } = await rag.search(ctx, {
            namespace: repoId,
            query,
            limit: limit ?? 8,
            chunkContext: { before: 1, after: 1 },
            searchType: "hybrid",
            vectorScoreThreshold: 0.2,
          });
          const out: any[] = [];
          for (const r of results) {
            for (const chunk of r.content) {
              const m = (chunk.metadata ?? {}) as any;
              if (m.path) {
                recordCitation({
                  path: m.path,
                  startLine: m.startLine,
                  endLine: m.endLine,
                  url: fileUrl(
                    repo.owner,
                    repo.name,
                    sha,
                    m.path,
                    m.startLine,
                    m.endLine,
                  ),
                  score: r.score,
                });
              }
              out.push({
                path: m.path,
                lines: m.startLine ? `${m.startLine}-${m.endLine}` : undefined,
                symbol: m.symbol || undefined,
                score: Number(r.score.toFixed(3)),
                snippet: chunk.text.slice(0, 1200),
              });
            }
          }
          return out.slice(0, 12);
        },
      }),

      getFileTree: tool({
        description:
          "List the repository's files (path, language, number of symbols).",
        inputSchema: z.object({}),
        execute: async () => {
          const files = await ctx.runQuery(api.repos.getFileTree, { repoId });
          return files.slice(0, 500);
        },
      }),

      findSymbol: tool({
        description:
          "Look up a function/class/type by (approximate) name and get its file + line range.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          return await ctx.runQuery(api.repos.findSymbol, { repoId, name });
        },
      }),

      readFile: tool({
        description:
          "Read the exact contents of a file (optionally a line range) from the repo.",
        inputSchema: z.object({
          path: z.string(),
          startLine: z.number().optional(),
          endLine: z.number().optional(),
        }),
        execute: async ({ path, startLine, endLine }) => {
          const content = await getFileContent(repo.owner, repo.name, sha, path);
          if (content === null) return { error: "file not found", path };
          const lines = content.split("\n");
          const from = startLine ? Math.max(1, startLine) : 1;
          const to = endLine ? Math.min(lines.length, endLine) : lines.length;
          const slice = lines.slice(from - 1, to).join("\n").slice(0, 8000);
          recordCitation({
            path,
            startLine: from,
            endLine: to,
            url: fileUrl(repo.owner, repo.name, sha, path, from, to),
          });
          return { path, from, to, content: slice };
        },
      }),
    };

    const history = await ctx.runQuery(internal.chat.getHistory, {
      conversationId,
    });

    const runAgent = (model: ReturnType<typeof getModel>) =>
      generateText({
        model,
        system: systemPrompt(mode as ChatMode, slug),
        messages: history as any,
        tools,
        stopWhen: stepCountIs(10),
      });

    try {
      // Provider chain per mode. Each mode's primary provider is tried first,
      // then the other as a fallback so a quota/tool-calling failure on one
      // still yields an answer:
      //   ask  → Groq  then Gemini
      //   plan → Gemini then Groq
      // Within each provider we retry on rate-limit (429 / quota) with backoff
      // before moving on.
      const chain: ChatMode[] =
        (mode as ChatMode) === "plan" ? ["plan", "ask"] : ["ask", "plan"];

      let text: string | undefined;
      let lastErr: unknown;
      for (const providerMode of chain) {
        const model = getModel(providerMode);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            ({ text } = await runAgent(model));
            break;
          } catch (err) {
            lastErr = err;
            // Rate-limited: wait and retry the same provider before failing over.
            if (isRateLimited(err) && attempt < 2) {
              await sleep(2_000 * 2 ** attempt); // 2s, 4s
              continue;
            }
            break; // non-retryable (or retries exhausted) → next provider
          }
        }
        if (text !== undefined) break;
      }
      if (text === undefined) throw lastErr;

      const topCitations = selectRelevantCitations(
        [...citations.values()],
        text,
      );

      await ctx.runMutation(internal.chat.writeAssistant, {
        messageId: assistantMessageId,
        content: text || "(sin respuesta)",
        status: "complete",
        citations: topCitations,
      });
    } catch (err: any) {
      await ctx.runMutation(internal.chat.writeAssistant, {
        messageId: assistantMessageId,
        content: `Error al generar la respuesta: ${String(err?.message ?? err)}`,
        status: "error",
      });
    }
  },
});

/**
 * Keep only the citations the answer actually refers to.
 *
 * Every searchCode/readFile call this turn records a citation, so the raw list
 * includes files the agent merely glanced at while exploring. The system prompt
 * makes the model cite real code inline as `path:line`, so we treat the answer
 * text as the source of truth: a citation is "relevant" when its path (or file
 * name) appears in the answer. Relevant ones come first (ordered by score), and
 * we only fall back to top-scored explorational hits if the model cited nothing.
 */
function selectRelevantCitations(
  all: Citation[],
  answer: string,
): Citation[] {
  const byScore = (a: Citation, b: Citation) =>
    (b.score ?? 0) - (a.score ?? 0);

  const mentioned = (c: Citation) => {
    if (answer.includes(c.path)) return true;
    // Also match a bare file name, e.g. the model wrote `chat.ts` not the path.
    const base = c.path.split("/").pop();
    return !!base && new RegExp(`(^|[\\s\\\`(/])${escapeRegExp(base)}\\b`).test(answer);
  };

  const relevant = all.filter(mentioned).sort(byScore);
  if (relevant.length > 0) return relevant.slice(0, 8);

  // No inline citations found — the model likely answered without pointing at
  // specific files. Surface the best-scored hits so the user still gets sources.
  return all.sort(byScore).slice(0, 8);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when an LLM error is a rate-limit / quota exhaustion worth retrying. */
function isRateLimited(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /Too Many Requests|429|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(msg);
}

function systemPrompt(mode: ChatMode, slug: string): string {
  const common =
    `You are Matrisite, a codebase guide for the GitHub repository "${slug}". ` +
    `Always answer in the SAME language the user writes in. ` +
    `Ground every claim in the ACTUAL code: call searchCode (and findSymbol / readFile / getFileTree as needed) BEFORE answering. ` +
    `Never invent files, functions, or APIs. ` +
    `MANDATORY CITATIONS: whenever you mention a file, function, symbol, or behavior, cite the exact source inline as \`path:line\` (use \`path:startLine-endLine\` for a range). ` +
    `Every key file your answer relies on MUST appear at least once as an inline \`path:line\` citation using the REAL path returned by the tools — never a bare file name, a guessed path, or a paraphrase. ` +
    `Cite only files you actually opened via the tools this turn; do not cite files you merely considered. ` +
    `If the codebase doesn't contain the answer, say so honestly.`;

  if (mode === "plan") {
    return (
      common +
      ` The user will describe a change or feature they want to make. ` +
      `Produce a concrete, ordered CHANGE PLAN: for each file to modify, state the file path, WHAT to change, and WHY, ` +
      `referencing the real symbols/functions involved. Explore with the tools first (usually several searchCode + readFile calls). ` +
      `Finish with a short ordered checklist of steps. Be specific and practical.`
    );
  }
  return (
    common +
    ` Answer onboarding questions clearly and concisely for someone new to the codebase. ` +
    `Explain how things work and point to where in the code they live.`
  );
}
