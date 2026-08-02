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
import { mdToMrkdwn } from "./mrkdwn.ts";
import type {
  SlackUserLookup,
  SlackUserProfile,
} from "./slack-users.ts";

/** The slice of a Chat SDK message this package reads to build a `PriorTurn`. */
export type BotHistoryMessage = {
  text: string;
  author: { userId: string; isMe: boolean };
  /**
   * Stable message id (Chat SDK's `Message.id`), when the fake/adapter
   * supplies one. Used to reliably identify the just-arrived message in
   * `recentMessages` — see `fetchPriorTurns`.
   */
  id?: string;
};

/** A message wrapped with edit/react/delete capabilities (Chat SDK's `SentMessage`). */
export type BotSentMessage = {
  edit(content: string): Promise<unknown>;
  addReaction(emoji: string): Promise<unknown>;
  /** Chat SDK's `SentMessage.delete()`. Used to retract an unused thinking placeholder. */
  delete(): Promise<unknown>;
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
  /** Stable message id (Chat SDK's `Message.id`), when available. See `BotHistoryMessage.id`. */
  id?: string;
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
   *
   * **Required for `onThreadMessage` to ever fire.** The ambient bot-guard
   * denies dispatch whenever the resolved `isBot` is `"unknown"` (see
   * `wireBot`'s bot-guard comment), and without a `userLookup` it is always
   * `"unknown"` unless Slack's own event already confirms it one way or the
   * other. A host that enables ambient replies (`onThreadMessage`) without
   * wiring `userLookup` will typically see it never fire, silently — this
   * is that coupling, made explicit.
   */
  userLookup?: SlackUserLookup;
  /**
   * Fetch this thread's prior messages and attach them to every `TagEvent`
   * as `priorTurns`. Off by default: it costs one extra Slack API call per
   * mention, and a host that doesn't want conversation memory shouldn't pay
   * for it. `refresh()` itself takes no range argument — it re-fetches
   * whatever the Chat SDK's own history cache holds; `maxMessages` bounds
   * how many of *those* messages this mechanism keeps (default 50), by
   * slicing after the fact. It is not the host's turn budget; a host
   * decides how many of the returned turns to actually use.
   *
   * `maxMessages: 0` means "no history" (skips the refresh entirely — not
   * "unbounded", which `-maxMessages` would silently become via
   * `Array.prototype.slice`'s negative-index behavior). A negative value is
   * rejected: it throws rather than being reinterpreted as some other slice.
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
   * Requires `thread.post()` to return something both `edit`- and
   * `delete`-capable (Chat SDK's `SentMessage`); without both, the
   * placeholder is deleted if possible and this falls back to a normal
   * `thread.post()` for the real answer — if even deletion isn't
   * available, the placeholder is left in the thread (logged) rather than
   * blocking the answer.
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
 * Validates `threadHistory.maxMessages` once, at `wireBot()` setup —
 * configuration is the trust boundary, not each incoming message. Rejects
 * anything that isn't a non-negative integer: `NaN` (e.g. an unparsed
 * `Number(process.env.MAX_MESSAGES)`) fails both `< 0` and `=== 0`, so it
 * used to fall through to `slice(-NaN)`, which is `slice(0)` — the entire
 * history. Fractional values (`2.5`) used to silently truncate via
 * `Array.prototype.slice` instead of being rejected as the misconfiguration
 * they are.
 */
function validateMaxMessages(maxMessages: number | undefined): number {
  const value = maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `tag-slack: threadHistory.maxMessages must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}

/**
 * Mutable "have we warned yet" flag for the acknowledge affordance, scoped
 * to a single `wireBot()` call (one bot/mount) rather than the module —
 * a module-level flag would let one workspace's missing scope silence the
 * warning for every other bot in the same process, and make tests
 * order-dependent on a shared global.
 */
type AckWarnState = { warned: boolean };

/**
 * Add the acknowledge reaction to `message`. Never throws: the most likely
 * failure is a bot token missing `reactions:write`, which must never block
 * answering. Logged at most once per `wireBot()` call — a missing scope
 * doesn't need to repeat on every message, just be visible that it's
 * happening.
 */
async function acknowledgeMessage(
  thread: BotThread,
  message: BotMessage,
  emoji: string,
  logger: Logger,
  warnState: AckWarnState,
): Promise<void> {
  if (typeof thread.createSentMessageFromMessage !== "function") return;
  try {
    const sent = thread.createSentMessageFromMessage(message);
    await sent.addReaction(emoji);
  } catch (err) {
    if (!warnState.warned) {
      warnState.warned = true;
      logger.warn(
        "tag-slack: acknowledge reaction failed — the bot token likely lacks " +
          `the reactions:write scope. Add it (and reinstall the app) to keep ` +
          `this working. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

/**
 * Post a placeholder in `thread` and return it wrapped as a `BotSentMessage`
 * (edit in place, or delete if the host's dispatch never posts — see
 * `prepareDispatch`) only when it supports BOTH `edit` and `delete`.
 * `undefined` otherwise — callers fall back to a normal `thread.post()` for
 * the real answer. Never throws.
 *
 * This affordance needs both capabilities: `edit` to replace the
 * placeholder with the real answer/an error, `delete` to retract it
 * cleanly when the dispatch declines to answer (see `resolveIfUnused`) or
 * when the placeholder itself turns out not to be usable (below). Requiring
 * both up front, rather than degrading per-call, means every other function
 * that receives a `BotSentMessage` here can rely on its full contract.
 */
async function startThinkingIndicator(
  thread: BotThread,
  text: string,
  logger: Logger,
): Promise<BotSentMessage | undefined> {
  let placeholder: unknown;
  try {
    // Chat SDK's `Thread.post()` already returns a `SentMessage` (edit/
    // delete/addReaction) — no need to re-wrap it via
    // `createSentMessageFromMessage`, which is for plain incoming messages.
    placeholder = await thread.post(text);
  } catch (err) {
    logger.warn(
      `tag-slack: thinking-indicator placeholder failed, falling back to a ` +
        `normal reply: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const hasEdit =
    typeof placeholder === "object" &&
    placeholder !== null &&
    typeof (placeholder as { edit?: unknown }).edit === "function";
  const hasDelete =
    typeof placeholder === "object" &&
    placeholder !== null &&
    typeof (placeholder as { delete?: unknown }).delete === "function";
  if (hasEdit && hasDelete) {
    return placeholder as BotSentMessage;
  }

  // The placeholder text is already posted at this point — `thread.post()`
  // sent it regardless of what it returned. Falling back silently here (the
  // old behavior) left that placeholder stranded above the real answer
  // forever. Clean it up if we can; otherwise the orphan is an unavoidable
  // consequence of a `thread.post()` that doesn't conform to the Chat SDK
  // `SentMessage` contract this affordance requires, and is logged so it's
  // not a silent surprise.
  if (hasDelete) {
    try {
      await (placeholder as { delete(): Promise<unknown> }).delete();
    } catch (err) {
      logger.warn(
        `tag-slack: thinking-indicator placeholder wasn't edit-capable and ` +
          `couldn't be cleaned up either, leaving a stray "${text}" message: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (hasEdit) {
    // Has `edit` but not `delete`: this affordance can't retract it, so it
    // stays in the thread — logged accurately (not "can't be edited or
    // deleted", which was true of neither this path nor its sibling below).
    logger.warn(
      `tag-slack: thinking-indicator placeholder ("${text}") supports ` +
        `edit() but not delete() — thread.post() must return a Chat SDK ` +
        `SentMessage supporting both for this affordance to fully work. ` +
        `Falling back to a normal reply; the placeholder will remain in ` +
        `the thread since it can't be retracted.`,
    );
  } else {
    logger.warn(
      `tag-slack: thinking-indicator placeholder ("${text}") can't be ` +
        `edited or deleted — thread.post() must return a Chat SDK ` +
        `SentMessage for this affordance to work. Falling back to a normal ` +
        `reply, but the placeholder message itself will remain in the thread.`,
    );
  }
  return undefined;
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
  // `maxMessages` is validated once, at `wireBot()` setup time (see
  // `validateMaxMessages`) — never here, per-message. A bad config value
  // must fail loudly and immediately at startup, not throw out of every
  // event handler and silently drop all traffic.
  //
  // 0 means "no history" — return without even paying for the refresh, and
  // without falling into `slice(-0)`, which is `slice(0)`: the *entire*
  // array, not zero elements.
  if (maxMessages === 0) return [];
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
  const last = messages.length > 0 ? messages[messages.length - 1]! : undefined;
  const isCurrent =
    last !== undefined &&
    (current.id !== undefined && last.id !== undefined
      ? // Preferred path: a stable Chat SDK message id, immune to two
        // identical-looking messages from the same author.
        last.id === current.id
      : // Fallback when no id is available on either side: text + author
        // equality. This is a known, accepted limitation — it misidentifies
        // the current message as "prior" (or vice versa) if the same author
        // posts the exact same text twice in a row in the same thread. Not
        // corrected further because the Chat SDK always supplies `id` in
        // practice; this path exists for fakes/older adapters that don't.
        last.text === current.text && last.author.userId === current.author.userId);
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
  /**
   * Already-validated (see `validateMaxMessages`, called once at
   * `wireBot()` setup) — `undefined` means `threadHistory` is off entirely,
   * never a value in need of re-checking here.
   */
  maxMessages: number | undefined,
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
  const priorTurns =
    maxMessages !== undefined
      ? await fetchPriorTurns(thread, message, maxMessages, logger)
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

/**
 * `postOverride` (when supplied) applies to the FIRST call to `post()` only
 * — typically the thinking-indicator's edit-in-place. Every subsequent call
 * is a genuine new message via `thread.post()`, so a multi-part answer never
 * silently collapses into repeated edits of the same message.
 *
 * `overrideConsumed` here and `used` in `prepareDispatch` are deliberately
 * separate flags, not the same one-shot state: `overrideConsumed` decides
 * *routing* — whether this particular `post()` call reaches `postOverride`
 * at all — the instant the first call happens, regardless of whether
 * `postOverride` goes on to succeed or throw. `used` (in `prepareDispatch`)
 * decides *resolution* — whether the placeholder still needs `notifyFailure`
 * or `resolveIfUnused` to act on it — which can only be known once the edit
 * itself has settled. Merging them would conflate "this call was routed to
 * the placeholder" with "the placeholder is resolved", which are different
 * facts at different times (e.g. mid-flight while `postOverride`'s `edit()`
 * is still pending). Unifying into one placeholder-owned state machine is a
 * real improvement, but a separate refactor — not bundled into this fix.
 */
function toTagThread(
  thread: BotThread,
  postOverride?: (text: string) => Promise<void>,
): TagThread {
  let overrideConsumed = false;
  return {
    id: thread.id,
    post: async (text) => {
      // Normalize any markdown a host's dispatch produced (e.g. an LLM
      // answer) into Slack mrkdwn before it ever reaches Slack — see
      // `mdToMrkdwn`. Applied here so every caller of `TagThread.post()`
      // gets it automatically, without each host having to remember to.
      const mrkdwnText = mdToMrkdwn(text);
      if (postOverride && !overrideConsumed) {
        overrideConsumed = true;
        await postOverride(mrkdwnText);
        return;
      }
      await thread.post(mrkdwnText);
    },
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
  /**
   * Call after the host's handler returns *without* throwing. A silently
   * declined dispatch (blessed behavior — see `TagDispatch.onThreadMessage`,
   * and the default outcome for most ambient messages) never calls
   * `TagThread.post()`, so without this the placeholder would be left
   * reading "thinking" forever, exactly the failure mode this affordance
   * exists to prevent. Deletes the placeholder rather than replacing it
   * with a "nothing to add" message — a mechanism-only package has no
   * useful text to put there, and silence is the correct outcome, not
   * something to announce. No-op when no placeholder was started, or the
   * host already posted through it.
   */
  resolveIfUnused(): Promise<void>;
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
  ackWarnState: AckWarnState,
): Promise<PreparedDispatch> {
  if (options.acknowledge) {
    await acknowledgeMessage(
      thread,
      message,
      options.acknowledgeEmoji ?? DEFAULT_ACKNOWLEDGE_EMOJI,
      logger,
      ackWarnState,
    );
  }

  let postOverride: ((text: string) => Promise<void>) | undefined;
  let notifyFailure: (() => Promise<void>) | undefined;
  let resolveIfUnused: (() => Promise<void>) | undefined;
  if (options.thinkingIndicator) {
    const sent = await startThinkingIndicator(
      thread,
      options.thinkingIndicatorText ?? DEFAULT_THINKING_INDICATOR_TEXT,
      logger,
    );
    if (sent) {
      // Shared by all three closures below: whichever of them SUCCEEDS
      // FIRST decides the placeholder's fate, and the other two must defer
      // to it. In particular, a host that posts the real answer and *then*
      // throws (an error after a successful reply, e.g. in cleanup code)
      // must not have that answer clobbered by `notifyFailure`'s error
      // text — the answer already resolved the placeholder, so
      // `notifyFailure` here checks `used` before touching it.
      //
      // Critically, `postOverride` sets `used` only AFTER `sent.edit()`
      // resolves, not before: if the edit itself throws (e.g. the message
      // was deleted out from under the bot), the placeholder was NOT
      // actually resolved, so `notifyFailure` — which runs next, since the
      // host's `await tagThread.post()` rejects and propagates out of
      // `onTag`/`onThreadMessage` — must still be free to try resolving it
      // into the error text rather than seeing `used` already true and
      // silently doing nothing, stranding the placeholder AND losing the
      // answer. Any future consumer of `used` must check it before acting,
      // and set it only once its own action has actually succeeded.
      let used = false;
      postOverride = async (text: string) => {
        await sent.edit(text);
        used = true;
      };
      notifyFailure = async () => {
        if (used) return;
        used = true;
        try {
          await sent.edit(
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
      resolveIfUnused = async () => {
        if (used) return;
        used = true;
        try {
          await sent.delete();
        } catch (err) {
          logger.warn(
            `tag-slack: failed to retract an unused thinking-indicator ` +
              `placeholder: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
    }
  }

  return {
    tagThread: toTagThread(thread, postOverride),
    notifyFailure: notifyFailure ?? (async () => {}),
    resolveIfUnused: resolveIfUnused ?? (async () => {}),
  };
}

/** Register mention + subscribed-message handlers on the bot. */
export function wireBot(bot: TagBot, options: WireOptions): void {
  const logger = options.logger ?? defaultLogger;
  // Scoped to this wireBot() call (one bot/mount) — see `AckWarnState`.
  const ackWarnState: AckWarnState = { warned: false };
  // Validated once, here, at setup — not per message (see
  // `validateMaxMessages`). `undefined` means `threadHistory` is off.
  const maxHistoryMessages = options.threadHistory
    ? validateMaxMessages(options.threadHistory.maxMessages)
    : undefined;

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
      maxHistoryMessages,
      logger,
    );
    const { tagThread, notifyFailure, resolveIfUnused } = await prepareDispatch(
      thread,
      message,
      options,
      logger,
      ackWarnState,
    );
    try {
      await options.onTag(event, tagThread);
      await resolveIfUnused();
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
        maxHistoryMessages,
        logger,
      );
      const { tagThread, notifyFailure, resolveIfUnused } = await prepareDispatch(
        thread,
        message,
        options,
        logger,
        ackWarnState,
      );
      try {
        await options.onTag(event, tagThread);
        await resolveIfUnused();
      } catch (err) {
        await notifyFailure();
        throw err;
      }
      return;
    }
    // Ambient delivery is for other humans talking in a thread the bot
    // already joined, not for other bots/integrations posting into it — a
    // bot replying to another bot is exactly the loop this mechanism must
    // never create. A platform-confirmed bot is rejected immediately
    // (cheap, no need to resolve anything further); when the platform can
    // only say "unknown", the guard defers to the *resolved* isBot from
    // `toEvent` (a `users.info` lookup, when wired, is a more authoritative
    // source than an ambiguous platform report — see toEvent). Unlike
    // author resolution generally, where "unknown" stays "unknown" and the
    // host decides what to do with that, ambient dispatch is unsolicited —
    // nobody asked the bot to look at this message — so the safe default
    // inverts here: an unresolved "unknown" must NOT dispatch ambiently;
    // only a confirmed `false` may.
    if (options.onThreadMessage && message.author.isBot !== true) {
      const event = await toEvent(
        message,
        thread,
        false,
        options.userLookup,
        maxHistoryMessages,
        logger,
      );
      if (event.author.isBot !== false) return;
      const { tagThread, notifyFailure, resolveIfUnused } = await prepareDispatch(
        thread,
        message,
        options,
        logger,
        ackWarnState,
      );
      try {
        await options.onThreadMessage(event, tagThread);
        await resolveIfUnused();
      } catch (err) {
        await notifyFailure();
        throw err;
      }
    }
  });
}
