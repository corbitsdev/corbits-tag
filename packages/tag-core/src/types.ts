/**
 * Transport-agnostic contracts for the Corbits Tag ingress.
 *
 * A "tag" is a mention of the bot in a thread on some chat platform. The
 * platform package (e.g. `@corbits/tag-slack`) normalizes the platform event
 * into a `TagEvent` and hands it to the host's dispatch alongside a
 * `TagThread` reply surface. The host decides what a tag means — this layer
 * never dispatches work itself.
 */

/** Who wrote the message that produced this event. */
export type TagAuthor = {
  /** Platform-unique user id (e.g. Slack user id). */
  userId: string;
  /** Handle used for @-mentions. */
  userName: string;
  /** Display name. */
  fullName: string;
  /** Whether the platform reports the author as a bot ("unknown" if it can't say). */
  isBot: boolean | "unknown";
  /**
   * The author's profile email, populated by the platform adapter when the
   * token has the scope to read it. `undefined` when the adapter lacks that
   * scope, the platform has no such concept, or the lookup failed — check
   * `emailVerified` to tell "they have no email" from "we could not ask".
   */
  email?: string;
  /**
   * Whether the platform confirmed the author controls `email` (Slack's
   * `is_email_confirmed`). `"unknown"` when the adapter could not find out.
   *
   * Hosts that create accounts keyed on this address must require `true`:
   * an unconfirmed profile email lets someone claim an address they do not
   * own, and anything later matching on that address inherits the claim.
   */
  emailVerified: boolean | "unknown";
  /**
   * Whether the platform reports the author as a guest or from another
   * workspace (Slack Connect, multi/single-channel guest). `"unknown"` when
   * the adapter could not find out — treat that as "not established", never
   * as `false`.
   */
  isRestricted: boolean | "unknown";
};

/**
 * One prior message in the thread, ordered oldest-first, surfaced so a host
 * can answer follow-up questions ("what sources did you use?") that only
 * make sense with the conversation so far. The platform package fetches and
 * normalizes these; whether to use them, how many, and how to render them
 * into a prompt is entirely the host's call.
 */
export type PriorTurn = {
  /** Platform-unique user id of whoever sent this prior message. */
  authorId: string;
  /** Message text, same normalization as `TagEvent.text`. */
  text: string;
  /** Whether this prior message was posted by the bot itself. */
  isBot: boolean;
};

/** A normalized mention or thread message, independent of platform. */
export type TagEvent = {
  /** Platform adapter name that produced the event (e.g. "slack"). */
  platform: string;
  /** Platform-scoped thread identifier — stable correlation key for the conversation. */
  threadId: string;
  /** Message text with platform markup normalized to plain text/markdown. */
  text: string;
  author: TagAuthor;
  /** True when the bot was explicitly @-mentioned; false for ambient subscribed messages. */
  isMention: boolean;
  /**
   * How this event was triggered: `"mention"` for an explicit @-mention,
   * `"ambient"` for an untagged message in a thread the bot already
   * subscribed to. Redundant with `isMention` today, but named so a host
   * reading `TagEvent` sees the addressed/untagged distinction as its own
   * concept rather than inferring it from a boolean meant for the mention
   * check specifically — future trigger kinds (if any) extend this field,
   * not `isMention`.
   */
  trigger: "mention" | "ambient";
  /**
   * Prior messages in this thread, oldest-first, not including the current
   * message. Populated only when the platform package was asked to fetch
   * thread history (see e.g. `@corbits/tag-slack`'s `threadHistory` option);
   * `undefined` when it wasn't asked to, empty when there simply is none.
   */
  priorTurns?: PriorTurn[];
};

/**
 * The reply surface for one thread. Deliberately minimal: post a reply,
 * subscribe to future messages. Platform packages may expose a richer raw
 * handle alongside it, but dispatch logic written against this type stays
 * portable across platforms.
 */
export type TagThread = {
  /** Stable thread identifier — matches `TagEvent.threadId`. */
  id: string;
  /** Post a message into the thread (markdown; platform package converts). */
  post(text: string): Promise<void>;
  /** Subscribe the bot to every future message in this thread. */
  subscribe(): Promise<void>;
};

/**
 * Host-supplied dispatch. `onTag` fires on explicit mentions; the optional
 * `onThreadMessage` fires for every message in threads the bot subscribed
 * to (ambient membership). Both receive the normalized event plus the reply
 * surface — whatever the host does (answer, start a workflow, stay silent)
 * is its own business.
 */
export type TagDispatch = {
  onTag: (event: TagEvent, thread: TagThread) => Promise<void>;
  onThreadMessage?: (event: TagEvent, thread: TagThread) => Promise<void>;
};
