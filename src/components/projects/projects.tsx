"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FolderInput, Plus } from "lucide-react";
import { create } from "zustand";
import type { Project } from "@/lib/projects/projects";

/**
 * Projects on the page: the list (shared by home and the mulch screen), moving
 * a mulch into one, and a menu to choose. lib/projects/projects.ts keeps them.
 */

export const useProjects = create<{ projects?: Project[]; load(): Promise<void> }>((set) => ({
  async load() {
    try {
      const body = (await (await fetch("/api/projects")).json()) as { projects?: Project[] };
      set({ projects: body.projects ?? [] });
    } catch {
      // Kept as it was.
    }
  },
}));

export function useProjectList(): Project[] | undefined {
  const projects = useProjects((s) => s.projects);
  const load = useProjects((s) => s.load);
  useEffect(() => {
    if (!projects) void load();
  }, [projects, load]);
  return projects;
}

export async function moveToProject(mulchId: string, projectId: string | null): Promise<boolean> {
  const response = await fetch(`/api/mulches/${mulchId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: projectId }) });
  return response.ok;
}

export async function newProject(name: string): Promise<Project | undefined> {
  const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const body = (await response.json().catch(() => ({}))) as { project?: Project };
  await useProjects.getState().load();
  return body.project;
}

/** Placeholder wording (George). */
export const PROJECT_WORDS = { newProject: "New project", none: "No project", move: "Project" };

/** A name field for a new project: Enter makes it, Esc gives up. */
export function NewProjectField({ onDone, className = "" }: { onDone(project?: Project): void; className?: string }) {
  const [name, setName] = useState("");
  return (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={async (e) => {
        e.stopPropagation();
        if (e.key === "Escape") onDone();
        if (e.key === "Enter" && name.trim()) onDone(await newProject(name.trim()));
      }}
      onBlur={() => !name.trim() && onDone()}
      placeholder={PROJECT_WORDS.newProject}
      aria-label={PROJECT_WORDS.newProject}
      className={`rounded-lg border border-line bg-chrome px-2.5 h-8 text-[13.5px] outline-none focus:border-ink placeholder:text-ink-3 ${className}`}
    />
  );
}

/**
 * Choose the project a mulch is in: the projects, none, or a new one.
 * `trigger` draws the button; the menu opens under it.
 */
export function ProjectMenu({
  mulchId,
  current,
  onMoved,
  trigger,
  align = "left",
}: {
  mulchId: string;
  current?: string;
  onMoved?(projectId: string | null): void;
  trigger(open: () => void, isOpen: boolean): React.ReactNode;
  align?: "left" | "right";
}) {
  const projects = useProjectList();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setOpen(false);
        setNaming(false);
      }
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  const move = useCallback(
    async (projectId: string | null) => {
      setOpen(false);
      setNaming(false);
      if ((projectId ?? undefined) === current) return;
      if (await moveToProject(mulchId, projectId)) onMoved?.(projectId);
    },
    [mulchId, current, onMoved],
  );
  return (
    <div ref={box} className="relative">
      {trigger(() => setOpen(!open), open)}
      {open && (
        <div className={`float absolute top-full mt-1 z-50 w-60 rounded-xl p-1 text-[13.5px] ${align === "right" ? "right-0" : "left-0"}`} role="menu">
          {(projects ?? []).map((project) => (
            <button key={project.id} onClick={() => void move(project.id)} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-paper-2" role="menuitem">
              <span className="flex-1 truncate">{project.name}</span>
              {project.id === current && <Check size={13} strokeWidth={2} />}
            </button>
          ))}
          {current && (
            <button onClick={() => void move(null)} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink-2 hover:bg-paper-2 hover:text-ink" role="menuitem">
              {PROJECT_WORDS.none}
            </button>
          )}
          {(projects?.length ?? 0) > 0 && <div className="my-1 h-px bg-line" />}
          {naming ? (
            <NewProjectField className="w-full" onDone={(project) => (project ? void move(project.id) : setNaming(false))} />
          ) : (
            <button onClick={() => setNaming(true)} className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink-2 hover:bg-paper-2 hover:text-ink" role="menuitem">
              <Plus size={13} strokeWidth={2} /> {PROJECT_WORDS.newProject}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The icon for moving a mulch into a project. */
export const ProjectIcon = FolderInput;
