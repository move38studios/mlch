"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { moveToProject, PROJECT_WORDS, ProjectIcon, ProjectMenu, useProjects } from "@/components/projects/projects";
import type { Project } from "@/lib/projects/projects";
import { Scribble } from "@/components/brand/Scribble";
import { KIND_LABEL, openResult, plain, type SearchResult } from "@/components/search/SearchPalette";
import { formatDateTime } from "@/lib/format";
import type { MulchSummary } from "@/lib/mulch/types";

/** How many rows show before scrolling loads more. */
const PAGE = 50;
const DAY = 24 * 60 * 60 * 1000;

/** Most recent first: last change or last opened. */
export const recency = (mulch: MulchSummary) => Math.max(mulch.updatedAt, mulch.openedAt ?? 0);

/** Every word of the query starts some word of the title (any order). */
export function titleMatches(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const parts = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((word) => parts.some((part) => part.startsWith(word)));
}

/** Today / This week / Earlier, by recency. */
export function byWhen(mulches: MulchSummary[], now = Date.now()): Array<{ label: string; mulches: MulchSummary[] }> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const groups = [
    { label: "Today", mulches: [] as MulchSummary[] },
    { label: "This week", mulches: [] as MulchSummary[] },
    { label: "Earlier", mulches: [] as MulchSummary[] },
  ];
  for (const mulch of mulches) {
    const at = recency(mulch);
    groups[at >= midnight.getTime() ? 0 : at >= midnight.getTime() - 6 * DAY ? 1 : 2].mulches.push(mulch);
  }
  return groups.filter((group) => group.mulches.length);
}

/** The query's words marked in a snippet. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, i) => (i % 2 ? <mark key={i} className="bg-amber-soft text-ink rounded-[3px] px-0.5">{part}</mark> : part))}
    </>
  );
}

type Row =
  | { type: "mulch"; key: string; mulch: MulchSummary }
  | { type: "inside"; key: string; hit: SearchResult; more: number }
  | { type: "folder"; key: string; hit: SearchResult };

/**
 * The list, and search over it. Without a query: recent first, by when. With
 * one: titles that match (the list filters), then what is inside mulches (one
 * row per mulch), then linked folders. ↑/↓ and Enter move through every row.
 */
