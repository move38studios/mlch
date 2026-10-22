"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Word } from "@/lib/words/words";
import { useProjectList } from "@/components/projects/projects";

/** Placeholder wording (George). */
const WORDS = {
  intro: "Names and terms mlch writes this way when it hears them. It learns them from your corrections.",
  none: "None yet.",
  add: "Add",
  heard: "Heard as (optional)",
  all: "All work",
};

/** The words mlch has learned (lib/words/words.ts): see them, add one, forget one. */
export function Words() {
  const [words, setWords] = useState<Word[]>();
  const [term, setTerm] = useState("");
  const [heard, setHeard] = useState("");
  const [project, setProject] = useState("");
  const projects = useProjectList();
  const load = async () => {
    const body = (await (await fetch("/api/words")).json().catch(() => ({}))) as { words?: Word[] };
    setWords(body.words ?? []);
  };
  useEffect(() => {
    void load();
  }, []);
  const add = async () => {
    if (!term.trim()) return;
    await fetch("/api/words", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ term, heard, project }) });
    setTerm("");
    setHeard("");
    await load();
  };
  const remove = async (id: string) => {
    await fetch(`/api/words?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  };
  const projectName = (id?: string) => (id ? projects?.find((p) => p.id === id)?.name : undefined);
  return (
    <div>
      <p className="text-[13px] text-ink-3 mb-3">{WORDS.intro}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="flex flex-wrap items-center gap-2 mb-3"
      >
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Word" aria-label="Word" className="h-9 w-40 rounded-lg border border-line bg-chrome px-2.5 text-[14px] outline-none focus:border-ink" />
        <input value={heard} onChange={(e) => setHeard(e.target.value)} placeholder={WORDS.heard} aria-label={WORDS.heard} className="h-9 w-48 rounded-lg border border-line bg-chrome px-2.5 text-[14px] outline-none focus:border-ink" />
        {(projects?.length ?? 0) > 0 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className="h-9 rounded-lg border border-line bg-chrome px-2 text-[14px] outline-none focus:border-ink">
            <option value="">{WORDS.all}</option>
            {projects!.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={!term.trim()} className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium disabled:bg-paper-2 disabled:text-ink-3">
          {WORDS.add}
        </button>
      </form>
      {words && !words.length && <p className="text-[13px] text-ink-3">{WORDS.none}</p>}
      {words && words.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {words.map((word) => (
            <li key={word.id} className="group inline-flex items-center gap-1 rounded-lg bg-paper-2 pl-2.5 pr-1 py-1 text-[13px]" title={word.heard?.length ? `Heard as ${word.heard.join(", ")}` : undefined}>
              <span className="font-medium">{word.term}</span>
              {word.heard?.length ? <span className="text-ink-3">{word.heard.join(", ")}</span> : null}
              {projectName(word.project) && <span className="text-ink-3">{projectName(word.project)}</span>}
              <button onClick={() => void remove(word.id)} className="p-0.5 rounded text-ink-3 hover:text-ink" aria-label={`Forget ${word.term}`} title="Forget">
                <X size={12} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
