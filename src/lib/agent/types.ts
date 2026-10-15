/**
 * mlch agent: shared contracts.
 *
 * Adapted from node-banana's agent (MIT, © William Falloon). Each turn runs on
 * the user's own Claude Code or Codex login through the official CLI, never on
 * API credits. The CLI calls our tools; the tools edit the mulch on the
 * server, which logs and broadcasts the resulting ops to open windows.
 */

import type { MulchOp } from "@/lib/mulch/types";

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

export type AgentHarnessId = "claude" | "codex";

export const AGENT_HARNESS_IDS: readonly AgentHarnessId[] = ["claude", "codex"];

/** The turn's opening status line, from the moment it is sent until the reply starts. */
export const AGENT_OPENING_STATUS = "Working…";

/** Who pays for a turn. Only "subscription" may run. */
export type AgentBilling = "subscription" | "api" | "none" | "unknown";

export interface AgentModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  /** One line from the vendor ("Most capable for ambitious work"). */
  description?: string;
  /** The exact model an alias runs today (`opus` → `claude-opus-5-5`), when the CLI says. */
  resolvedModel?: string;
  /** Thinking effort levels the model accepts, lowest first (`low` … `max`). Absent: no effort control. */
  efforts?: string[];
  /** The level a turn runs at when the user has picked none. */
  defaultEffort?: string;
}

export interface AgentSignInState {
  state: "idle" | "pending" | "failed";
  /**
   * The vendor's own sign-in page, when its CLI hands one to the client
   * (Codex's app-server login). Never set for Claude Code: the URL it prints
   * is its manual flow, which ends in a code pasted back into the CLI, and
   * relaying it would put the app between the user and their credential.
   */
  url?: string;
  /** Device-code flow: the code the user types at `url`. */
  userCode?: string;
  error?: string;
}

export interface AgentHarnessStatus {
  id: AgentHarnessId;
  /** "Claude Code" | "Codex" */
  label: string;
  /** The CLI binary could be found and started. */
  installed: boolean;
  version?: string;
  signedIn: boolean;
  billing: AgentBilling;
  /** Packaged app: getting the CLI (missing until asked for, downloading, …). */
  cli?: { state: "checking" | "missing" | "downloading" | "ready" | "failed"; progress?: number; error?: string };
  /** Paid by the person's subscription login, or by their API key (Settings). */
  auth?: "subscription" | "apiKey";
  account?: { email?: string; plan?: string };
  models: AgentModelOption[];
  /**
   * `models` is the built-in list because the CLI's own couldn't be read; the
   * picker says so. The panel re-checks status each time it opens.
   */
  modelsFallback?: boolean;
  signIn: AgentSignInState;
  /**
   * Why the harness cannot run right now, in plain words for the panel
   * (not installed, signed out, an API key would be billed, ...). Absent when
   * the harness is ready: installed && signedIn && billing === "subscription".
   */
  problem?: string;
  /**
   * The plan's included usage ran out at the last check: turns are refused
   * (never billed as extra usage or credits) until `until`. The login itself
   * is fine, so the status may still read ready; `problem` carries the same
   * message. Absent when no limit is known.
   */
  usageLimit?: {
    message: string;
    /** When turns may run again (ms epoch): the plan's reset time, or a short back-off when the vendor gave none. */
    until: number;
  };
  /** The terminal command that signs in with the vendor's own flow. */
  signInCommand: string;
  /**
   * mlch: something about the person's CLI setup worth knowing that doesn't
   * stop turns (an API key in its settings that mlch ignores for the subscription).
   */
  notice?: string;
  /** mlch: the plan's usage windows at the last check (percent used), when the vendor reports them. */
  planUsage?: Array<{ name: string; percent: number; resetsAt?: number; at: number }>;
}

/** Options for {@link AgentHarness.startSignIn}. */
export interface AgentSignInOptions {
  /**
   * Start the vendor's sign-in even though the CLI's local status looks
   * signed in: the vendor rejected that login during a turn (expired or
   * revoked), which the local status can't see. Without it a harness that
   * reads as ready answers `already_signed_in`.
   */
  force?: boolean;
}

export interface AgentSignInStart {
  state: "pending" | "already_signed_in" | "failed";
  /** As {@link AgentSignInState.url}: Codex only. */
  url?: string;
  userCode?: string;
  message?: string;
}

export type AgentErrorCode =
  | "not_installed"
  | "not_signed_in"
  | "wrong_billing"
  | "usage_limit"
  | "session_busy"
  | "bad_request"
  | "aborted"
  | "harness_error";

