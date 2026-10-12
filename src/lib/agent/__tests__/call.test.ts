// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callMarkdown } from "../jobs";

const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).getTime();

describe("call transcript", () => {
  it("joins a speaker's lines, says when, and gives the length once the call ends", () => {
    const text = callMarkdown(
      [
        { id: "a", at: at(9, 0), text: "Thanks for joining.", source: "speech", speaker: "me" },
        { id: "b", at: at(9, 0), text: "Shall we start?", source: "speech", speaker: "me" },
        { id: "c", at: at(9, 2), text: "Yes.", source: "speech", speaker: "them" },
        { id: "d", at: at(9, 3), text: "Without the Mac's sound.", source: "speech" },
      ],
      at(9, 0),
      at(9, 30),
    );
    expect(text).toBe(
      "# Call, 12 Oct 2026, 09:00 to 09:30 (30 min)\n\n**Me** (09:00) Thanks for joining. Shall we start?\n\n**Them** (09:02) Yes.\n\n(09:03) Without the Mac's sound.",
    );
    expect(callMarkdown([], at(9, 0))).toBe("# Call, 12 Oct 2026, 09:00\n\nListening.");
  });
});
