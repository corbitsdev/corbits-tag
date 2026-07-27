/**
 * Minimal logging seam for this package.
 *
 * `tag-slack` fails soft on purpose (a missing scope, a stale bot, a
 * transient API error must never drop a mention or block an answer), which
 * means it has several places that only ever *warn*. Those warnings used to
 * go straight to `console.warn`, which bypasses whatever log routing/
 * redaction a host already has and can't be silenced in tests without
 * monkey-patching the global console. This is the one seam every call site
 * goes through instead.
 */

export type Logger = {
  warn(message: string): void;
};

/** Default logger: `console.warn`, same behavior as before this seam existed. */
export const defaultLogger: Logger = {
  warn: (message) => console.warn(message),
};
