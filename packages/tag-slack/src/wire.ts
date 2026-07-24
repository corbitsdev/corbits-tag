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

/** The slice of a Chat SDK thread this package relies on (structural). */
export type BotThread = {
  id: string;
  post(text: string): Promise<unknown>;
  subscribe(): Promise<void>;
};

/** The slice of a Chat SDK message this package relies on (structural). */
export type BotMessage = {
  text: string;
  author: TagAuthor & { isMe: boolean };
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
};

function toEvent(message: BotMessage, thread: BotThread, isMention: boolean): TagEvent {
  const { userId, userName, fullName, isBot } = message.author;
  return {
    platform: "slack",
    threadId: thread.id,
    text: message.text,
    author: { userId, userName, fullName, isBot },
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
    await options.onTag(toEvent(message, thread, true), toTagThread(thread));
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    // Mentions inside subscribed threads still land on onTag: an explicit
    // @mention always gets the mention treatment, ambient traffic doesn't.
    if (message.isMention === true) {
      await options.onTag(toEvent(message, thread, true), toTagThread(thread));
      return;
    }
    if (options.onThreadMessage) {
      await options.onThreadMessage(
        toEvent(message, thread, false),
        toTagThread(thread),
      );
    }
  });
}
