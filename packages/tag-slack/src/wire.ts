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

/** A message wrapped with edit/react capabilities (Chat SDK's `SentMessage`). */
export type BotSentMessage = {
  edit(content: string): Promise<unknown>;
  addReaction(emoji: string): Promise<unknown>;
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
  /**
   * Wrap a plain message as a `BotSentMessage` (Chat SDK:
   * `Thread.createSentMessageFromMessage`), giving it `edit`/`addReaction`.
   * Used for the `acknowledge` affordance below. Optional: fakes in tests,
   * and any bot too old to have it, simply don't provide it — `acknowledge`
   * silently no-ops without it.
   */
  createSentMessageFromMessage?(message: unknown): BotSentMessage;
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
  /**
   * React to a message the moment this package decides to dispatch it to the
   * host (`onTag`/`onThreadMessage`), so silence while the host works
   * doesn't read as "ignored". Off by default. Requires the bot token's
   * `reactions:write` scope; without it Slack's `reactions.add` errors,
   * which is logged once and otherwise swallowed — a missing scope never
   * blocks answering.
   */
  acknowledge?: boolean;
  /**
   * Emoji name used by `acknowledge` (Slack `reactions.add` short name, no
   * colons). Default: `"eyes"`. This is the one visible choice `acknowledge`
   * makes on the host's behalf, so it's configurable rather than fixed.
   */
  acknowledgeEmoji?: string;
  /**
   * Post a placeholder message immediately on dispatch, then transparently
   * edit it in place when the host's dispatch calls `thread.post()` with the
   * real answer, instead of posting a second message. Off by default.
   * Requires `thread.post()` to return something `edit`-capable (Chat SDK's
   * `SentMessage`); without that this silently does nothing and the host's
   * first `thread.post()` behaves as normal.
   */
  thinkingIndicator?: boolean;
  /**
   * Placeholder text posted by `thinkingIndicator`. Default: a neutral
   * "working on it" message with no bot name baked in — this package has no
   * opinion on what a host's bot is called.
   */
  thinkingIndicatorText?: string;
  /**
   * Text the placeholder is replaced with if the host's `onTag`/
   * `onThreadMessage` throws. A thread left reading the placeholder forever
   * would wrongly imply work is still in progress, so failures always
   * resolve it one way or another.
   */
  thinkingIndicatorErrorText?: string;
};

const DEFAULT_MAX_HISTORY_MESSAGES = 50;
const DEFAULT_ACKNOWLEDGE_EMOJI = "eyes";
const DEFAULT_THINKING_INDICATOR_TEXT = "_Working on it…_";
const DEFAULT_THINKING_INDICATOR_ERROR_TEXT =
  "Something went wrong while generating a response.";

/**
 * Logged at most once per process — a missing Slack scope doesn't need to
 * repeat on every message, just be visible that it's happening.
 */
let warnedMissingReactionsScope = false;

/**
 * Add the acknowledge reaction to `message`. Never throws: the most likely
 * failure is a bot token missing `reactions:write`, which must never block
 * answering.
 */
