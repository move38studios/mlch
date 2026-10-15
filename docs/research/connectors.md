# Your Claude Code and Codex setup in mlch (2026-10-15)

## Intention

mlch is an interface on top of the person's own Claude Code or Codex. What they set up there works in mlch too: their CLAUDE.md / AGENTS.md, MCP servers, claude.ai connectors (Gmail, Drive, Calendar, …) and plugins. Someone who connected Gmail to Claude Code can say "pull the thread with Anna about the offsite" in mlch and it works.

Two things mlch still decides itself:

- **Who pays.** mlch runs on the subscription. An API key in the CLI's settings is ignored (see Billing), unless the person chooses an API key in Settings → AI.
- **What the AI may do on its own.** Tools that only read (search mail, get a file) run. Tools that act (send, delete, post, create) ask first, with a card in the conversation panel. The person's own allow rules in Claude Code count: what they allowed there runs without a card.

Off switch: Settings → AI, "Use my Claude Code and Codex setup". Off is the old lean mode (mlch's own tools only). The setup applies to work the person asked for (see Which work gets what).

## What was found

Until now the harness switched all of it off on purpose:

- Claude: `settingSources: []` (no CLAUDE.md, hooks, plugins, apiKeyHelper), `strictMcpConfig: true` (only mlch's MCP server), `permissionMode: "dontAsk"` with mlch's tools as the only allow rules.
- Codex: `--ignore-user-config` for making, every `mcp_servers` entry disabled per thread, `features.apps/plugins/hooks=false`, `project_doc_max_bytes=0`.

Tests with Claude Code 2.1.300 (`claude -p`, asking which MCP servers it has):

| Started with | MCP servers |
|---|---|
| defaults | all 9 (claude.ai connectors, chrome-devtools, a plugin's) |
| `--setting-sources=user` | all 9 |
| `--setting-sources=user --strict-mcp-config` | none |
| `--setting-sources=` (with or without strict) | none |

So claude.ai connectors need user settings loaded and strict MCP config off. Other findings:

- CLAUDE.md loads with user settings even when the system prompt is replaced (`--system-prompt`).
- Claude Code turns claude.ai connectors off whenever an API key is in use ("claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set").
- Flag settings (`--settings`, the SDK's `settings` option) override user settings: `{"apiKeyHelper": ""}` stops a helper (`apiKeySource` goes from `apiKeyHelper` to `none`), `{"env": {"ANTHROPIC_API_KEY": ""}}` stops a key set in settings' `env`. `{"apiKeyHelper": null}` does not.
- `canUseTool` tells MCP servers apart by `mcpServer.source` (`sdk` is ours; `claudeai`, `user`, `plugin`, … are the person's). `mcpServerStatus()` lists each server's tools with `annotations.readOnly`.

## Billing

- Subscription (default): mlch loads the person's settings and lays its own flag settings on top: `apiKeyHelper: ""` and every billing variable in the settings' `env` blanked (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, gateway and Bedrock keys). The process environment is stripped as before (env.ts). If Claude Code still reports an API key source (a managed policy, a new kind of source), the turn stops as before.
- When the person's Claude Code is set to pay with an API key, Settings → AI says so and that mlch uses the subscription instead; choosing API key there is how to pay per token.
- The extra-usage guard (no turn that could be billed as extra usage) is unchanged.

## Which work gets what

| Work | The person's setup (settings, CLAUDE.md / AGENTS.md, hooks, plugins, MCP servers, connectors) |
|---|---|
| Instructions, research, making, call notes | yes (jobs.ts `ownSetup`) |
| Capture, enrichment, naming, images, ingest, folders | no |

Capture and enrichment run on everything said. Loading the person's settings costs time on every turn (measured with Claude Code 2.1.300, `claude -p` with no tools: 2.3–2.6 s with no settings, 4.1–5.2 s with user settings and plugins), and these lanes must never act unasked.

## Permissions (Claude Code)

- `permissionMode: "default"` with `canUseTool` (`connectorPermissions` in claudeHarness.ts), instead of `dontAsk`.
- mlch's tools, web tools and the making workspace's rules are allowed as before.
- A connector tool marked read-only (`mcpServerStatus()` annotations) runs. Any other connector tool asks: the job shows a card in the conversation ("Gmail: create draft", the arguments) with Allow and Deny, and the turn waits. Deny tells the model the person said no. Stopping the job denies.
- Anything else Claude Code would ask about is refused, as `dontAsk` did.
- The person's allow rules from their settings apply first, as in Claude Code. Because those could allow `Write` or `Edit` anywhere, a `PreToolUse` hook (`workspaceEditHook`) refuses file edits outside the making workspace whatever the rules say.
- Built-in tools stay limited by `tools` (no shell outside the sandbox, no Agent, no Skill).

## Codex

Researched against Codex 0.157.0 (generated protocol types, its source, live runs against a fake MCP server).

- Per thread, with the setup: the person's `mcp_servers` stay on, with `default_tools_approval_mode = "writes"` unless they chose a mode (Codex then asks before any tool not marked read-only). `node_repl` and `computer-use` stay off: they run code on the Mac. `approvalPolicy: "on-request"` and `approvalsReviewer: "user"` (otherwise a config with `approvals_reviewer = "auto_review"` lets Codex's own reviewer approve). Their AGENTS.md applies (`CODEX_SETUP_INSTRUCTIONS` replaces the instruction to ignore it).
- Codex asks with `mcpServer/elicitation/request` (`_meta.codex_approval_kind: "mcp_tool_call"`); the tool name comes from the `mcpToolCall` item started just before. mlch answers `accept` or `decline`, never `persist` (that would write to config.toml). A server's own forms are declined.
- Not yet: ChatGPT apps (`features.apps`, the `codex_apps` server; the tested account has only OpenAI's own apps), and making turns (`codex exec` still ignores the user config: loading it would bring their model provider and sandbox settings).

## Tested

- Claude Code, live: a Gmail search ran without asking; a Gmail draft asked, was denied, and the model said nothing was created (`scripts/scenarios/connectors.cjs` in the app).
- Codex, live: a turn with the setup starts and runs (no connectors on the tested account).

## Risks and notes

- Email and web pages can carry instructions aimed at the AI. Acting tools always ask, so such text cannot send or delete on its own.
- Hooks and plugins run on the person's instructions, research and making. A slow or broken hook shows there; turning the setup off in Settings is the escape.
- The CLI's environment is still stripped of secrets, so an MCP server that reads a token from the shell environment won't find it (Finder-started apps have no shell environment anyway). Servers that keep their own credentials (claude.ai connectors, `env` in their config) work.
