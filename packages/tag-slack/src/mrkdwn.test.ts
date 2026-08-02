import { describe, expect, test } from "bun:test";
import { mdToMrkdwn } from "./mrkdwn.ts";

describe("mdToMrkdwn", () => {
  test("converts double-asterisk and double-underscore bold to single asterisks", () => {
    expect(mdToMrkdwn("This is **bold** text")).toBe("This is *bold* text");
    expect(mdToMrkdwn("This is __bold__ text")).toBe("This is *bold* text");
  });

  test("converts markdown links to Slack link syntax", () => {
    expect(mdToMrkdwn("See [the docs](https://example.com/docs) for more.")).toBe(
      "See <https://example.com/docs|the docs> for more.",
    );
  });

  test("leaves image markdown untouched instead of corrupting it into a link", () => {
    const input = "![a diagram](https://example.com/diagram.png)";
    expect(mdToMrkdwn(input)).toBe(input);
  });

  test("converts a normal link adjacent to an untouched image", () => {
    const input =
      "![a diagram](https://example.com/diagram.png) see [the docs](https://example.com/docs)";
    expect(mdToMrkdwn(input)).toBe(
      "![a diagram](https://example.com/diagram.png) see <https://example.com/docs|the docs>",
    );
  });

  test("converts double-tilde strikethrough to single-tilde", () => {
    expect(mdToMrkdwn("This is ~~wrong~~ right")).toBe("This is ~wrong~ right");
  });

  test("converts leading header lines to bold plain lines", () => {
    expect(mdToMrkdwn("# Title")).toBe("*Title*");
    expect(mdToMrkdwn("## Subtitle\nbody text")).toBe("*Subtitle*\nbody text");
  });

  test("converts '-' and '*' list markers to Slack bullets", () => {
    expect(mdToMrkdwn("- first\n- second")).toBe("• first\n• second");
    expect(mdToMrkdwn("* first\n* second")).toBe("• first\n• second");
  });

  test("preserves indentation when converting bullets", () => {
    expect(mdToMrkdwn("  - nested item")).toBe("  • nested item");
  });

  test("leaves fenced code blocks completely untouched", () => {
    const input =
      "Before\n```\n**not bold** [not](a-link) # not a header\n- not a bullet\n```\nAfter";
    const result = mdToMrkdwn(input);
    expect(result).toContain(
      "```\n**not bold** [not](a-link) # not a header\n- not a bullet\n```",
    );
    expect(result.startsWith("Before")).toBe(true);
    expect(result.endsWith("After")).toBe(true);
  });

  test("leaves inline code spans completely untouched", () => {
    const input = "Use `**not-bold**` in code.";
    expect(mdToMrkdwn(input)).toBe(input);
  });

  test("does not touch a bare '*' that isn't part of a bold pair", () => {
    expect(mdToMrkdwn("5 * 3 = 15")).toBe("5 * 3 = 15");
  });

  test("combines multiple constructs in one message", () => {
    const input = "# Summary\n**Key finding**: see [source](https://example.com)\n- point one\n- point two";
    const expected =
      "*Summary*\n*Key finding*: see <https://example.com|source>\n• point one\n• point two";
    expect(mdToMrkdwn(input)).toBe(expected);
  });

  test("is a no-op on already-clean mrkdwn text", () => {
    const input = "Answer: *bold* and _italic_ with <https://example.com|Title>.";
    expect(mdToMrkdwn(input)).toBe(input);
  });

  test("does not corrupt literal text that happens to look like an internal placeholder", () => {
    // Regression: text that merely *looks* like a placeholder (no NUL
    // delimiter) must not be touched by restore(). See the NUL-delimiter
    // rationale on the placeholder constants in mrkdwn.ts.
    const input =
      "Here is code: `x = 1` and also this literal text: MRKDWN_CODE_0 (not code)";
    expect(mdToMrkdwn(input)).toBe(
      "Here is code: `x = 1` and also this literal text: MRKDWN_CODE_0 (not code)",
    );
  });
});
