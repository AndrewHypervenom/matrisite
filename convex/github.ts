/**
 * Minimal GitHub REST client for public repositories.
 *
 * Uses a single `git/trees?recursive=1` call to list the whole tree, and
 * fetches file contents from raw.githubusercontent.com (not rate-limited by
 * the REST API). A GITHUB_TOKEN is optional but recommended (60 → 5000 req/h).
 */

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "matrisite",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export type TreeEntry = {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
};

export async function getDefaultBranch(
  owner: string,
  repo: string,
): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`GitHub repo lookup failed (${res.status}): ${owner}/${repo}`);
  }
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

/** Resolve a branch name to its head commit SHA. */
export async function getBranchSha(
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/commits/${branch}`,
    { headers: { ...headers(), Accept: "application/vnd.github.sha" } },
  );
  if (!res.ok) {
    throw new Error(`GitHub branch lookup failed (${res.status}): ${branch}`);
  }
  return (await res.text()).trim();
}

/** Full recursive tree for a commit SHA. */
export async function getTree(
  owner: string,
  repo: string,
  sha: string,
): Promise<TreeEntry[]> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    { headers: headers() },
  );
  if (!res.ok) {
    throw new Error(`GitHub tree fetch failed (${res.status}) for ${sha}`);
  }
  const data = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
  return data.tree.filter((e) => e.type === "blob");
}

/** Raw file content at a specific commit. Returns null if missing/binary. */
export async function getFileContent(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(
    `${RAW}/${owner}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (!res.ok) return null;
  return await res.text();
}

/** Build a stable blob URL to a line range on GitHub. */
export function fileUrl(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  let url = `https://github.com/${owner}/${repo}/blob/${sha}/${path}`;
  if (startLine) {
    url += `#L${startLine}`;
    if (endLine && endLine !== startLine) url += `-L${endLine}`;
  }
  return url;
}
