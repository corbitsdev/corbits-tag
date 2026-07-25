/**
 * Handler wiring, split from the mount so it is testable without a real
 * Slack adapter: tests hand in a structural `TagBot` fake, simulate a
 * mention, and assert the normalized dispatch.
 */
import type {
  TagAuthor,
  TagDispatch,
  TagEvent,
  TagThread,
} from "@corbits/tag-core";
import type { SlackUserLookup } from "./slack-users.ts";

/** The slice of a Chat SDK thread this package relies on (structural). */
export type BotThread = {
  id: string;
  post(text: string): Promise<unknown>;
  subscribe(): Promise<void>;
};

/**
 * The slice of a Chat SDK message this package relies on (structural). The
 * Chat SDK's author does not carry email/isRestricted — those are populated
 * separately via `userLookup` (see `createSlackUserLookup`).
 */
export type BotMessage = {
  text: string;
  author: Omit<TagAuthor, "email" | "isRestricted"> & { isMe: boolean };
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
   * `isRestricted` false on every event — hosts that don't map authors to
   * identities don't need it.
   */
  userLookup?: SlackUserLookup;
};

async function toEvent(
  message: BotMessage,
  thread: BotThread,
  isMention: boolean,
  userLookup?: SlackUserLookup,
): Promise<TagEvent> {
  const { userId, userName, fullName, isBot } = message.author;
  const profile = userLookup ? await userLookup(userId) : null;
  const author: TagAuthor = {
    userId,
    userName,
    fullName,
    isBot,
    isRestricted: profile?.isRestricted ?? false,
    ...(profile?.email !== undefined ? { email: profile.email } : {}),
  };
  return {
    platform: "slack",
    threadId: thread.id,
    text: message.text,
    author,
    isMention,
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
  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    if (options.subscribeOnMention !== false) {
      await thread.subscribe();
    }
    const event = await toEvent(message, thread, true, options.userLookup);
    await options.onTag(event, toTagThread(thread));
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    // Mentions inside subscribed threads still land on onTag: an explicit
    // @mention always gets the mention treatment, ambient traffic doesn't.
    if (message.isMention === true) {
      const event = await toEvent(message, thread, true, options.userLookup);
      await options.onTag(event, toTagThread(thread));
      return;
    }
    if (options.onThreadMessage) {
      const event = await toEvent(message, thread, false, options.userLookup);
      await options.onThreadMessage(event, toTagThread(thread));
    }
  });
}
