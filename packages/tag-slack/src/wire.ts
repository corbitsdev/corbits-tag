/**
 * Handler wiring, split from the mount so it is testable without a real
 * Slack adapter: tests hand in a structural `TagBot` fake, simulate a
 * mention, and assert the normalized dispatch.
 */
import type {
  PriorTurn,
  TagAuthor,
  TagDispatch,
  TagEvent,
  TagThread,
} from "@corbits/tag-core";
import { defaultLogger, type Logger } from "./logger.ts";
import type {
  SlackUserLookup,
  SlackUserProfile,
} from "./slack-users.ts";

/** The slice of a Chat SDK message this package reads to build a `PriorTurn`. */
export type BotHistoryMessage = {
  text: string;
  author: { userId: string; isMe: boolean };
};

/** The slice of a Chat SDK thread this package relies on (structural). */
export type BotThread = {
  id: string;
  post(text: string): Promise<unknown>;
  subscribe(): Promise<void>;
  /**
   * Refetch the thread's recent messages (Chat SDK: backed by
   * `conversations.replies` on Slack, via the same bot token/client
   * `createSlackUserLookup` uses). Optional: fakes in tests, and any Chat
   * SDK bot too old to have it, simply don't provide it.
   */
  refresh?(): Promise<void>;
  /** Populated by `refresh()`, oldest-first. */
  recentMessages?: BotHistoryMessage[];
};

/**
 * The slice of a Chat SDK message this package relies on (structural). The
 * Chat SDK's author carries no identity fields — email, emailVerified and
 * isRestricted are populated separately via `userLookup`.
 */
export type BotMessage = {
  text: string;
  author: Omit<TagAuthor, "email" | "emailVerified" | "isRestricted"> & { isMe: boolean };
  isMention?: boolean;
};

/** The slice of the Chat SDK bot this package relies on (structural). */
export type TagBot = {
  onNewMention(
    handler: (thread: BotThread, message: BotMessage) => Promise<void>,
  ): void;
  onSubscribedMessage(
    handler: (thread: BotThread, message: BotMessage) => Promise<void>,
  ): void;
  webhooks: Record<string, (request: Request) => Promise<Response>>;
};

export type WireOptions = TagDispatch & {
  subscribeOnMention?: boolean;
  /**
   * Resolves a Slack user id to email/restriction info (see
   * `createSlackUserLookup`). Omit to leave `email` undefined and
   * `emailVerified`/`isRestricted` `"unknown"` on every event — hosts that
   * don't map authors to identities don't need it.
   *
   * May reject; a rejection is logged and treated as unresolved rather than
   * dropping the message.
   */
  userLookup?: SlackUserLookup;
  /**
   * Fetch this thread's prior messages and attach them to every `TagEvent`
   * as `priorTurns`. Off by default: it costs one extra Slack API call per
   * mention, and a host that doesn't want conversation memory shouldn't pay
   * for it. `maxMessages` bounds the mechanism's own fetch (default 50) —
   * it is not the host's turn budget; a host decides how many of the
   * returned turns to actually use.
   */
  threadHistory?: { maxMessages?: number };
  /**
   * Logging seam for this package's fail-soft paths (a missing scope, a
   * failed history refresh, a userLookup rejection). Defaults to
   * `console.warn`; supply your own to route these into a host's existing
   * log pipeline or to silence them in tests.
   */
  logger?: Logger;
};

const DEFAULT_MAX_HISTORY_MESSAGES = 50;

/**
 * Fetches prior messages for `thread` and maps them to `PriorTurn`s,
 * oldest-first, excluding the message that triggered this event.
 *
 * `refresh()` re-populates `recentMessages` from the platform (Slack:
 * `conversations.replies`, same bot token as `createSlackUserLookup`). Never
 * throws: a failed fetch means no history, not a dropped mention.
 */
