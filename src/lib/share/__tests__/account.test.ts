// @vitest-environment node
import { describe, expect, it } from "vitest";
import { serverAddress } from "../account";

describe("an own server's address", () => {
  it("is an https origin, or http on this Mac", () => {
    expect(serverAddress("https://mlch-server.me.workers.dev/")).toBe("https://mlch-server.me.workers.dev");
    expect(serverAddress(" https://share.example.com/path ")).toBe("https://share.example.com");
    expect(serverAddress("http://localhost:8787")).toBe("http://localhost:8787");
    expect(serverAddress("http://example.com")).toBeUndefined();
    expect(serverAddress("https://user:pw@example.com")).toBeUndefined();
    expect(serverAddress("not a url")).toBeUndefined();
  });
});
