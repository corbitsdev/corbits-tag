import { describe, expect, test } from "bun:test";

import type { TagEvent } from "@corbits/tag-core";
import {
  wireBot,
  type BotHistoryMessage,
  type BotMessage,
  type BotThread,
  type TagBot,
} from "./wire.ts";

type MentionHandler = (thread: BotThread, message: BotMessage) => Promise<void>;

function fakeBot() {
  const handlers: { mention?: MentionHandler; subscribed?: MentionHandler } =
    {};
  const bot: TagBot = {
    onNewMention: (h) => {
      handlers.mention = h;
    },
    onSubscribedMessage: (h) => {
      handlers.subscribed = h;
    },
    webhooks: {},
  };
  return { bot, handlers };
}

function fakeThread(
  id = "C1:1721800000.000100",
  history?: { messages: BotHistoryMessage[]; refresh?(): Promise<void> },
) {
  const posts: string[] = [];
  let subscribed = false;
  const thread: BotThread = {
    id,
    post: async (text: string) => {
      posts.push(text);
    },
    subscribe: async () => {
      subscribed = true;
    },
    ...(history
      ? {
          refresh:
            history.refresh ??
            (async () => {
              /* recentMessages already set */
            }),
          recentMessages: history.messages,
        }
      : {}),
  };
  return { thread, posts, isSubscribed: () => subscribed };
}

const human = {
  userId: "U123",
  userName: "ada",
  fullName: "Ada Lovelace",
  isBot: false as const,
  isMe: false,
};

describe("wireBot mentions", () => {
  test("mention → subscribes and dispatches a normalized TagEvent", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts, isSubscribed } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event, tagThread) => {
        seen.push(event);
        await tagThread.post(`ack ${event.author.userName}`);
      },
    });

    await handlers.mention!(thread, {
      text: "@scout look at Modal",
      author: human,
    });

    expect(seen).toEqual([
      {
        platform: "slack",
        threadId: thread.id,
        text: "@scout look at Modal",
        author: {
          userId: "U123",
          userName: "ada",
          fullName: "Ada Lovelace",
          isBot: false,
          // No userLookup wired: identity was never established, so neither
          // field may claim a value.
          emailVerified: "unknown",
          isRestricted: "unknown",
        },
        isMention: true,
      },
    ]);
    expect(isSubscribed()).toBe(true);
    expect(posts).toEqual(["ack ada"]);
  });

  test("subscribeOnMention: false leaves the thread unsubscribed", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, isSubscribed } = fakeThread();
    wireBot(bot, { onTag: async () => {}, subscribeOnMention: false });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(isSubscribed()).toBe(false);
  });

  test("the bot's own messages never dispatch", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {
        calls += 1;
      },
    });

    await handlers.mention!(thread, {
      text: "echo",
      author: { ...human, isMe: true },
    });

    expect(calls).toBe(0);
  });
});

describe("wireBot userLookup", () => {
  test("enriches the author with email/isRestricted from userLookup", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        seen.push(event);
      },
      userLookup: async (userId) => {
        expect(userId).toBe("U123");
        return {
          ok: true,
          profile: {
            email: "ada@example.com",
            emailVerified: true,
            isRestricted: false,
            isBot: false,
          },
        };
      },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.author.email).toBe("ada@example.com");
    expect(seen[0]!.author.emailVerified).toBe(true);
    expect(seen[0]!.author.isRestricted).toBe(false);
  });

  test("surfaces isRestricted so hosts can fail closed on guests", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        seen.push(event);
      },
      userLookup: async () => ({
        ok: true,
        profile: {
          email: "guest@other-workspace.example",
          emailVerified: true,
          isRestricted: true,
          isBot: false,
        },
        isBot: false,
      }),
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.author.isRestricted).toBe(true);
  });

  test("without userLookup, identity is unknown rather than assumed", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        seen.push(event);
      },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.author.email).toBeUndefined();
    expect(seen[0]!.author.emailVerified).toBe("unknown");
    expect(seen[0]!.author.isRestricted).toBe("unknown");
  });

  test("a failed lookup leaves identity unknown, never permissive", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        seen.push(event);
      },
      userLookup: async () => ({ ok: false, reason: "unavailable" }),
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    // A rate limit must not read as "not a guest". This is the fail-open the
    // discriminated result exists to prevent.
    expect(seen[0]!.author.email).toBeUndefined();
    expect(seen[0]!.author.emailVerified).toBe("unknown");
    expect(seen[0]!.author.isRestricted).toBe("unknown");
  });
});

