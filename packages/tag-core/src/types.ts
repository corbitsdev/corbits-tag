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
