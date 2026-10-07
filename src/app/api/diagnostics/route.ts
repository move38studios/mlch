import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handle } from "@/lib/http";
import { getHarness } from "@/lib/agent/server/harnesses";
import { AGENT_HARNESS_IDS } from "@/lib/agent/types";
import { usageToday } from "@/lib/agent/usage";
import { desktopRequest, getCredential, libraryDir } from "@/lib/desktop/server";
import { log, logFile, logsDir, redact } from "@/lib/log";
import { spentToday } from "@/lib/media/spend";
import { listNapkins } from "@/lib/napkin/store";
import { readSettings } from "@/lib/settings";
import packageJson from "../../../../package.json";

export const dynamic = "force-dynamic";

async function tail(file: string, lines: number): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).split("\n").slice(-lines).join("\n");
  } catch {
    return "(none)";
  }
}

/** Summaries of this app's crash reports from the last week (macOS writes them). */
async function crashReports(): Promise<string> {
  const dir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^(Electron|npkn)/.test(n) && n.endsWith(".ips"));
  const lines: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs > 7 * 86_400_000) continue;
    try {
      const body = JSON.parse((await fs.readFile(file, "utf8")).split("\n").slice(1).join("\n")) as {
        procName?: string; parentProc?: string; exception?: { type?: string; signal?: string }; termination?: { indicator?: string };
      };
      lines.push(`${name}: ${body.procName} (parent ${body.parentProc}) ${body.exception?.type ?? ""} ${body.exception?.signal ?? ""} ${body.termination?.indicator ?? ""}`);
    } catch {
      lines.push(`${name}: unreadable`);
    }
  }
  return lines.join("\n") || "(none)";
}

/** Write a plain-text report for support to ~/Downloads and show it in Finder. */
export async function POST() {
  return handle(async () => {
    const settings = await readSettings();
    const harnesses = await Promise.all(
      AGENT_HARNESS_IDS.map(async (id) => {
        const s = await getHarness(id).getStatus().catch((error: Error) => ({ id, error: error.message }));
        return "error" in s
          ? `${id}: ${s.error}`
          : `${s.label} ${s.version ?? "?"}: installed=${s.installed} signedIn=${s.signedIn} billing=${s.billing} plan=${s.account?.plan ?? "?"}${s.problem ? ` problem="${s.problem}"` : ""}`;
      }),
    );
    const napkins = await listNapkins();
    const sections: Array<[string, string]> = [
      ["App", `npkn ${packageJson.version} · Electron ${process.versions.electron ?? "-"} · Node ${process.versions.node} · macOS ${os.release()} ${os.arch()} · ${new Date().toISOString()}`],
      ["AI", harnesses.join("\n")],
      ["Settings", JSON.stringify({ ...settings }, null, 2)],
      ["Keys set", ["groq", "firecrawl", "fal", "exa"].map((k) => `${k}=${getCredential(k as "groq") ? "yes" : "no"}`).join(" ")],
      ["Library", `${libraryDir()} · ${napkins.length} napkins`],
      ["Today", `generation spend $${(await spentToday()).toFixed(2)} · usage ${JSON.stringify(await usageToday())}`],
      ["Crash reports (7 days)", await crashReports()],
      ["Log (npkn.jsonl, last 400 lines)", await tail(logFile(), 400)],
      ["Desktop log (last 200 lines)", await tail(path.join(logsDir(), "desktop.log"), 200)],
    ];
    const text = redact(sections.map(([title, body]) => `## ${title}\n\n${body}\n`).join("\n"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(os.homedir(), "Downloads", `npkn-diagnostics-${stamp}.txt`);
    await fs.writeFile(file, text);
    log.info("diagnostics", "report saved", { file });
    await desktopRequest("reveal", { path: file });
    return { file };
  });
}
