/**
 * `sanitizeOutgoingText` / `detectInfraErrorReply` — a defensive cleanup pass
 * for outgoing `TagThread.post()` text, applied in `wire.ts`'s `toTagThread`
 * BEFORE `mdToMrkdwn` (see `mrkdwn.ts`).
 *
 * This exists because upstream agent output occasionally carries artifacts
 * that were never meant for a human reader — raw HTML wrapper tags from a
 * browser-oriented renderer, a JSON tool-call payload leaking ahead of the
 * real prose reply, markdown escape sequences (`\_`, `\*`, `` \` ``) that
 * read as noise once rendered in Slack, and raw infra-error text (stack-ish
 * "[HTTP 400]" style messages) that shouldn't reach a Slack channel verbatim.
 * None of these are things `mdToMrkdwn` is responsible for — that function
 * converts *legitimate* markdown to mrkdwn; this module removes text that
 * should never have been markdown (or HTML, or an error dump) in the first
 * place.
 *
 * Heuristics, not a parser: this module makes a best effort using cheap
 * regex/ratio checks, favoring "leave it alone" when unsure — mangling a
 * legitimate code block a user asked for is worse than leaving one stray
 * artifact untouched.
 */

/**
 * Matches an entire string that is exactly one HTML element: an opening
 * `<div>`/`<span>`/`<p>` tag (with optional attributes), inner content, and
 * the matching closing tag. Anchored on both ends and non-greedy on the
 * inner content so a *single* wrapping pair is stripped — nested tags of the
 * same kind inside the content are left alone; this module only peels away
 * one outer wrapper, matching the observed artifact
 * (`<div dir="auto">...</div>`), not general HTML sanitization.
 */
const WRAPPING_HTML_TAG_PATTERN =
  /^<(div|span|p)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/i;

/** Strips a single wrapping `<div>`/`<span>`/`<p>` pair, keeping inner text. */
function stripWrappingHtmlTag(text: string): string {
  const match = WRAPPING_HTML_TAG_PATTERN.exec(text.trim());
  return match ? (match[2] ?? "") : text;
}

/**
 * Matches a fenced code block (```lang\n...\n```) that spans the ENTIRE
 * string, capturing the language tag (if any) and the fence's inner content.
 */
const WHOLE_FENCE_PATTERN = /^```(\w*)\n?([\s\S]*?)\n?```$/;

/**
 * Matches a fenced code block at the very START of the string, followed by
 * one or more remaining, non-empty characters (the "real" reply).
 */
const LEADING_FENCE_PATTERN = /^```(\w*)\n?([\s\S]*?)\n?```\s*\n*([\s\S]*)$/;

/**
 * Ratio of JSON/code "punctuation" characters (braces, brackets, colons,
 * quotes used as delimiters, angle brackets) to non-whitespace characters.
 * Prose runs low (stray punctuation only); JSON/code payloads run high
 * because nearly every token is wrapped in structural symbols.
 */