/** Events a harness yields while running one turn. The iterator ending means the turn is done. */
export type HarnessEvent =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  /** The model started writing a call to one of our tools (input still streaming). */
  | { type: "tool-pending"; toolName: string }
  /** mlch: the CLI used one of its own tools (Write, Bash, WebSearch…), for the job's activity line. */
  | { type: "tool-use"; name: string; input?: Record<string, unknown> }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: AgentErrorCode; message: string };

/** The tool name harnesses report as pending while their own web search runs (research turns). */
export const WEB_TOOL_PENDING = "web_search";

export interface HarnessTurnParams {
  /** Resume this Claude session / Codex thread when possible. */
  sessionId?: string;
  /**
   * Earlier turns of this chat as plain text. Used only when there is no
   * resumable session (first turn on this harness, harness switched mid-chat,
   * app-server restarted), so the new session starts with the conversation.
   */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** This turn's user message, already combined with the canvas context. */
  prompt: string;
  systemPrompt: string;
  tools: AgentToolRuntime;
  model?: string;
  /** Thinking effort, already checked against the model's own levels. */
  effort?: string;
  /** Turn on the harness's own web search and fetch. */
  webAccess?: boolean;
  /**
   * Run with the CLI's own tools (shell, file editing) inside its OS sandbox,
   * for making files. Absent: only our tools.
   */
  workspace?: AgentWorkspace;
  /**
   * mlch: run with the person's own CLI setup (their settings, CLAUDE.md /
   * AGENTS.md, hooks). Absent: mlch's tools only, nothing of theirs.
   */
  userSetup?: AgentUserSetup;
  signal: AbortSignal;
}

export interface AgentUserSetup {
  /** Their MCP servers and connectors too (instructions, research, making). */
  connectors: boolean;
  /**
   * Ask the person about a connector tool that acts (not marked read-only).
   * Resolves true to run it. Absent: such tools are refused.
   */
  approve?: (request: ToolApprovalRequest) => Promise<boolean>;
}

/** A connector tool call waiting for the person. Server and tool names come from their config: untrusted text. */
export interface ToolApprovalRequest {
  /** The MCP server as the person named it ("claude.ai Gmail"). */
  server: string;
  /** The tool's own name ("send_message"). */
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentWorkspace {
  /** Working directory; writable. */
  cwd: string;
  /** Other absolute folders the sandbox may write. */
  writable: string[];
  /** Absolute folders it may not read. */
  readDenied: string[];
  /** Hosts sandboxed commands may reach (package registries). */
  networkDomains: string[];
  /** Extra environment for commands (caches kept inside the workspace). */
  env: Record<string, string>;
}

export interface AgentHarness {
  id: AgentHarnessId;
  label: string;
  getStatus(): Promise<AgentHarnessStatus>;
  /** Start the vendor's own sign-in flow (the official CLI). Never touches tokens. */
  startSignIn(options?: AgentSignInOptions): Promise<AgentSignInStart>;
  /** Stop a running sign-in: the CLI is killed (or its login cancelled) and the status reads idle again. */
  cancelSignIn(): Promise<void>;
  runTurn(params: HarnessTurnParams): AsyncIterable<HarnessEvent>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface AgentToolDefinition {
  /** snake_case name the model sees, e.g. "edit_workflow". */
  name: string;
  /** Short label for the chat UI, e.g. "Edit workflow". */
  title: string;
  description: string;
  /**
   * zod raw shape (the object passed to z.object). The Claude harness hands it
   * to the Agent SDK's tool(); the Codex harness converts
   * z.toJSONSchema(z.object(inputShape)) for dynamic tools.
   */
  inputShape: import("zod").ZodRawShape;
  readOnly: boolean;
}

export interface AgentToolResult {
  ok: boolean;
  /** Returned to the model: ids, what changed, or a precise error with the fix. */
  text: string;
  /** One short line for the chat UI, e.g. "Added 4 nodes and 3 connections". */
  summary: string;
  /** mlch changes the tool made, in order. Empty for read-only tools and failures. */
  ops: MulchOp[];
  /** Images returned to the model with the text (base64, no data: prefix). */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface AgentToolRuntime {
  definitions: AgentToolDefinition[];
  /** Validates args against the tool's shape. Never throws: failures come back as ok:false. */
  execute(name: string, args: unknown): Promise<AgentToolResult>;
}