export function HomeList({
  mulches,
  query,
  results,
  field,
  onClear,
  renderActions,
  projects = [],
  onChanged,
  onNewIn,
}: {
  mulches: MulchSummary[];
  /** Projects: their mulches show inside them, the rest below by when. */
  projects?: Project[];
  /** A mulch moved between projects, or a project changed: load the list again. */
  onChanged?(): void;
  /** New, inside a project. */
  onNewIn?(projectId: string): void;
  query: string;
  results?: SearchResult[];
  field: React.RefObject<HTMLInputElement | null>;
  onClear(): void;
  /** The archive control and its confirmation, per row. */
  renderActions(mulch: MulchSummary): React.ReactNode;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(PAGE);
  const [active, setActive] = useState(-1);
  const more = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  const known = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);
  const inProject = (mulch: MulchSummary) => !!mulch.project && known.has(mulch.project);
  const rows = useMemo<Row[]>(() => {
    // Mulches in a project are listed inside it.
    if (!searching) return mulches.filter((m) => !m.archivedAt && !(m.project && known.has(m.project))).map((mulch) => ({ type: "mulch" as const, key: mulch.id, mulch }));
    const titled = mulches.filter((m) => titleMatches(m.title, query)).sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
    const inside = new Map<string, { hit: SearchResult; count: number }>();
    // Only hits close to the best one: loose "similar meaning" matches would bury the real ones.
    const top = Math.max(0, ...(results ?? []).map((hit) => hit.score ?? 0));
    const strong = (results ?? []).filter((hit) => (hit.score ?? 0) >= top * 0.6);
    for (const hit of strong) {
      if (!hit.mulchId) continue;
      const entry = inside.get(hit.mulchId);
      if (entry) entry.count++;
      else inside.set(hit.mulchId, { hit, count: 1 });
    }
    return [
      ...titled.map((mulch) => ({ type: "mulch" as const, key: mulch.id, mulch })),
      ...[...inside.values()].map(({ hit, count }) => ({ type: "inside" as const, key: `in:${hit.mulchId}`, hit, more: count - 1 })),
      ...strong.filter((hit) => hit.sourceId).map((hit, i) => ({ type: "folder" as const, key: `src:${hit.sourceId}:${hit.path}:${i}`, hit })),
    ];
  }, [mulches, query, results, searching, known]);

  useEffect(() => setActive(searching ? 0 : -1), [query, searching]);
  useEffect(() => setShown(PAGE), [query]);

  // More rows as the end of the list comes into view.
  useEffect(() => {
    const sentinel = more.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => n + PAGE));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [rows.length, shown]);

  function open(row: Row) {
    if (row.type === "mulch") router.push(`/n/${row.mulch.id}`);
    else openResult(router, row.hit);
  }

  // The field's keys: arrows through every row, Enter opens, Esc clears.
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = Math.min(rows.length, shown);
        if (count) setActive((i) => (event.key === "ArrowDown" ? (i + 1) % count : i <= 0 ? count - 1 : i - 1));
      } else if (event.key === "Enter" && rows[active]) {
        event.preventDefault();
        open(rows[active]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClear();
      }
    };
    input.addEventListener("keydown", onKey);
    return () => input.removeEventListener("keydown", onKey);
  });

  // Typing anywhere on home goes into the search field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [field]);

  const visible = rows.slice(0, shown);
  const index = new Map(visible.map((row, i) => [row.key, i]));
  const rowClass = (row: Row) => (index.get(row.key) === active ? "bg-paper-2" : "");

  const mulchRow = (row: Extract<Row, { type: "mulch" }>) => (
    <li key={row.key} className={`group flex items-center rounded-xl hover:bg-paper-2 ${rowClass(row)}`} ref={index.get(row.key) === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
      <Link
        href={`/n/${row.mulch.id}`}
        draggable={!row.mulch.archivedAt}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, row.mulch.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        className="flex-1 min-w-0 flex items-baseline gap-4 py-3 px-3"
      >
        <span className={`truncate text-[17px] font-medium tracking-[-0.01em] ${row.mulch.archivedAt ? "text-ink-2" : ""}`}>{searching ? <Marked text={row.mulch.title} query={query} /> : row.mulch.title}</span>
        {/* Something running; results not yet seen; a failure. */}
        {row.mulch.activity?.working ? (
          <span className="shrink-0 self-center" title="Working" aria-label="Working">
            <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-3 w-8 text-ink" />
          </span>
        ) : null}
        {row.mulch.activity?.unseen ? <span className="h-2 w-2 shrink-0 self-center rounded-full bg-amber" title="New results" aria-label="New results" /> : null}
        {row.mulch.activity?.failed ? <span className="h-2 w-2 shrink-0 self-center rounded-full bg-danger" title="Failed" aria-label="Failed" /> : null}
        <span className="flex-1" />
        {row.mulch.archivedAt ? (
          <span className="text-[13px] text-ink-3 shrink-0 inline-flex items-center gap-1">
            <Archive size={12} strokeWidth={1.75} /> Archived
          </span>
        ) : (
          <span className="text-[13px] text-ink-3 shrink-0 tabular-nums">{row.mulch.nodeCount} items</span>
        )}
        <span className="text-[13px] text-ink-3 shrink-0 tabular-nums w-36 text-right">{formatDateTime(recency(row.mulch))}</span>
      </Link>
      {!row.mulch.archivedAt && (
        <ProjectMenu
          mulchId={row.mulch.id}
          current={inProject(row.mulch) ? row.mulch.project : undefined}
          onMoved={() => onChanged?.()}
          align="right"
          trigger={(toggle, isOpen) => (
            <button
              onClick={toggle}
              className={`p-1.5 rounded-lg text-ink-3 hover:text-ink focus-visible:opacity-100 ${isOpen ? "opacity-100 text-ink" : "opacity-0 group-hover:opacity-100"}`}
              aria-label={PROJECT_WORDS.move}
              title={PROJECT_WORDS.move}
            >
              <ProjectIcon size={15} strokeWidth={1.75} />
            </button>
          )}
        />
      )}
      {!row.mulch.archivedAt && renderActions(row.mulch)}
    </li>
  );

  const hitRow = (row: Extract<Row, { type: "inside" | "folder" }>) => (
    <li key={row.key} ref={index.get(row.key) === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
      <div className={`rounded-xl hover:bg-paper-2 ${rowClass(row)}`}>
        <button onClick={() => open(row)} className="w-full text-left px-3 pt-2.5 pb-2 outline-none">
          <div className="flex items-baseline gap-2 text-[12.5px] text-ink-3">
            <span className="text-ink-2 font-medium truncate">{row.hit.mulchTitle}</span>
            <span>{KIND_LABEL[row.hit.kind] ?? row.hit.kind}</span>
            {row.hit.title && <span className="truncate">{row.hit.title}</span>}
            {row.hit.page && <span>p.{row.hit.page}</span>}
            <span className="flex-1" />
            {row.hit.at && row.hit.at > 978_307_200_000 && <span className="shrink-0 tabular-nums">{formatDateTime(row.hit.at)}</span>}
          </div>
          <p className="text-[14.5px] leading-snug line-clamp-2 mt-0.5">
            <Marked text={plain(row.hit.snippet)} query={query} />
          </p>
        </button>
        {row.type === "inside" && row.more > 0 && (
          <Link href={`/n/${row.hit.mulchId}?q=${encodeURIComponent(query.trim())}`} className="block px-3 pb-2.5 -mt-1 text-[12.5px] text-ink-3 hover:text-ink">
            {row.more} more
          </Link>
        )}
      </div>
    </li>
  );

  if (!searching) {
    const groups = byWhen(visible.map((row) => (row as Extract<Row, { type: "mulch" }>).mulch));
    const active = mulches.filter((m) => !m.archivedAt);
    // Projects with recent work first.
    const sections = projects
      .map((project) => {
        const members = active.filter((m) => m.project === project.id).sort((a, b) => recency(b) - recency(a));
        return { project, members, at: Math.max(project.createdAt, ...members.map(recency)) };
      })
      .sort((a, b) => b.at - a.at);
    return (
      <div>
        {sections.map(({ project, members }) => (
          <ProjectSection key={project.id} project={project} members={members} row={mulchRow} onChanged={onChanged} onNewIn={onNewIn} />
        ))}
        <div
          onDragOver={(event) => event.dataTransfer.types.includes(DRAG_TYPE) && event.preventDefault()}
          onDrop={async (event) => {
            const id = event.dataTransfer.getData(DRAG_TYPE);
            if (id && mulches.find((m) => m.id === id && inProject(m)) && (await moveToProject(id, null))) onChanged?.();
          }}
          className={sections.length ? "min-h-12" : ""}
        >
          {groups.map((group) => (
            <section key={group.label} className="mb-6">
              <h2 className="text-[13px] text-ink-3 mb-1">{group.label}</h2>
              <ul className="-mx-3">{group.mulches.map((mulch) => mulchRow({ type: "mulch", key: mulch.id, mulch }))}</ul>
            </section>
          ))}
        </div>
        {rows.length > shown && <div ref={more} className="h-8" />}
      </div>
    );
  }

  const titled = visible.filter((row): row is Extract<Row, { type: "mulch" }> => row.type === "mulch");
  const inside = visible.filter((row): row is Extract<Row, { type: "inside" }> => row.type === "inside");
  const folders = visible.filter((row): row is Extract<Row, { type: "folder" }> => row.type === "folder");
  return (
    <div>
      {titled.length > 0 && <ul className="-mx-3 mb-6">{titled.map(mulchRow)}</ul>}
      {inside.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[13px] text-ink-3 mb-1">Inside</h2>
          <ul className="-mx-3">{inside.map(hitRow)}</ul>
        </section>
      )}
      {folders.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[13px] text-ink-3 mb-1">In your folders</h2>
          <ul className="-mx-3">{folders.map(hitRow)}</ul>
        </section>
      )}
      {!rows.length && results && <p className="text-[14px] text-ink-3">Nothing found.</p>}
      {rows.length > shown && <div ref={more} className="h-8" />}
    </div>
  );
}