function symbolRatio(content: string): number {
  const chars = content.replace(/\s/g, "");
  if (chars.length === 0) return 0;
  const symbols = (chars.match(/[{}[\]":,;<>]/g) ?? []).length;
  return symbols / chars.length;
}

/**
 * Best-effort "is this JSON or code, not prose" check: valid JSON always
 * counts, otherwise falls back to the symbol-ratio heuristic above. Used to
 * decide whether a fence is a data/tool-call payload (leave it, or drop it
 * as a leading artifact) vs. an agent's prose reply that got accidentally
 * wrapped in a fence (unwrap it).
 */
function looksLikeJsonOrCode(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not valid JSON — fall through to the ratio heuristic below rather
      // than assuming prose just because parsing failed (e.g. truncated
      // JSON is still clearly not prose).
    }
  }
  return symbolRatio(trimmed) > 0.15;
}

/**
 * Whether `content` LOOKS structured (wrapped in `{...}`/`[...]`) but is NOT
 * valid JSON — e.g. single-quoted pseudo-JSON like `{status: 'ok', count:
 * 3}`. This is deliberately its own category, distinct from both
 * `looksLikeJsonOrCode` (true JSON/code) and prose: it is ambiguous enough
 * (a model's mangled attempt at structured output? a deliberately-shared
 * snippet?) that guessing either way risks mangling real content. Callers
 * that must pick between "safe to unwrap/drop" and "leave alone" should
 * treat this as "leave alone" — see `unwrapProseFence`.
 */
function looksStructuredButUnparseable(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  const isBraceWrapped = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isBracketWrapped = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (!isBraceWrapped && !isBracketWrapped) return false;
  try {
    JSON.parse(trimmed);
    return false; // valid JSON — that's `looksLikeJsonOrCode`'s territory, not this.
  } catch {
    return true;
  }
}

/**
 * Drops a LEADING fenced block when it looks like a JSON/tool-call payload
 * AND there is non-empty prose after it — the observed "input-echo" leak
 * (artifact 5): a `{"company":...}` block the model echoed back before its
 * real answer. A leading fence with no prose after it (the whole reply is
 * the fence) is left for `unwrapProseFence`/left alone entirely — dropping
 * it here would silently discard the only content in the reply.
 */
function dropLeadingFencedJsonBlock(text: string): string {
  const match = LEADING_FENCE_PATTERN.exec(text.trim());
  if (!match) return text;
  const [, , fenceContent, rest] = match;
  if (rest === undefined || rest.trim().length === 0) return text;
  if (!looksLikeJsonOrCode(fenceContent ?? "")) return text;
  // The remainder must itself be prose, not more JSON/code (e.g. two data
  // blocks in a row) — otherwise this isn't the "input echo before the real
  // answer" case, and dropping the first block would just discard data.
  if (looksLikeJsonOrCode(rest)) return text;
  return rest.trim();
}

/**
 * Unwraps a fence that spans the WHOLE reply when its content reads as
 * prose, not JSON/code — the observed "replies wrapped in ```json fences"
 * artifact (artifact 2): the model tagged a plain-English answer as a
 * ```json (or plain ```) block for no structural reason. A whole-reply fence
 * whose content genuinely looks like JSON/code is left untouched — that's
 * legitimate content a user asked for (a code sample, a payload dump),
 * distinguishable from the mistake this targets only by asking "is this
 * actually prose".
 */
function unwrapProseFence(text: string): string {
  const match = WHOLE_FENCE_PATTERN.exec(text.trim());
  if (!match) return text;
  const content = match[2] ?? "";
  if (looksLikeJsonOrCode(content)) return text;
  // Ambiguous structured-but-unparseable content (e.g. single-quoted
  // pseudo-JSON) — bias to no-op rather than guess it's prose. See
  // `looksStructuredButUnparseable`.
  if (looksStructuredButUnparseable(content)) return text;
  return content.trim();
}

/**
 * Matches a backslash-escaped `_`, `*`, or `` ` `` — markdown escape
 * sequences some model output emits (e.g. `ins\_dep\_ping-ai@scout.localhost`,
 * artifact 3) that read as literal noise once posted to Slack, which has no
 * such escaping convention of its own. Deliberately narrow: only these three
 * characters, so an unrelated backslash (e.g. in a Windows path or regex a
 * user is legitimately sharing) is never touched.
 */
const MARKDOWN_ESCAPE_PATTERN = /\\([_*`])/g;

/**
 * Un-escapes `\_`, `\*`, `` \` `` sequences back to their plain characters.
 *
 * Known tradeoff, accepted: un-escaping `\*` can turn a genuinely-intended
 * literal asterisk (someone escaped it on purpose, e.g. `2 \* 3`) into
 * mrkdwn bold once `mdToMrkdwn` sees the bare `*`. Every artifact actually
 * observed reaching Slack was an escaped underscore in an address/identifier
 * (`ins\_dep\_ping-ai@scout.localhost`), never an intentional escape — so
 * this optimizes for the artifact that's actually happening rather than a
 * hypothetical one.
 */
function unescapeMarkdownEscapes(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_PATTERN, "$1");
}

/**
 * Cleans up known model-output artifacts before a reply is handed to
 * `mdToMrkdwn` and posted to Slack: a single wrapping HTML tag, a leading
 * JSON/tool-call fence followed by prose, a whole-reply fence wrapping plain
 * prose, and backslash-escaped markdown punctuation. Order matters — HTML
 * unwrapping first (so a `<div>` wrapping a fenced block still gets the
 * fence handling), then the leading-fence drop (more specific: fence +
 * trailing prose) before the whole-fence unwrap (fence with nothing else),
 * then escape cleanup, then a final trim.
 *
 * Pure function: no I/O, safe to call on every outgoing message. A normal
 * mrkdwn reply — links, bold, no stray fences/tags/escapes — passes through
 * unchanged (aside from the trailing `.trim()`).
 */
export function sanitizeOutgoingText(text: string): string {
  const withoutHtmlWrap = stripWrappingHtmlTag(text);
  const withoutLeadingJsonFence = dropLeadingFencedJsonBlock(withoutHtmlWrap);
  const withoutWholeFenceWrap = unwrapProseFence(withoutLeadingJsonFence);
  const unescaped = unescapeMarkdownEscapes(withoutWholeFenceWrap);
  return unescaped.trim();
}

/**
 * Matches infra-error-shaped substrings: an "unrecoverable inference error",
 * a bracketed HTTP status (`[HTTP 400]`), or a mid-invocation crash marker.
 * On its own this is NOT sufficient to call something a raw failure dump —
 * see `detectInfraErrorReply`, which requires this to dominate the reply,
 * not merely appear in it.
 */
const INFRA_ERROR_PATTERN =
  /unrecoverable inference error|\[HTTP \d{3}\]|crash-mid-invocation/i;

/**
 * Full-shape signatures: the reply doesn't just MENTION an infra error, it
 * IS one — a raw failure dump verbatim from the runtime, not the model's own
 * prose. Anchored to the start of the (trimmed) text, not a bare substring
 * match, precisely so legitimate prose that happens to open with something
 * else first is never caught here just because it goes on to reference an
 * error later.
 */
const FULL_DUMP_SIGNATURES: RegExp[] = [
  /^This agent could not complete your request due to an unrecoverable inference error\b/i,
  /^crash-mid-invocation\b/i,
];

/** Above this fraction of the trimmed text, an error-shaped match is presumed to BE the reply, not merely mentioned by it. */
const DOMINANCE_THRESHOLD = 0.6;

/**
 * Whether `text` IS a raw infra-error dump that should never reach a Slack
 * user verbatim — as opposed to ordinary prose that merely QUOTES or
 * REPORTS an error, which must pass through untouched (a diligence run
 * usefully telling a user "this failed because of an unrecoverable
 * inference error, you may want to retry" is exactly the kind of message
 * this must NOT swallow).
 *
 * Two ways to qualify: the trimmed text starts with a known full-dump
 * signature (see `FULL_DUMP_SIGNATURES`), OR the error-shaped substring
 * itself accounts for more than `DOMINANCE_THRESHOLD` of the trimmed text
 * — i.e. the match effectively IS the message, not a clause within a much
 * longer sentence. A short "[HTTP 503] gateway timeout" is almost entirely
 * its error signature and gets replaced; "Per the incident report [HTTP
 * 503] the vendor's endpoint was down, but service has since recovered" has
 * the same substring inside a much longer, unrelated sentence and is left
 * alone.
 */
export function detectInfraErrorReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  if (FULL_DUMP_SIGNATURES.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  const match = INFRA_ERROR_PATTERN.exec(trimmed);
  if (!match) return false;
  return match[0].length / trimmed.length > DOMINANCE_THRESHOLD;
}
