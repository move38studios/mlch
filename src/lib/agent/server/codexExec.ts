/**
 * npkn: Codex making turns. Server-only.
 *
 * The app-server that runs ordinary turns has its shell switched off for the
 * whole process (CODEX_LOCKDOWN_CONFIG), so a turn that needs Codex's own
 * tools runs as `codex exec` instead: ephemeral, the user's config and rules
 * ignored, the workspace-write sandbox (writes only in the workspace and the
 * folders added to it), network on for package installs. Codex's sandbox
 * cannot limit network by host. It has none of our tools; the job picks up
 * the files it writes.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import type { HarnessEvent, HarnessTurnParams } from "../types";
import { resolveCodexBinary } from "./binaries";
import { buildCodexEnv } from "./env";

export function codexExecArgs(params: HarnessTurnParams): string[] {
  const workspace = params.workspace!;
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "workspace-write",
    "--cd",
    workspace.cwd,
    ...workspace.writable.flatMap((dir) => ["--add-dir", dir]),
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'approval_policy="never"',
    "-c",
    `web_search="${params.webAccess ? "live" : "disabled"}"`,
    ...(params.model && params.model !== "default" ? ["--model", params.model] : []),
    "-",
  ];
}

export async function* runCodexExec(params: HarnessTurnParams): AsyncGenerator<HarnessEvent> {
  const lookup = resolveCodexBinary();
  if (lookup.path === null) {
    yield { type: "error", code: "not_installed", message: lookup.problem };
    return;
  }
  const child = spawn(lookup.path, codexExecArgs(params), {
    cwd: params.workspace!.cwd,
    env: { ...buildCodexEnv(), ...params.workspace!.env } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const abort = () => child.kill("SIGTERM");
  params.signal.addEventListener("abort", abort, { once: true });
  child.stdin.end(`${params.systemPrompt}\n\n${params.prompt}`);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  let failed = false;
  try {
    for await (const line of readline.createInterface({ input: child.stdout })) {
      let event: { type?: string; message?: string; error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
        const message = event.error?.message ?? event.message ?? "Codex failed.";
        yield { type: "error", code: /usage|limit|quota/i.test(message) ? "usage_limit" : "harness_error", message };
      } else if (event.type === "turn.completed" && event.usage) {
        yield { type: "usage", inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
      }
    }
    const code = await exited;
    if (params.signal.aborted) yield { type: "error", code: "aborted", message: "Stopped." };
    else if (code !== 0 && !failed) yield { type: "error", code: "harness_error", message: `Codex stopped (exit ${code}). ${stderr.trim().split("\n").pop() ?? ""}` };
  } finally {
    params.signal.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