/** What a dragged mulch row carries. */
const DRAG_TYPE = "application/x-mlch-mulch";

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("mlch.projects.collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem("mlch.projects.collapsed", JSON.stringify([...ids]));
  } catch {
    // Only a convenience.
  }
}

/** A project on home: its name (renamed or deleted in place), its mulches, New inside it; mulches dropped on it move in. */
function ProjectSection({
  project,
  members,
  row,
  onChanged,
  onNewIn,
}: {
  project: Project;
  members: MulchSummary[];
  row(row: { type: "mulch"; key: string; mulch: MulchSummary }): React.ReactNode;
  onChanged?(): void;
  onNewIn?(projectId: string): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setCollapsed(readCollapsed().has(project.id)), [project.id]);
  const toggle = () => {
    const ids = readCollapsed();
    if (collapsed) ids.delete(project.id);
    else ids.add(project.id);
    saveCollapsed(ids);
    setCollapsed(!collapsed);
  };
  const rename = async () => {
    const name = renaming?.trim();
    setRenaming(undefined);
    if (!name || name === project.name) return;
    await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: project.id, name }) });
    await useProjects.getState().load();
    onChanged?.();
  };
  const remove = async () => {
    setDeleting(false);
    await fetch(`/api/projects?id=${encodeURIComponent(project.id)}`, { method: "DELETE" });
    await useProjects.getState().load();
    onChanged?.();
  };
  return (
    <section
      className={`mb-5 -mx-3 rounded-2xl ${over ? "bg-amber-soft" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setOver(false)}
      onDrop={async (event) => {
        setOver(false);
        const id = event.dataTransfer.getData(DRAG_TYPE);
        if (id && !members.some((m) => m.id === id) && (await moveToProject(id, project.id))) onChanged?.();
      }}
      aria-label={project.name}
    >
      <div className="group/project flex items-center gap-1 px-3 h-9">
        <button onClick={toggle} className="p-0.5 -ml-1 rounded text-ink-3 hover:text-ink" aria-label={collapsed ? "Show" : "Hide"} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={15} strokeWidth={1.75} /> : <ChevronDown size={15} strokeWidth={1.75} />}
        </button>
        {renaming !== undefined ? (
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(undefined);
            }}
            aria-label="Name"
            className="flex-1 min-w-0 bg-paper-2 rounded-lg px-1.5 py-0.5 text-[15px] font-semibold outline-none"
          />
        ) : (
          <button onClick={toggle} className="min-w-0 truncate text-left text-[15px] font-semibold tracking-[-0.01em]">
            {project.name}
          </button>
        )}
        <span className="text-[13px] text-ink-3 tabular-nums ml-1.5">{members.length}</span>
        <span className="flex-1" />
        {deleting ? (
          <span className="flex items-center gap-1.5 text-[12.5px]">
            <button onClick={() => setDeleting(false)} className="px-2 py-1 rounded-lg hover:bg-line text-ink-2">
              Cancel
            </button>
            <button onClick={() => void remove()} className="px-2 py-1 rounded-lg bg-ink text-white">
              Delete project
            </button>
          </span>
        ) : (
          <>
            <button onClick={() => setRenaming(project.name)} className="p-1.5 rounded-lg text-ink-3 opacity-0 group-hover/project:opacity-100 hover:text-ink focus-visible:opacity-100" aria-label="Rename" title="Rename">
              <Pencil size={13} strokeWidth={1.75} />
            </button>
            <button onClick={() => setDeleting(true)} className="p-1.5 rounded-lg text-ink-3 opacity-0 group-hover/project:opacity-100 hover:text-ink focus-visible:opacity-100" aria-label="Delete project" title="Delete project">
              <Trash2 size={13} strokeWidth={1.75} />
            </button>
            {onNewIn && (
              <button onClick={() => onNewIn(project.id)} className="p-1.5 rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink" aria-label="New" title="New">
                <Plus size={15} strokeWidth={2} />
              </button>
            )}
          </>
        )}
      </div>
      {!collapsed && <ul className="pl-4">{members.map((mulch) => row({ type: "mulch", key: mulch.id, mulch }))}</ul>}
    </section>
  );
}
