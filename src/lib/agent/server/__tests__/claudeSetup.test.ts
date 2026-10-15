// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { apiKeyNotice, mcpToolName, readClaudeUserBilling, subscriptionOverrides } from "../claudeSetup";

const dir = mkdtempSync(path.join(os.tmpdir(), "mlch-claude-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the person's Claude Code billing settings", () => {
  it("finds an apiKeyHelper and billing variables, and leaves model names alone", () => {
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ apiKeyHelper: "~/bin/key.sh", env: { ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_MODEL: "opus", CLAUDE_CODE_USE_VERTEX: "1", GITHUB_TOKEN: "x" } }),
    );
    const billing = readClaudeUserBilling({ CLAUDE_CONFIG_DIR: dir });
    expect(billing).toEqual({ apiKeyHelper: true, env: ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_VERTEX"] });
    const overrides = subscriptionOverrides(billing);
    expect(overrides.apiKeyHelper).toBe("");
    expect(overrides.env).toMatchObject({ ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_VERTEX: "" });
    expect(overrides.env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(overrides.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(apiKeyNotice(billing)).toMatch(/apiKeyHelper/);
  });

  it("is quiet without settings", () => {
    const billing = readClaudeUserBilling({ CLAUDE_CONFIG_DIR: path.join(dir, "missing") });
    expect(billing).toEqual({ apiKeyHelper: false, env: [] });
    expect(apiKeyNotice(billing)).toBeUndefined();
  });

  it("names MCP tools by their own name", () => {
    expect(mcpToolName("mcp__claude_ai_Gmail__send_message")).toBe("send_message");
    expect(mcpToolName("send_message")).toBe("send_message");
  });
});