async function acknowledgeMessage(
  thread: BotThread,
  message: BotMessage,
  emoji: string,
  logger: Logger,
): Promise<void> {
  if (typeof thread.createSentMessageFromMessage !== "function") return;
  try {
    const sent = thread.createSentMessageFromMessage(message);
    await sent.addReaction(emoji);
  } catch (err) {
    if (!warnedMissingReactionsScope) {
      warnedMissingReactionsScope = true;
      logger.warn(
        "tag-slack: acknowledge reaction failed — the bot token likely lacks " +
          `the reactions:write scope. Add it (and reinstall the app) to keep ` +
          `this working. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

/**
 * Post a placeholder in `thread` and return a `post` function that edits it
 * in place instead of posting a new message. `undefined` when the
 * placeholder couldn't be posted/wrapped — callers fall back to a normal
 * `thread.post()`. Never throws.
 */
async function startThinkingIndicator(
  thread: BotThread,
  text: string,
  logger: Logger,
): Promise<((text: string) => Promise<void>) | undefined> {
  try {
    // Chat SDK's `Thread.post()` already returns a `SentMessage` (edit/
    // delete/addReaction) — no need to re-wrap it via
    // `createSentMessageFromMessage`, which is for plain incoming messages.
    const placeholder = await thread.post(text);
    if (
      typeof placeholder !== "object" ||
      placeholder === null ||
      typeof (placeholder as { edit?: unknown }).edit !== "function"
    ) {
      return undefined;
    }
    const sent = placeholder as BotSentMessage;
    return async (replacement: string) => {
      await sent.edit(replacement);
    };
  } catch (err) {
    logger.warn(
      `tag-slack: thinking-indicator placeholder failed, falling back to a ` +
        `normal reply: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

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

function toTagThread(
  thread: BotThread,
  postOverride?: (text: string) => Promise<void>,
): TagThread {
  return {
    id: thread.id,
    post:
      postOverride ??
      (async (text) => {
        await thread.post(text);
      }),
    subscribe: () => thread.subscribe(),
  };
}

/** What `prepareDispatch` hands back to `wireBot` for one dispatch. */
type PreparedDispatch = {
  /** The `TagThread` the host's handler should reply through. */
  tagThread: TagThread;
  /**
   * Call if the host's handler throws, to resolve a thinking-indicator
   * placeholder into an error rather than leaving it reading "thinking"
   * forever. No-op when no placeholder was started.
   */
  notifyFailure(): Promise<void>;
};

/**
 * Apply the opt-in `acknowledge`/`thinkingIndicator` affordances (see
 * `WireOptions`) for a message about to be dispatched to the host, and build
 * the `TagThread` the host's handler should reply through — its `post()`
 * edits the thinking placeholder in place when one was started, otherwise
 * behaves like a normal reply.
 */
async function prepareDispatch(
  thread: BotThread,
  message: BotMessage,
  options: WireOptions,
  logger: Logger,
): Promise<PreparedDispatch> {
  if (options.acknowledge) {
    await acknowledgeMessage(
      thread,
      message,
      options.acknowledgeEmoji ?? DEFAULT_ACKNOWLEDGE_EMOJI,
      logger,
    );
  }

  let postOverride: ((text: string) => Promise<void>) | undefined;
  let notifyFailure: (() => Promise<void>) | undefined;
  if (options.thinkingIndicator) {
    const edit = await startThinkingIndicator(
      thread,
      options.thinkingIndicatorText ?? DEFAULT_THINKING_INDICATOR_TEXT,
      logger,
    );
    if (edit) {
      postOverride = edit;
      notifyFailure = async () => {
        try {
          await edit(
            options.thinkingIndicatorErrorText ??
              DEFAULT_THINKING_INDICATOR_ERROR_TEXT,
          );
        } catch (err) {
          logger.warn(
            `tag-slack: failed to resolve thinking-indicator placeholder ` +
              `after a dispatch failure: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
      };
    }
  }

  return {
    tagThread: toTagThread(thread, postOverride),
    notifyFailure: notifyFailure ?? (async () => {}),
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
    const { tagThread, notifyFailure } = await prepareDispatch(
      thread,
      message,
      options,
      logger,
    );
    try {
      await options.onTag(event, tagThread);
    } catch (err) {
      await notifyFailure();
      throw err;
    }
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
      const { tagThread, notifyFailure } = await prepareDispatch(
        thread,
        message,
        options,
        logger,
      );
      try {
        await options.onTag(event, tagThread);
      } catch (err) {
        await notifyFailure();
        throw err;
      }
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
      const { tagThread, notifyFailure } = await prepareDispatch(
        thread,
        message,
        options,
        logger,
      );
      try {
        await options.onThreadMessage(event, tagThread);
      } catch (err) {
        await notifyFailure();
        throw err;
      }
    }
  });
}
