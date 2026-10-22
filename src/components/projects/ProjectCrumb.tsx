"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Project } from "@/lib/projects/projects";
import { moveToProject, PROJECT_WORDS, ProjectIcon, ProjectMenu, useProjects } from "./projects";

/** Placeholder wording (George). */
const LOOKS_LIKE = (name: string) => `Looks like ${name}`;
const MOVE = "Move";

/** How often a mulch in no project asks which one it may belong to (the server answers from its cache in between). */
const SUGGEST_MS = 60_000;

/**
 * By the mulch's title: the project it is in (a menu to change it), and, when
 * it is in none, the project it probably belongs to, with Move (lib/projects/suggest.ts).
 */
export function ProjectCrumb({ mulchId }: { mulchId: string }) {
  const [project, setProject] = useState<Project | null>();
  const [suggestion, setSuggestion] = useState<Project | null>(null);
  const projects = useProjects((s) => s.projects);

  const check = useCallback(
    async (suggest: boolean) => {
      try {
        const body = (await (await fetch(`/api/mulches/${mulchId}/project${suggest ? "?suggest=1" : ""}`)).json()) as { project?: Project | null; suggestion?: Project | null };
        setProject(body.project ?? null);
        setSuggestion(body.suggestion ?? null);
      } catch {
        // Tried again later.
      }
    },
    [mulchId],
  );

  useEffect(() => {
    void check(true);
  }, [check]);
  // A renamed project shows its new name.
  useEffect(() => {
    if (project && projects) setProject(projects.find((p) => p.id === project.id) ?? null);
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps
  // In no project: ask again as the mulch grows (a call goes on).
  useEffect(() => {
    if (project !== null || suggestion) return;
    const timer = setInterval(() => document.visibilityState === "visible" && void check(true), SUGGEST_MS);
    return () => clearInterval(timer);
  }, [project, suggestion, check]);

  const moved = (projectId: string | null) => {
    setSuggestion(null);
    setProject(projectId ? ((useProjects.getState().projects ?? []).find((p) => p.id === projectId) ?? null) : null);
    void check(false);
  };

  if (project === undefined) return null;
  return (
    <>
      <ProjectMenu
        mulchId={mulchId}
        current={project?.id}
        onMoved={moved}
        trigger={(toggle, open) =>
          project ? (
            <button onClick={toggle} className={`max-w-[18vw] truncate rounded-lg px-1.5 py-1 text-[13.5px] text-ink-3 hover:bg-paper-2 hover:text-ink ${open ? "bg-paper-2 text-ink" : ""}`} title={PROJECT_WORDS.move}>
              {project.name} /
            </button>
          ) : (
            <button onClick={toggle} className={`p-1.5 rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink ${open ? "bg-paper-2 text-ink" : ""}`} aria-label={PROJECT_WORDS.move} title={PROJECT_WORDS.move}>
              <ProjectIcon size={15} strokeWidth={1.75} />
            </button>
          )
        }
      />
      {suggestion && !project && (
        <span className="ml-1 flex items-center gap-1 rounded-lg bg-amber-soft pl-2 pr-0.5 h-7 text-[12.5px] whitespace-nowrap">
          {LOOKS_LIKE(suggestion.name)}
          <button
            onClick={async () => {
              if (await moveToProject(mulchId, suggestion.id)) moved(suggestion.id);
            }}
            className="ml-1 px-2 h-6 rounded-md bg-ink text-white font-medium"
          >
            {MOVE}
          </button>
          <button
            onClick={() => {
              void fetch(`/api/mulches/${mulchId}/project`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dismiss: suggestion.id }) });
              setSuggestion(null);
            }}
            className="p-1 rounded-md text-ink-3 hover:text-ink"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      )}
    </>
  );
}
