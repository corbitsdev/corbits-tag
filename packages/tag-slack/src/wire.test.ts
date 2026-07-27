import { describe, expect, test } from "bun:test";

import type { TagEvent } from "@corbits/tag-core";
import {
  wireBot,
  type BotHistoryMessage,
  type BotMessage,
  type BotSentMessage,
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

/** A thread that also supports the `acknowledge` affordance. */
function fakeReactableThread(addReaction: (emoji: string) => Promise<unknown>) {
  const { thread, posts, isSubscribed } = fakeThread();
  const reactable: BotThread = {
    ...thread,
    createSentMessageFromMessage: (message: unknown): BotSentMessage => ({
      edit: async () => {},
      addReaction,
    }),
  };
  return { thread: reactable, posts, isSubscribed };
}

/**
 * A thread whose `post()` returns an edit-capable `SentMessage`, so
 * `thinkingIndicator` can wrap it — mirrors what Chat SDK's `Thread.post()`
 * actually returns.
 */
function fakeEditableThread(firstPostThrows = false, editable = true) {
  const events: string[] = [];
  let postCalls = 0;
  const thread: BotThread = {
    id: "C1:1721800000.000100",
    post: async (text: string) => {
      postCalls += 1;
      if (firstPostThrows && postCalls === 1) throw new Error("post failed");
      events.push(`post:${text}`);
      if (!editable) return {};
      return {
        edit: async (text: string) => {
          events.push(`edit:${text}`);
        },
        addReaction: async () => {},
      } satisfies BotSentMessage;
    },
    subscribe: async () => {},
  };
  return { thread, events };
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
        trigger: "mention",
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
    expect(seen[0]!.trigger).toBe("ambient");
  });

  test("an ambient message from another bot never reaches onThreadMessage", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {},
      onThreadMessage: async () => {
        calls += 1;
      },
    });

    await handlers.subscribed!(thread, {
      text: "deploy finished",
      author: { ...human, userId: "BOT2", isBot: true },
    });

    expect(calls).toBe(0);
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
    expect(tags[0]!.trigger).toBe("mention");
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

describe("wireBot acknowledge", () => {
  test("acknowledge: true reacts before onTag fires", async () => {
    const order: string[] = [];
    const { bot, handlers } = fakeBot();
    const { thread } = fakeReactableThread(async (emoji) => {
      order.push(`react:${emoji}`);
    });
    wireBot(bot, {
      onTag: async () => {
        order.push("onTag");
      },
      acknowledge: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(order).toEqual(["react:eyes", "onTag"]);
  });

  test("acknowledgeEmoji overrides the default", async () => {
    const reactions: string[] = [];
    const { bot, handlers } = fakeBot();
    const { thread } = fakeReactableThread(async (emoji) => {
      reactions.push(emoji);
    });
    wireBot(bot, {
      onTag: async () => {},
      acknowledge: true,
      acknowledgeEmoji: "white_check_mark",
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(reactions).toEqual(["white_check_mark"]);
  });

  test("without createSentMessageFromMessage, acknowledge silently no-ops", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(); // no reaction support
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {
        calls += 1;
      },
      acknowledge: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(calls).toBe(1);
  });

  test("a rejecting addReaction is logged once and dispatch still proceeds", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeReactableThread(async () => {
      throw new Error("missing_scope");
    });
    const warnings: string[] = [];
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {
        calls += 1;
      },
      acknowledge: true,
      logger: { warn: (m) => warnings.push(m) },
    });

    await handlers.mention!(thread, { text: "first", author: human });
    await handlers.mention!(thread, { text: "second", author: human });

    expect(calls).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("acknowledge unset does not react at all", async () => {
    let reacted = false;
    const { bot, handlers } = fakeBot();
    const { thread } = fakeReactableThread(async () => {
      reacted = true;
    });
    wireBot(bot, { onTag: async () => {} });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(reacted).toBe(false);
  });
});

describe("wireBot thinkingIndicator", () => {
  test("posts a placeholder, then the host's post() edits it in place", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("the real answer");
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual([
      "post:_Working on it…_",
      "edit:the real answer",
    ]);
  });

  test("thinkingIndicatorText overrides the default placeholder", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async () => {},
      thinkingIndicator: true,
      thinkingIndicatorText: "_On it…_",
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:_On it…_"]);
  });

  test("a throwing onTag replaces the placeholder with an error, not silence", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async () => {
        throw new Error("boom");
      },
      thinkingIndicator: true,
    });

    await expect(
      handlers.mention!(thread, { text: "hi", author: human }),
    ).rejects.toThrow("boom");

    expect(events).toEqual([
      "post:_Working on it…_",
      "edit:Something went wrong while generating a response.",
    ]);
  });

  test("thinkingIndicatorErrorText overrides the default failure text", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async () => {
        throw new Error("boom");
      },
      thinkingIndicator: true,
      thinkingIndicatorErrorText: "Sorry, that failed.",
    });

    await expect(
      handlers.mention!(thread, { text: "hi", author: human }),
    ).rejects.toThrow("boom");

    expect(events).toEqual([
      "post:_Working on it…_",
      "edit:Sorry, that failed.",
    ]);
  });

  test("a throwing placeholder post falls back to a normal post, dispatch unaffected", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread(true);
    let calls = 0;
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        calls += 1;
        await tagThread.post("normal reply");
      },
      thinkingIndicator: true,
      logger: { warn: () => {} },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(calls).toBe(1);
    expect(events).toEqual(["post:normal reply"]);
  });

  test("a non-editable placeholder falls back to a normal post", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread(false, /* editable */ false);
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("normal reply");
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:_Working on it…_", "post:normal reply"]);
  });

  test("thinkingIndicator combined with acknowledge: both fire, in order", async () => {
    const order: string[] = [];
    const { bot, handlers } = fakeBot();
    const { thread: base, events } = fakeEditableThread();
    const thread: BotThread = {
      ...base,
      createSentMessageFromMessage: (): BotSentMessage => ({
        edit: async () => {},
        addReaction: async (emoji) => {
          order.push(`react:${emoji}`);
        },
      }),
    };
    wireBot(bot, {
      onTag: async () => {
        order.push("onTag");
      },
      acknowledge: true,
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(order).toEqual(["react:eyes", "onTag"]);
    expect(events).toEqual(["post:_Working on it…_"]);
  });

  test("thinkingIndicator unset behaves as a normal post", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("normal reply");
      },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:normal reply"]);
  });
});
