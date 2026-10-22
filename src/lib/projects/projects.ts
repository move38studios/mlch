/**
 * Projects: named sets of mulches ("two calls, both about Preconscious Labs").
 * The list is `<library>/projects.json`; which project a mulch is in is kept
 * in its own folder (`project.json`), so it travels with the mulch like
 * archived.json. A project gives its mulches shared context: the other
 * mulches in it and its words (words.ts). Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { libraryDir } from "@/lib/desktop/server";
import { atomicWriteFile, isMulchId, mulchDir, MulchNotFoundError } from "@/lib/mulch/store";
import { newClientId } from "@/lib/mulch/ids";
import { wordsBlock, wordsFor } from "@/lib/words/words";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

const file = () => path.join(libraryDir(), "projects.json");

export async function listProjects(): Promise<Project[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is Project => !!p && typeof (p as Project).id === "string" && typeof (p as Project).name === "string") : [];
  } catch {
    return [];
  }
}

async function saveProjects(projects: Project[]): Promise<void> {
  await atomicWriteFile(file(), JSON.stringify(projects, null, 1));
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, 80);

export async function createProject(name: string): Promise<Project> {
  const clean = cleanName(name);
  if (!clean) throw new Error("A project needs a name.");
  const project: Project = { id: newClientId("p"), name: clean, createdAt: Date.now() };
  await saveProjects([...(await listProjects()), project]);
  return project;
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const clean = cleanName(name);
  if (!clean) throw new Error("A project needs a name.");
  const projects = await listProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error("No such project.");
  project.name = clean;
  await saveProjects(projects);
  return project;
}

/** Deletes the project; its mulches stay, outside any project. */
export async function deleteProject(id: string): Promise<void> {
  await saveProjects((await listProjects()).filter((p) => p.id !== id));
  for (const mulchId of await projectMulches(id)) await fs.rm(path.join(mulchDir(mulchId), "project.json"), { force: true });
}

/** The project a mulch is in, if any (one that still exists). */
export async function projectOf(mulchId: string): Promise<Project | undefined> {
  if (!isMulchId(mulchId)) return undefined;
  try {
    const { id } = JSON.parse(await fs.readFile(path.join(mulchDir(mulchId), "project.json"), "utf8")) as { id?: string };
    return id ? (await listProjects()).find((p) => p.id === id) : undefined;
  } catch {
    return undefined;
  }
}

/** Puts a mulch in a project, or takes it out (undefined). */
export async function setProject(mulchId: string, projectId: string | undefined): Promise<void> {
  const dir = mulchDir(mulchId);
  if (!existsSync(dir)) throw new MulchNotFoundError(mulchId);
  const target = path.join(dir, "project.json");
  if (!projectId) {
    await fs.rm(target, { force: true });
    return;
  }
  if (!(await listProjects()).some((p) => p.id === projectId)) throw new Error("No such project.");
  await atomicWriteFile(target, JSON.stringify({ id: projectId, at: Date.now() }));
}

/** Ids of the mulches in a project. */
export async function projectMulches(projectId: string): Promise<string[]> {
  const root = libraryDir();
  const ids = (await fs.readdir(root).catch(() => [] as string[])).filter(isMulchId);
  const found = await Promise.all(
    ids.map(async (id) => {
      try {
        const { id: project } = JSON.parse(await fs.readFile(path.join(root, id, "project.json"), "utf8")) as { id?: string };
        return project === projectId ? id : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.filter((id): id is string => !!id);
}

/**
 * For a prompt: the project this mulch is in, the other mulches in it, and
 * the words to spell right (the project's and those for all work).
 */
export async function projectBlock(mulchId: string, titleOf: (id: string) => Promise<string | undefined>): Promise<string> {
  const project = await projectOf(mulchId);
  const words = wordsBlock(await wordsFor(project?.id));
  if (!project) return words;
  const others = (await projectMulches(project.id)).filter((id) => id !== mulchId).slice(0, 30);
  const titles = (
    await Promise.all(
      others.map(async (id) => {
        const title = await titleOf(id);
        return title ? `- ${id} "${title}"` : "";
      }),
    )
  ).filter(Boolean);
  return (
    `<project>\nThis canvas is in the person's project "${project.name}". Its other canvases (search_all_mulches finds what is in them; prefer them when looking for related material):\n${titles.join("\n") || "(none yet)"}\n</project>\n\n` + words
  );
}
