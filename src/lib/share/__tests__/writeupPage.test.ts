// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeupPage } from "../writeupPage";

describe("a write-up as a page of its own", () => {
  it("renders its markdown under its title, keeps raw HTML as text, and reads on a phone", () => {
    const page = writeupPage("Call, 18 Oct 2026, 10:00", "# Call, 18 Oct 2026, 10:00\n\n**Me** (10:00) Hello <script>alert(1)</script>\n\n- one\n- two");
    expect(page).toContain('<meta name="mlch:kind" content="page">');
    expect(page).toContain('name="viewport"');
    expect(page.match(/<h1>/g)).toHaveLength(1);
    expect(page).toContain("<strong>Me</strong>");
    expect(page).toContain("<li>two</li>");
    expect(page).not.toContain("<script>alert");
  });
});
