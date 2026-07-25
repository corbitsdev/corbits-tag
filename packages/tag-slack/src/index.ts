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
import type { TagDispatch } from "@corbits/tag-core";

export { wireBot } from "./wire.ts";
export type { BotMessage, BotThread, TagBot } from "./wire.ts";
export { createSlackUserLookup } from "./slack-users.ts";
export type { SlackUserLookup, SlackUserProfile } from "./slack-users.ts";
export type {
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
};

export type MountedSlackTag = {
  /** The underlying Chat SDK bot (escape hatch for platform-specific needs). */
  bot: TagBot;
  /** The route the webhook was mounted at. */
  path: string;
};

const DEFAULT_PATH = "/api/tag/slack/webhook";

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
  // Populates TagAuthor.email/isRestricted via a cached `users.info` call.
  // Requires the `users:read.email` scope — see README "Mapping authors to
  // identities". Silently yields undefined/false without it, so hosts that
  // don't map authors to identities pay no extra cost.
  const botToken = options.slack?.botToken ?? process.env.SLACK_BOT_TOKEN;
  wireBot(bot, {
    ...options,
    ...(botToken ? { userLookup: createSlackUserLookup(botToken) } : {}),
  });

  const path = options.path ?? DEFAULT_PATH;
  app.post(path, (c) => bot.webhooks.slack(c.req.raw));
  return { bot, path };
}
