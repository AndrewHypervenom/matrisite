import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * GitHub push webhook → incremental re-index.
 * Configure on GitHub: Settings → Webhooks → Payload URL:
 *   https://<your-deployment>.convex.site/github/webhook
 * Content type: application/json, Secret: GITHUB_WEBHOOK_SECRET, event: push.
 */
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");

    if (secret) {
      const ok = await verifySignature(secret, body, signature);
      if (!ok) return new Response("invalid signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    if (event !== "push") {
      return new Response("ignored", { status: 200 });
    }

    const payload = JSON.parse(body) as PushPayload;
    const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name;
    const name = payload.repository?.name;
    const sha = payload.after ?? payload.head_commit?.id;
    if (!owner || !name || !sha) {
      return new Response("missing repo/sha", { status: 400 });
    }

    const repo = await ctx.runQuery(internal.repos.findRepo, { owner, name });
    if (!repo) {
      // Not a repo we track — acknowledge so GitHub doesn't retry.
      return new Response("untracked repo", { status: 202 });
    }

    const added = new Set<string>();
    const modified = new Set<string>();
    const removed = new Set<string>();
    for (const c of payload.commits ?? []) {
      c.added?.forEach((p) => added.add(p));
      c.modified?.forEach((p) => modified.add(p));
      c.removed?.forEach((p) => removed.add(p));
    }
    // A path removed then re-added in the same push is a modification.
    for (const p of added) removed.delete(p);

    await ctx.runMutation(internal.repos.setStatus, {
      repoId: repo._id,
      status: "indexing",
    });
    await ctx.scheduler.runAfter(0, internal.ingest.reindexChangedPaths, {
      repoId: repo._id,
      sha,
      added: [...added],
      modified: [...modified],
      removed: [...removed],
    });

    return new Response("ok", { status: 200 });
  }),
});

export default http;

// --- helpers ---------------------------------------------------------------

type PushCommit = {
  added?: string[];
  modified?: string[];
  removed?: string[];
};
type PushPayload = {
  after?: string;
  head_commit?: { id: string };
  repository?: { name: string; owner?: { login?: string; name?: string } };
  commits?: PushCommit[];
};

async function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${hex}`;
  // Constant-time-ish comparison.
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}
