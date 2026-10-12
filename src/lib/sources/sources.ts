/**
 * Linked folders ("sources"): folders the person links once in Settings,
 * read-only, searchable from every mulch. Server-only.
 *
 * Each source is indexed into the library index under `src:<id>` (one item
 * per file, its path as the id), re-indexed when files change (a recursive
 * watch, then only files whose size or time changed). Obsidian vaults are
 * plain folders of markdown; their links, tags and frontmatter go into the
 * index too, and notes open in Obsidian.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "@/lib/log";
import { resolveReadable } from "@/lib/agent/files";
import { extractFromBuffer } from "@/lib/ingest/extract";
import { chunkText } from "@/lib/search/chunk";
import { dropMulch, embedPending, knownSignatures, replaceRows, SOURCE_SCOPE, type Row } from "@/lib/search/index";
import { readSettings, type Settings } from "@/lib/settings";
import { obsidianUrl, parseNote } from "./obsidian";

export type Source = Settings["sources"][number];

export interface SourceStatus {
  state: "indexing" | "ready" | "missing" | "error";
  /** Files seen so far in the current or last pass. */
  files: number;
  /** Files read in this pass (changed or new). */
  done: number;
  /** Files left out: kinds mlch does not read, or over 20 MB. */
  skipped?: number;
  /** The folder has more than MAX_FILES readable files; only the first are indexed. */
  capped?: boolean;
  error?: string;
  at?: number;
}

const INDEXED = new Set([".md", ".markdown", ".txt", ".org", ".rst", ".tex", ".html", ".htm", ".csv", ".pdf", ".docx", ".rtf"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", ".Trash", "dist", "build", ".next"]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface State {
  status: Map<string, SourceStatus>;
  watchers: Map<string, FSWatcher>;
  running: Map<string, Promise<void>>;
  again: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Source paths as last synced, to notice changes in Settings. */
  synced?: string;
}

const globalState = globalThis as typeof globalThis & { __mlchSources?: State };
function state(): State {
  return (globalState.__mlchSources ??= { status: new Map(), watchers: new Map(), running: new Map(), again: new Set(), timers: new Map() });
}

export function scopeOf(sourceId: string): string {
  return `${SOURCE_SCOPE}${sourceId}`;
}

export function isVault(source: Pick<Source, "path">): boolean {
  return existsSync(path.join(source.path, ".obsidian"));
}

export function sourceStatus(id: string): SourceStatus | undefined {
  return state().status.get(id);
}

/* ── reading files ─────────────────────────────────────────────── */

/** Absolute path of a file in a source, or undefined if it leaves the source or is private. */
export function sourceFile(source: Source, relative: string): string | undefined {
  return resolveReadable(source.path, relative);
}

/** Every indexable file under the source, as relative paths. */
export async function listSourceFiles(source: Source, counts: { skipped: number; capped: boolean } = { skipped: 0, capped: false }): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 16 || out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) {
        counts.capped = true;
        return;
      }
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (!resolveReadable(source.path, path.relative(source.path, full))) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && INDEXED.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(full).catch(() => undefined);
        if (stat && stat.size <= MAX_FILE_BYTES) out.push({ path: path.relative(source.path, full), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
        else counts.skipped++;
      } else if (entry.isFile()) counts.skipped++;
    }
  }
  await walk(source.path, 0);
  return out;
}

/** Text of a file in a source (markdown without frontmatter keeps its links in the index rows). */
export async function readSourceText(source: Source, relative: string): Promise<string | undefined> {
  const file = sourceFile(source, relative);
  if (!file) return undefined;
  try {
    return await extractFromBuffer(await fs.readFile(file), file);
  } catch {
    return undefined;
  }
}

function isMarkdown(file: string): boolean {
  return /\.(md|markdown)$/i.test(file);
}

