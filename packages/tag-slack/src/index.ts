/**
 * @corbits/tag-slack — mountable Slack tag ingress for Interchange hubs.
 *
 * `mountSlackTag(app, opts)` adds one webhook route to the host's Hono app
 * and routes Slack mentions/thread messages to the host's dispatch as
 * normalized `TagEvent`s (see `@corbits/tag-core`).
 *
 * Security posture: this route mounts OUTSIDE the host's session auth —
 * Slack is not a principal. The Chat SDK Slack adapter verifies the request
 * signature (`SLACK_SIGNING_SECRET`); everything past that verification is
 * the host's responsibility, starting with what its dispatch is willing to
 * do for a given workspace/author. This package authenticates nothing else.
 */
import type { Hono } from "hono";
import { Chat, type Adapter, type StateAdapter } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";

import { wireBot, type TagBot } from "./wire.ts";
import { createSlackUserLookup } from "./slack-users.ts";
import { defaultLogger, type Logger } from "./logger.ts";
import type { TagDispatch } from "@corbits/tag-core";

export { wireBot } from "./wire.ts";
export type {
  BotHistoryMessage,
  BotMessage,
  BotSentMessage,
  BotThread,
  TagBot,
} from "./wire.ts";
export { createSlackUserLookup } from "./slack-users.ts";
export type {
  SlackUserLookup,
  SlackUserLookupResult,
  SlackUserProfile,
} from "./slack-users.ts";
export type { Logger } from "./logger.ts";
export type {
  PriorTurn,
  TagAuthor,
  TagDispatch,
  TagEvent,
  TagThread,
} from "@corbits/tag-core";

export type MountSlackTagOptions = TagDispatch & {
  /** Bot username, shown by the platform (Chat SDK `userName`). */
  userName: string;
  /**
   * State backend for subscriptions/dedup/locks (Chat SDK `StateAdapter`),
   * e.g. `createRedisState()` or `createPostgresState()`. Required — thread
   * subscription is stateful.
   */
  state: StateAdapter;
  /** Route to mount. Default: `/api/tag/slack/webhook`. */
  path?: string;
  /**
   * Slack credentials. Omit to let the adapter read `SLACK_BOT_TOKEN` /
   * `SLACK_SIGNING_SECRET` from the environment.
   */
  slack?: { botToken: string; signingSecret: string };
  /** Subscribe to the thread on first mention (ambient membership). Default: true. */
  subscribeOnMention?: boolean;
  /**
   * Resolves a Slack user id to email/restriction info. Defaults to the
   * package's own `createSlackUserLookup(botToken)` whenever a bot token is
   * available; set this to override that default (or to `undefined`
   * explicitly if you never want identity resolution even though a token is
   * present — that explicit `undefined` is honored, not treated the same as
   * "never mentioned it").
   */
  userLookup?: import("./slack-users.ts").SlackUserLookup;
  /**
   * Fetch each thread's prior messages and attach them to `TagEvent.priorTurns`
   * (see `@corbits/tag-core`). Off by default. `maxMessages` bounds the raw
   * fetch (default 50); how many of those a host actually uses is its call.
   */
  threadHistory?: { maxMessages?: number };
  /**
   * Logging seam for this package's fail-soft paths. Defaults to
   * `console.warn`.
   */
  logger?: Logger;
  /**
   * React to a message the moment it's dispatched to the host. Off by
   * default; requires the bot token's `reactions:write` scope, and the
   * Slack app must be reinstalled after adding it — scope changes don't
   * apply to an already-installed app. A missing scope fails soft (logged
   * once, never blocks answering — see `wireBot`).
   */
  acknowledge?: boolean;
  /** Emoji used by `acknowledge` (Slack short name, no colons). Default: `"eyes"`. */
  acknowledgeEmoji?: string;
  /**
   * Show a placeholder while the host works, then edit it in place with the
   * real answer. Off by default. Host call sites need no changes — the
   * `TagThread.post()` handed to `onTag`/`onThreadMessage` transparently
   * edits the placeholder instead of posting twice. See `WireOptions` for
   * the fallback/failure behavior.
   */
  thinkingIndicator?: boolean;
  /** Placeholder text for `thinkingIndicator`. Default: a neutral, bot-name-free message. */
  thinkingIndicatorText?: string;
  /** Text the placeholder is replaced with if the host's handler throws. */
  thinkingIndicatorErrorText?: string;
};

export type MountedSlackTag = {
  /** The underlying Chat SDK bot (escape hatch for platform-specific needs). */
  bot: TagBot;
  /** The route the webhook was mounted at. */
  path: string;
};

const DEFAULT_PATH = "/api/tag/slack/webhook";

/**
 * Whether `mountSlackTag` should auto-wire its own `createSlackUserLookup`
 * over `options.userLookup`. Pulled out of `mountSlackTag` so the "explicit
 * `undefined` disables it" contract (see `MountSlackTagOptions.userLookup`)
 * is unit-testable without spinning up a real `Chat` bot.
 *
 * `"userLookup" in options`, not `!options.userLookup`: the latter can't
 * distinguish "the host never mentioned it" (auto-wire) from "the host set
 * it to `undefined` on purpose" (don't) — both read as falsy.
 */
export function shouldAutoWireUserLookup(
  options: { userLookup?: import("./slack-users.ts").SlackUserLookup | undefined },
  botToken: string | undefined,
): boolean {
  return Boolean(botToken) && !("userLookup" in options);
}

/** Mount the Slack tag webhook route and wire dispatch over one bot. */
export function mountSlackTag(
  // deliberately typed against the default Hono env: the route lives
  // outside the host's session auth and reads nothing from its context
  app: Hono,
  options: MountSlackTagOptions,
): MountedSlackTag {
  if (typeof options.onTag !== "function") {
    throw new Error(
      "tag-slack: `onTag` is required — the mount only normalizes Slack " +
        "events; the host decides what a tag means.",
    );
  }
  const bot = new Chat({
    userName: options.userName,
    // cast: SlackAdapter's optional props aren't `| undefined`-annotated,
    // which trips exactOptionalPropertyTypes; the runtime shape conforms
    adapters: {
      slack: createSlackAdapter(options.slack ?? {}) as unknown as Adapter,
    },
    state: options.state,
  });
  const logger = options.logger ?? defaultLogger;
  // Auto-wire identity lookup when a bot token is available so hosts don't
  // each reimplement users.info. Unresolved facts stay "unknown" on TagAuthor
  // (see README "Mapping authors to identities"). A host-supplied
  // `options.userLookup` always wins — auto-wiring must never silently
  // replace it just because a token happens to be present.
  const botToken = options.slack?.botToken ?? process.env.SLACK_BOT_TOKEN;
  wireBot(bot, {
    ...options,
    logger,
    ...(shouldAutoWireUserLookup(options, botToken)
      ? { userLookup: createSlackUserLookup(botToken!, { logger }) }
      : {}),
  });

  const path = options.path ?? DEFAULT_PATH;
  app.post(path, (c) => bot.webhooks.slack(c.req.raw));
  return { bot, path };
}
