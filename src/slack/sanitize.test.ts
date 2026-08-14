import { describe, expect, test } from "bun:test";
import { detectInfraErrorReply, sanitizeOutgoingText } from "./sanitize.ts";

describe("sanitizeOutgoingText", () => {
  test("strips a single wrapping <div> tag, keeping inner text (artifact 1)", () => {
    const input =
      '<div dir="auto">Diligence brief for Harvey AI initiated. Run ID: abc123</div>';
    expect(sanitizeOutgoingText(input)).toBe(
      "Diligence brief for Harvey AI initiated. Run ID: abc123",
    );
  });

  test("unwraps a whole-reply ```json fence around prose (artifact 2)", () => {
    const input =
      "```json\nThe diligence brief for Harvey AI is ready. Let me know if you want the full PDF.\n```";
    expect(sanitizeOutgoingText(input)).toBe(
      "The diligence brief for Harvey AI is ready. Let me know if you want the full PDF.",
    );
  });

  test("unescapes backslash-escaped underscores (artifact 3)", () => {
    const input = "ins\\_dep\\_ping-ai@scout.localhost";
    expect(sanitizeOutgoingText(input)).toBe("ins_dep_ping-ai@scout.localhost");
  });

  test("passes an infra-error message through unchanged (wire.ts swaps it, not sanitize)", () => {
    const input =
      "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: invalid message content type: <nil>";
    expect(sanitizeOutgoingText(input)).toBe(input);
  });

  test("drops a leading fenced JSON input-echo block before real prose (artifact 5)", () => {
    const input =
      '```json\n{"company":"ping ai","threadRef":"C1:123.456"}\n```\nDiligence brief for ping ai is underway.';
    expect(sanitizeOutgoingText(input)).toBe(
      "Diligence brief for ping ai is underway.",
    );
  });

  test("passes a normal mrkdwn reply with links/bold through byte-identical", () => {
    const input =
      "Here's the update: *bold point*, see <https://example.com|the doc> for details.";
    expect(sanitizeOutgoingText(input)).toBe(input);
  });

  test("leaves a legitimate whole-reply JSON/code fence untouched", () => {
    const input = '```json\n{"status":"ok","count":3}\n```';
    expect(sanitizeOutgoingText(input)).toBe(input);
  });

  test("leaves a legitimate leading JSON fence untouched when the rest isn't prose-shaped follow-up (still just data)", () => {
    const input = '```json\n{"a":1}\n```\n```json\n{"b":2}\n```';
    expect(sanitizeOutgoingText(input)).toBe(input);
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeOutgoingText("  hello there  \n")).toBe("hello there");
  });

  test("leaves a whole-reply fence alone when its content is structured but unparseable (single-quoted pseudo-JSON)", () => {
    const input = "```json\n{status: 'ok', count: 3}\n```";
    expect(sanitizeOutgoingText(input)).toBe(input);
  });
});

describe("detectInfraErrorReply", () => {
  test("matches the observed unrecoverable inference error text (artifact 4)", () => {
    const input =
      "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: invalid message content type: <nil>";
    expect(detectInfraErrorReply(input)).toBe(true);
  });

  test("matches a bracketed HTTP status that dominates the whole reply", () => {
    expect(detectInfraErrorReply("[HTTP 503]")).toBe(true);
  });

  test("matches a crash-mid-invocation marker at the start of the reply", () => {
    expect(detectInfraErrorReply("crash-mid-invocation while streaming")).toBe(
      true,
    );
  });

  test("does not match a normal reply", () => {
    expect(
      detectInfraErrorReply("Here's the diligence brief you asked for."),
    ).toBe(false);
  });

  test("does not swallow prose that merely QUOTES an error (reviewer repro 1)", () => {
    const input =
      "Per the incident report [HTTP 503] the vendor's endpoint was down… but service has since recovered.";
    expect(detectInfraErrorReply(input)).toBe(false);
  });

  test("does not swallow prose that USEFULLY REPORTS a failure (reviewer repro 2)", () => {
    const input =
      "Diligence run finished with an unrecoverable inference error while summarizing the 10-K; you may want to retry.";
    expect(detectInfraErrorReply(input)).toBe(false);
  });

  test("still replaces the verbatim raw failure dump (artifact 4)", () => {
    const input =
      "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: invalid message content type: <nil>";
    expect(detectInfraErrorReply(input)).toBe(true);
  });
});
