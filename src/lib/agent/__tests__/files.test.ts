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

  it("refuses escapes and private places", () => {
    for (const p of ["../etc/passwd", "/etc/passwd", ".ssh/id_rsa", ".aws/credentials", "Library/Keychains/login.keychain-db", "dev/app/.env", "dev/app/.env.local", "dev/certs/server.pem", ".mlch/agent/x"]) {
      expect(resolveReadable(home, p), p).toBeUndefined();
    }
  });
});