/** Index rows for one file: a head row (name, frontmatter title, tags, links, opening) and passages. */
export function rowsForFile(relative: string, text: string): Row[] {
  const name = path.basename(relative).replace(/\.[^.]+$/, "");
  let body = text;
  let head = "";
  let title = name;
  if (isMarkdown(relative)) {
    const note = parseNote(text);
    body = note.body;
    if (note.title && note.title !== name) title = `${note.title} (${name})`;
    head = [note.tags.length ? `Tags: ${note.tags.map((t) => `#${t}`).join(" ")}` : "", note.links.length ? `Links: ${note.links.map((l) => `[[${l}]]`).join(" ")}` : ""].filter(Boolean).join("\n");
  }
  const rows: Row[] = [{ kind: "file", source: "item", title, text: [relative, head, body.slice(0, 1500)].filter(Boolean).join("\n").slice(0, 4000) }];
  if (body.length > 1500) for (const passage of chunkText(body)) rows.push({ kind: "file", source: "full", title, page: passage.page, offset: passage.offset, text: passage.text });
  return rows;
}

/* ── indexing ──────────────────────────────────────────────────── */

async function runIndex(source: Source): Promise<void> {
  const s = state();
  const scope = scopeOf(source.id);
  if (!existsSync(source.path)) {
    s.status.set(source.id, { state: "missing", files: 0, done: 0, at: Date.now() });
    return;
  }
  const status: SourceStatus = { state: "indexing", files: 0, done: 0 };
  s.status.set(source.id, status);
  try {
    const counts = { skipped: 0, capped: false };
    const files = await listSourceFiles(source, counts);
    status.skipped = counts.skipped;
    status.capped = counts.capped;
    status.files = files.length;
    const known = knownSignatures(scope);
    const present = new Set<string>();
    for (const file of files) {
      present.add(file.path);
      const sig = `${file.size}:${file.mtimeMs}`;
      if (known.get(file.path) === sig) continue;
      const text = await readSourceText(source, file.path);
      replaceRows(scope, file.path, text?.trim() ? rowsForFile(file.path, text) : [], sig);
      status.done++;
      // Let other requests in during a long first pass.
      if (status.done % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (const gone of known.keys()) if (!present.has(gone)) replaceRows(scope, gone, [], undefined);
    Object.assign(status, { state: "ready", at: Date.now() });
    if (status.done) log.info("sources", "Indexed linked folder", { sourceId: source.id, files: files.length, changed: status.done });
    void embedPending();
  } catch (error) {
    Object.assign(status, { state: "error", error: error instanceof Error ? error.message : String(error), at: Date.now() });
    log.error("sources", "Indexing a linked folder failed", { sourceId: source.id, error });
  }
}

/** Bring a source's index up to date; one pass at a time per source, a request during a pass queues one more. */
export function indexSource(source: Source): Promise<void> {
  const s = state();
  const running = s.running.get(source.id);
  if (running) {
    s.again.add(source.id);
    return running;
  }
  const pass = (async () => {
    do {
      s.again.delete(source.id);
      await runIndex(source);
    } while (s.again.has(source.id));
  })().finally(() => s.running.delete(source.id));
  s.running.set(source.id, pass);
  return pass;
}

function startWatching(source: Source): void {
  const s = state();
  if (s.watchers.has(source.id) || !existsSync(source.path)) return;
  try {
    const watcher = watch(source.path, { recursive: true }, (_event, file) => {
      if (file && (String(file).split(path.sep).some((part) => part.startsWith(".")) || !INDEXED.has(path.extname(String(file)).toLowerCase()))) return;
      clearTimeout(s.timers.get(source.id));
      s.timers.set(source.id, setTimeout(() => void indexSource(source), 2000));
    });
    watcher.on("error", (error) => log.warn("sources", "Watching a linked folder stopped", { sourceId: source.id, error }));
    s.watchers.set(source.id, watcher);
  } catch (error) {
    log.warn("sources", "Cannot watch a linked folder", { sourceId: source.id, error });
  }
}

function stop(id: string): void {
  const s = state();
  s.watchers.get(id)?.close();
  s.watchers.delete(id);
  clearTimeout(s.timers.get(id));
  s.status.delete(id);
}

/**
 * Match the index and the watchers to the sources in Settings: new ones are
 * indexed and watched, removed ones dropped. Cheap when nothing changed.
 */
export async function syncSources(settings?: Settings): Promise<Source[]> {
  const sources = (settings ?? (await readSettings())).sources;
  const s = state();
  const key = JSON.stringify(sources.map((source) => [source.id, source.path]));
  if (s.synced === key) return sources;
  s.synced = key;
  const ids = new Set(sources.map((source) => source.id));
  for (const id of [...s.watchers.keys(), ...s.status.keys()]) {
    if (ids.has(id)) continue;
    stop(id);
    dropMulch(scopeOf(id));
  }
  for (const source of sources) {
    startWatching(source);
    void indexSource(source);
  }
  return sources;
}

/** Sources the AI may use without being asked (enrichment, research, making). */
export async function autoSources(): Promise<Source[]> {
  return (await syncSources()).filter((source) => source.mode === "auto");
}

export async function getSource(id: string): Promise<Source | undefined> {
  return (await syncSources()).find((source) => source.id === id);
}

/** Where a file in a source opens: Obsidian for a vault's notes. */
export function openUrl(source: Source, relative: string): string | undefined {
  return isVault(source) && isMarkdown(relative) ? obsidianUrl(path.basename(source.path), relative) : undefined;
}

/* ── writing back ──────────────────────────────────────────────── */

/**
 * Add a new note to a source, only inside the folder the person allowed and
 * never over an existing file. Returns the new file's path in the source.
 */
export async function addNote(source: Source, name: string, markdown: string): Promise<string> {
  if (source.writeFolder === undefined) throw new Error(`mlch may not add notes to "${source.name}". The person can allow it in Settings → Sources.`);
  const base = name.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Note";
  const folder = source.writeFolder.replace(/^\/+|\/+$/g, "");
  const dir = resolveReadable(source.path, folder);
  if (!dir) throw new Error(`The folder "${folder}" is outside "${source.name}" or private.`);
  await fs.mkdir(dir, { recursive: true });
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, `${base}${n > 1 ? ` ${n}` : ""}.md`);
    try {
      await fs.writeFile(file, markdown, { flag: "wx" });
      void indexSource(source);
      return path.relative(source.path, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Too many notes with that name.");
}
