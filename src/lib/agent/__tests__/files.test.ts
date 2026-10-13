// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReadable } from "../files";

const home = os.homedir();

describe("resolveReadable", () => {
  it("allows ordinary files under the root, relative or absolute", () => {
    expect(resolveReadable(home, "dev/briefbuster/README.md")).toBe(path.join(home, "dev/briefbuster/README.md"));
    expect(resolveReadable(home, "~/dev/x")).toBe(path.join(home, "dev/x"));
    expect(resolveReadable(home, path.join(home, "dev/x"))).toBe(path.join(home, "dev/x"));
    expect(resolveReadable(home, "")).toBe(home);
  });

  it("allows synced document folders inside Library (iCloud Drive, cloud storage)", () => {
    expect(resolveReadable(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/a.md")).toBe(path.join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/a.md"));
    expect(resolveReadable(home, "Library/CloudStorage/Dropbox/notes.md")).toBeDefined();
    expect(resolveReadable(home, "Library/Mobile Documents/x/.env")).toBeUndefined();
    expect(resolveReadable(home, "Library/Application Support/x")).toBeUndefined();
  });

  it("refuses escapes and private places", () => {
    for (const p of ["../etc/passwd", "/etc/passwd", ".ssh/id_rsa", ".aws/credentials", "Library/Keychains/login.keychain-db", "dev/app/.env", "dev/app/.env.local", "dev/certs/server.pem", ".mlch/agent/x"]) {
      expect(resolveReadable(home, p), p).toBeUndefined();
    }
  });
});

describe("files in made pages", () => {
  it("embeds a named image as a data: URI and refuses other kinds", async () => {
    const { embedFiles } = await import("../tools");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-"));
    fs.writeFileSync(path.join(dir, "logo.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    const done = await embedFiles('<img src="{{file:logo.svg}}"><img src="{{file:logo.svg}}">', dir);
    expect(done.problems).toEqual([]);
    expect(done.content).toBe(`<img src="data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}">`.repeat(2));
    const refused = await embedFiles("{{file:notes.txt}} {{file:missing.png}} {{file:../x.png}}", dir);
    expect(refused.problems).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