describe("wireBot ambient thread messages", () => {
  test("subscribed message routes to onThreadMessage with isMention: false", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async () => {
        throw new Error("ambient traffic must not hit onTag");
      },
      onThreadMessage: async (event) => {
        seen.push(event);
      },
    });

    await handlers.subscribed!(thread, {
      text: "we should check traction",
      author: human,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.isMention).toBe(false);
  });

  test("an explicit mention inside a subscribed thread still gets mention treatment", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const tags: TagEvent[] = [];
    const ambient: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        tags.push(event);
      },
      onThreadMessage: async (event) => {
        ambient.push(event);
      },
    });

    await handlers.subscribed!(thread, {
      text: "@scout re-run this",
      author: human,
      isMention: true,
    });

    expect(tags).toHaveLength(1);
    expect(tags[0]!.isMention).toBe(true);
    expect(ambient).toHaveLength(0);
  });

  test("ambient message with no onThreadMessage is silently ignored", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    wireBot(bot, { onTag: async () => {} });

    await handlers.subscribed!(thread, {
      text: "nothing to see",
      author: human,
    });
  });
});

describe("userLookup failures never drop a message", () => {
  test("a throwing lookup still dispatches, with identity unknown", async () => {
    // wire.ts subscribes to the thread before building the event, so an
    // unguarded rejection leaves the bot subscribed to a thread it never
    // answered in.
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => {
        seen.push(event);
      },
      userLookup: async () => {
        throw new Error("slack exploded");
      },
    });

    await handlers.mention!(thread, { text: "hi", author: human });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.author.isRestricted).toBe("unknown");
    expect(seen[0]!.author.emailVerified).toBe("unknown");
  });
});

describe("wireBot isBot resolution", () => {
  test("a confirmed profile overrides an ambiguous platform-reported isBot", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      userLookup: async () => ({
        ok: true,
        profile: {
          email: undefined,
          emailVerified: false,
          isRestricted: false,
          isBot: true,
        },
      }),
    });

    await handlers.mention!(thread, {
      text: "hi",
      author: { ...human, isBot: "unknown" },
    });

    expect(seen[0]!.author.isBot).toBe(true);
  });

  test("a confirmed platform-reported isBot is never overridden by the profile", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      userLookup: async () => ({
        ok: true,
        profile: {
          email: undefined,
          emailVerified: false,
          isRestricted: false,
          isBot: true,
        },
      }),
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.author.isBot).toBe(false);
  });
});

describe("wireBot threadHistory", () => {
  test("without the option, priorTurns is absent entirely", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const seen: TagEvent[] = [];
    wireBot(bot, { onTag: async (event) => void seen.push(event) });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.priorTurns).toBeUndefined();
  });

  test("refreshes the thread and maps recentMessages to ordered PriorTurns", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(undefined, {
      messages: [
        { text: "what's Modal?", author: { userId: "U123", isMe: false } },
        {
          text: "Modal is a serverless compute platform.",
          author: { userId: "BOT1", isMe: true },
        },
        // last entry is the just-arrived message itself
        { text: "what sources did you use?", author: { userId: "U123", isMe: false } },
      ],
    });
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      threadHistory: {},
    });

    await handlers.mention!(thread, {
      text: "what sources did you use?",
      author: human,
    });

    expect(seen[0]!.priorTurns).toEqual([
      { authorId: "U123", text: "what's Modal?", isBot: false },
      {
        authorId: "BOT1",
        text: "Modal is a serverless compute platform.",
        isBot: true,
      },
    ]);
  });

  test("maxMessages bounds the turns returned, keeping the most recent", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(undefined, {
      messages: [
        { text: "turn 1", author: { userId: "U123", isMe: false } },
        { text: "turn 2", author: { userId: "U123", isMe: false } },
        { text: "turn 3", author: { userId: "U123", isMe: false } },
        { text: "current", author: { userId: "U123", isMe: false } },
      ],
    });
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      threadHistory: { maxMessages: 1 },
    });

    await handlers.mention!(thread, { text: "current", author: human });

    expect(seen[0]!.priorTurns).toEqual([
      { authorId: "U123", text: "turn 3", isBot: false },
    ]);
  });

  test("a failed refresh yields no history rather than dropping the mention", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(undefined, {
      messages: [],
      refresh: async () => {
        throw new Error("slack unavailable");
      },
    });
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      threadHistory: {},
      logger: { warn: () => {} },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.priorTurns).toEqual([]);
  });

  test("a bot too old to support refresh yields no history, not an error", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(); // no refresh/recentMessages at all
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      threadHistory: {},
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(seen[0]!.priorTurns).toEqual([]);
  });
});
