// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fetchImage, privateAddress } from "../fetchFile";

describe("images from the web", () => {
  it("never reaches this Mac or a local network", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(privateAddress(address)).toBe(true);
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(privateAddress(address)).toBe(false);
    expect(await fetchImage("http://example.com/a.png")).toEqual({ error: "Only https addresses." });
    expect(await fetchImage("https://127.0.0.1/a.png")).toEqual({ error: "That address is on this Mac or a local network." });
    expect(await fetchImage("https://localhost/a.png")).toEqual({ error: "That address is on this Mac or a local network." });
  });
});
