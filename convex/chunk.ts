/**
 * Structure-aware code chunking (no native deps, runs anywhere).
 *
 * Strategy (cAST-inspired): split a file at top-level declaration boundaries
 * (functions / classes / types) so each chunk stays syntactically coherent,
 * then pack adjacent declarations up to a token budget. Oversized single
 * declarations fall back to a line sliding-window. Retrieval-time neighbor
 * context is handled by the RAG component's `chunkContext`, so we don't
 * duplicate overlap into the stored text.
 *
 * This is deliberately a self-contained heuristic. A tree-sitter (web-tree-sitter
 * WASM) implementation can replace `splitRegions`/`extractSymbols` later without
 * touching the ingestion pipeline.
 */

export type Chunk = {
  text: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number;
  symbol?: string;
  language: string;
};

export type SymbolInfo = {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
};

const MAX_CHUNK_CHARS = 6000; // ~1500 tokens
const WINDOW_LINES = 180; // sliding window for oversized regions
const WINDOW_OVERLAP = 20;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", sql: "sql",
  vue: "vue", svelte: "svelte",
  md: "markdown", mdx: "markdown",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "shell", bash: "shell",
  css: "css", scss: "css", html: "html",
};

const EXCLUDE_DIR = [
  "node_modules/", "dist/", "build/", ".next/", "out/", "vendor/",
  ".git/", "coverage/", "__pycache__/", ".venv/", "venv/", "target/",
  ".turbo/", ".cache/", "public/assets/",
];

const EXCLUDE_FILE = [
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "poetry.lock", "cargo.lock", "composer.lock",
];

const MAX_FILE_BYTES = 400_000;

export function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "text";
}

/** Whether a repo path is worth indexing (source/docs, not binaries/vendored). */
export function shouldIndex(path: string, size?: number): boolean {
  const lower = path.toLowerCase();
  if (EXCLUDE_DIR.some((d) => lower.includes(d))) return false;
  if (EXCLUDE_FILE.some((f) => lower.endsWith(f))) return false;
  if (size !== undefined && size > MAX_FILE_BYTES) return false;
  const ext = lower.split(".").pop() ?? "";
  return ext in LANGUAGE_BY_EXT;
}

// --- Declaration detection -------------------------------------------------

type Region = { start: number; end: number; symbol?: string; kind?: string };

const BRACE_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|async\s+)*(function|class|interface|type|enum|struct|trait|impl|namespace|module|func)\b[\s*]*([A-Za-z0-9_$]+)?/;
const ARROW_CONST =
  /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/;
const PY_DECL = /^(async\s+)?(def|class)\s+([A-Za-z0-9_]+)/;

function detectDecl(
  line: string,
  indentSensitive: boolean,
): { name?: string; kind: string } | null {
  if (indentSensitive) {
    // Only column-0 declarations count as top-level (Python-like).
    if (/^\S/.test(line)) {
      const m = PY_DECL.exec(line);
      if (m) return { name: m[3], kind: m[2] };
    }
    return null;
  }
  const b = BRACE_DECL.exec(line);
  if (b) return { name: b[2], kind: b[1] };
  const a = ARROW_CONST.exec(line);
  if (a) return { name: a[1], kind: "const" };
  return null;
}

/**
 * Split file into regions anchored at top-level declarations. Everything before
 * the first declaration (imports, license header) becomes a leading region.
 */
function splitRegions(lines: string[], language: string): Region[] {
  const indentSensitive = language === "python" || language === "ruby";
  const anchors: { line: number; name?: string; kind: string }[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const atTop = indentSensitive ? true : depth === 0;
    if (atTop) {
      const d = detectDecl(raw, indentSensitive);
      if (d) anchors.push({ line: i, name: d.name, kind: d.kind });
    }
    if (!indentSensitive) depth += braceDelta(raw);
    if (depth < 0) depth = 0;
  }

  if (anchors.length === 0) {
    return [{ start: 0, end: lines.length - 1 }];
  }

  const regions: Region[] = [];
  if (anchors[0].line > 0) {
    regions.push({ start: 0, end: anchors[0].line - 1 });
  }
  for (let a = 0; a < anchors.length; a++) {
    const start = anchors[a].line;
    const end = a + 1 < anchors.length ? anchors[a + 1].line - 1 : lines.length - 1;
    regions.push({ start, end, symbol: anchors[a].name, kind: anchors[a].kind });
  }
  return regions;
}

/** Naive brace balance, ignoring // line comments. Good enough for chunk anchoring. */
function braceDelta(line: string): number {
  const code = line.replace(/\/\/.*$/, "");
  let d = 0;
  for (const ch of code) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

// --- Public API ------------------------------------------------------------

export function extractSymbols(path: string, content: string): SymbolInfo[] {
  const language = detectLanguage(path);
  const lines = content.split("\n");
  const regions = splitRegions(lines, language);
  return regions
    .filter((r) => r.symbol)
    .map((r) => ({
      name: r.symbol!,
      kind: r.kind ?? "symbol",
      startLine: r.start + 1,
      endLine: r.end + 1,
    }));
}

export function chunkFile(path: string, content: string): Chunk[] {
  const language = detectLanguage(path);
  const lines = content.split("\n");
  const regions = splitRegions(lines, language);
  const chunks: Chunk[] = [];

  let buf: Region[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const start = buf[0].start;
    const end = buf[buf.length - 1].end;
    const symbol = buf.find((r) => r.symbol)?.symbol;
    chunks.push({
      text: lines.slice(start, end + 1).join("\n"),
      startLine: start + 1,
      endLine: end + 1,
      symbol,
      language,
    });
    buf = [];
    bufChars = 0;
  };

  for (const region of regions) {
    const regionChars = regionLength(lines, region);
    if (regionChars > MAX_CHUNK_CHARS) {
      // Oversized single declaration → sliding window.
      flush();
      for (const w of windowRegion(lines, region, language)) chunks.push(w);
      continue;
    }
    if (bufChars + regionChars > MAX_CHUNK_CHARS) flush();
    buf.push(region);
    bufChars += regionChars;
  }
  flush();

  return chunks.filter((c) => c.text.trim().length > 0);
}

function regionLength(lines: string[], r: Region): number {
  let n = 0;
  for (let i = r.start; i <= r.end; i++) n += lines[i].length + 1;
  return n;
}

function windowRegion(lines: string[], r: Region, language: string): Chunk[] {
  const out: Chunk[] = [];
  for (let s = r.start; s <= r.end; s += WINDOW_LINES - WINDOW_OVERLAP) {
    const e = Math.min(s + WINDOW_LINES - 1, r.end);
    out.push({
      text: lines.slice(s, e + 1).join("\n"),
      startLine: s + 1,
      endLine: e + 1,
      symbol: s === r.start ? r.symbol : undefined,
      language,
    });
    if (e >= r.end) break;
  }
  return out;
}
