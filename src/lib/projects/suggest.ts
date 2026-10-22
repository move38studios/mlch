/**
 * Which project a mulch that is in none probably belongs to, once there is
 * enough on it (a few minutes into a call, or a dozen cards): a quick model
 * call sees the projects (names and their mulches' titles) and what this one
 * is about, and names one or none. Dismissed, a project is not suggested for
 * that mulch again (`<mulch>/project-suggestion.json`). Server-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "@/lib/log";
import { atomicWriteFile, listMulches, mulchDir, openMulch } from "@/lib/mulch/store";
import { modelFor, readSettings } from "@/lib/settings";
import { getHarness } from "@/lib/agent/server/harnesses";
import type { AgentToolRuntime } from "@/lib/agent/types";
import { listProjects, projectOf, type Project } from "./projects";

/** Enough to tell what a mulch is about. */
const ENOUGH_CHARS = 600;
/** Asked again at most this often for one mulch (it grows during a call). */
const AGAIN_MS = 3 * 60_000;

const NO_TOOLS: AgentToolRuntime = { definitions: [], execute: async () => ({ ok: false, text: "No tools here.", summary: "", ops: [] }) };

const ASK = `You sort a person's canvases into their projects. You get their projects (each with the titles of canvases already in it) and what one new canvas is about.
Reply with only the id of the project it clearly belongs to (the same client, company, team or subject), or exactly "none" when no project clearly fits or you are unsure. Never anything else.`;

interface Kept {
  dismissed?: string[];
  /** The last answer: when, how much there was to go on, and which project (none: absent). */
  asked?: { at: number; size: number; answer?: string; projects?: string };
}

const keptFile = (mulchId: string) => path.join(mulchDir(mulchId), "project-suggestion.json");

async function readKept(mulchId: string): Promise<Kept> {
  try {
    return JSON.parse(await fs.readFile(keptFile(mulchId), "utf8")) as Kept;
  } catch {
    return {};
  }
}

async function dismissed(mulchId: string): Promise<string[]> {
  const list = (await readKept(mulchId)).dismissed;
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
}

export async function dismissSuggestion(mulchId: string, projectId: string): Promise<void> {
  const kept = await readKept(mulchId);
  await atomicWriteFile(keptFile(mulchId), JSON.stringify({ ...kept, dismissed: [...new Set([...(await dismissed(mulchId)), projectId])] }));
}

/** Asked again only when the mulch has grown this much since (a call goes on), and not sooner than AGAIN_MS. */
const grown = (size: number, before: number) => size >= before * 1.5 && size - before >= 1500;

/** What a mulch is about, for the question: its title, its cards, and the end of its transcript. */
async function aboutText(mulchId: string): Promise<string> {
  const entry = await openMulch(mulchId);
  const cards = Object.values(entry.mulch.nodes)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40)
    .map((node) => `${node.title ? `${node.title}: ` : ""}${node.text.slice(0, 300)}`)
    .join("\n");
  const said = entry.transcript
    .slice(-80)
    .map((segment) => segment.text.trim())
    .join(" ");
  return `Title: ${entry.mulch.title}\n\n${cards}\n\n${said}`.trim();
}

/** The project to suggest for this mulch now, if any. */
export async function suggestProject(mulchId: string): Promise<Project | undefined> {
  if (await projectOf(mulchId)) return undefined;
  const no = new Set(await dismissed(mulchId));
  const projects = (await listProjects()).filter((p) => !no.has(p.id));
  if (!projects.length) return undefined;
  const kept = await readKept(mulchId);
  const previous = kept.asked;
  const about = await aboutText(mulchId);
  // A new project is reason to ask again.
  const among = projects.map((p) => p.id).sort().join(",");
  if (previous && previous.projects === among && (Date.now() - previous.at < AGAIN_MS || !grown(about.length, previous.size))) return projects.find((p) => p.id === previous.answer);
  if (about.length < ENOUGH_CHARS) return undefined;
  const remember = (answer?: string) => atomicWriteFile(keptFile(mulchId), JSON.stringify({ ...kept, asked: { at: Date.now(), size: about.length, projects: among, ...(answer ? { answer } : {}) } })).catch(() => {});
  await remember(previous?.answer);
  const mulches = await listMulches();
  const list = projects
    .map((project) => {
      const titles = mulches.filter((m) => m.project === project.id && m.id !== mulchId).map((m) => `"${m.title}"`).slice(0, 15);
      return `${project.id}: "${project.name}"${titles.length ? `, with ${titles.join(", ")}` : ""}`;
    })
    .join("\n");
  try {
    const settings = await readSettings();
    let said = "";
    for await (const event of getHarness(settings.harness).runTurn({
      history: [],
      prompt: `<projects>\n${list}\n</projects>\n\n<canvas>\n${about.slice(0, 8000)}\n</canvas>`,
      systemPrompt: ASK,
      tools: NO_TOOLS,
      model: modelFor(settings, "fast"),
      maxSteps: 1,
      signal: AbortSignal.timeout(60_000),
    })) {
      if (event.type === "text-delta") said += event.delta;
      if (event.type === "error") throw new Error(event.message);
    }
    const answer = projects.find((p) => said.includes(p.id));
    await remember(answer?.id);
    log.info("projects", "Suggested a project", { mulchId, project: answer?.id ?? "none" });
    return answer;
  } catch (error) {
    log.warn("projects", "Suggesting a project failed", { mulchId, error });
    return undefined;
  }
}