async function fetchPriorTurns(
  thread: BotThread,
  current: BotMessage,
  maxMessages: number,
  logger: Logger,
): Promise<PriorTurn[]> {
  if (typeof thread.refresh !== "function") return [];
  try {
    await thread.refresh();
  } catch (err) {
    logger.warn(
      `tag-slack: thread history refresh failed for ${thread.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const messages = thread.recentMessages ?? [];
  // The just-arrived message is already in Slack's history by the time the
  // webhook fires, so it is normally the last entry here — drop it so a host
  // rendering `priorTurns` into a prompt never sees the current question
  // twice.
  const isCurrent =
    messages.length > 0 &&
    messages[messages.length - 1]!.text === current.text &&
    messages[messages.length - 1]!.author.userId === current.author.userId;
  const prior = isCurrent ? messages.slice(0, -1) : messages;

  return prior.slice(-maxMessages).map((m) => ({
    authorId: m.author.userId,
    text: m.text,
    isBot: m.author.isMe,
  }));
}

/**
 * Runs the host's lookup, returning `undefined` when identity could not be
 * established for any reason.
 *
 * `userLookup` is host-supplied and public API, so it may throw. An unguarded
 * rejection here propagates out of the event handler and drops the mention
 * entirely — silently, and after the thread has already been subscribed.
 */
async function lookupProfile(
  userId: string,
  userLookup: SlackUserLookup | undefined,
  logger: Logger,
): Promise<SlackUserProfile | undefined> {
  if (!userLookup) return undefined;
  try {
    const result = await userLookup(userId);
    return result.ok ? result.profile : undefined;
  } catch (err) {
    logger.warn(
      `tag-slack: userLookup threw for ${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

async function toEvent(
  message: BotMessage,
  thread: BotThread,
  isMention: boolean,
  userLookup: SlackUserLookup | undefined,
  threadHistory: { maxMessages?: number } | undefined,
  logger: Logger,
): Promise<TagEvent> {
  const { userId, userName, fullName, isBot } = message.author;
  const profile = await lookupProfile(userId, userLookup, logger);
  const author: TagAuthor = {
    userId,
    userName,
    fullName,
    // The platform event's `isBot` can be "unknown"; a `users.info` lookup
    // that actually resolved is a more authoritative source for that one
    // fact than an ambiguous platform report, so it takes over when the
    // platform couldn't say. A confirmed platform-reported value is never
    // overridden by the profile.
    isBot: isBot === "unknown" && profile !== undefined ? profile.isBot : isBot,
    // Unresolved stays "unknown" rather than defaulting. `false` here would
    // mean a rate limit reads as "not a guest, email not confirmed" — facts
    // Slack never told us.
    emailVerified: profile === undefined ? "unknown" : profile.emailVerified,
    isRestricted: profile === undefined ? "unknown" : profile.isRestricted,
    ...(profile?.email !== undefined ? { email: profile.email } : {}),
  };
  const priorTurns = threadHistory
    ? await fetchPriorTurns(
        thread,
        message,
        threadHistory.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES,
        logger,
      )
    : undefined;
  return {
    platform: "slack",
    threadId: thread.id,
    text: message.text,
    author,
    isMention,
    trigger: isMention ? "mention" : "ambient",
    ...(priorTurns !== undefined ? { priorTurns } : {}),
  };
}

function toTagThread(thread: BotThread): TagThread {
  return {
    id: thread.id,
    post: async (text) => {
      await thread.post(text);
    },
    subscribe: () => thread.subscribe(),
  };
}

/** Register mention + subscribed-message handlers on the bot. */
export function wireBot(bot: TagBot, options: WireOptions): void {
  const logger = options.logger ?? defaultLogger;

  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    if (options.subscribeOnMention !== false) {
      await thread.subscribe();
    }
    const event = await toEvent(
      message,
      thread,
      true,
      options.userLookup,
      options.threadHistory,
      logger,
    );
    await options.onTag(event, toTagThread(thread));
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    // Mentions inside subscribed threads still land on onTag: an explicit
    // @mention always gets the mention treatment, ambient traffic doesn't.
    if (message.isMention === true) {
      const event = await toEvent(
        message,
        thread,
        true,
        options.userLookup,
        options.threadHistory,
        logger,
      );
      await options.onTag(event, toTagThread(thread));
      return;
    }
    // Ambient delivery is for other humans talking in a thread the bot
    // already joined, not for other bots/integrations posting into it — a
    // bot replying to another bot is exactly the loop this mechanism must
    // never create.
    if (options.onThreadMessage && message.author.isBot !== true) {
      const event = await toEvent(
        message,
        thread,
        false,
        options.userLookup,
        options.threadHistory,
        logger,
      );
      await options.onThreadMessage(event, toTagThread(thread));
    }
  });
}
