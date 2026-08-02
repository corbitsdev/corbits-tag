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
      delete: async () => {},
    }),
  };
  return { thread: reactable, posts, isSubscribed };
}

/**
 * A thread whose `post()` returns an edit-capable `SentMessage`, so
 * `thinkingIndicator` can wrap it — mirrors what Chat SDK's `Thread.post()`
 * actually returns.
 */
function fakeEditableThread(
  firstPostThrows = false,
  editable = true,
  editThrows = false,
) {
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
          if (editThrows) throw new Error("edit failed");
          events.push(`edit:${text}`);
        },
        addReaction: async () => {},
        delete: async () => {
          events.push("delete");
        },
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

  // Regression: `prior.slice(-maxMessages)` with `maxMessages: 0` computed
  // `slice(-0)`, which is `slice(0)` — the entire array — instead of zero
  // elements.
  test("maxMessages: 0 means no history, not unbounded history", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread(undefined, {
      messages: [
        { text: "turn 1", author: { userId: "U123", isMe: false } },
        { text: "current", author: { userId: "U123", isMe: false } },
      ],
    });
    const seen: TagEvent[] = [];
    wireBot(bot, {
      onTag: async (event) => void seen.push(event),
      threadHistory: { maxMessages: 0 },
    });

    await handlers.mention!(thread, { text: "current", author: human });

    expect(seen[0]!.priorTurns).toEqual([]);
  });

  // Regression: maxMessages is now validated once at wireBot() setup, not
  // per message inside the handler — a bad value must fail loudly and
  // immediately at startup, not throw out of every event handler and
  // silently drop all traffic.
  test("a negative maxMessages throws synchronously from wireBot(), before any message arrives", () => {
    const { bot } = fakeBot();
    expect(() =>
      wireBot(bot, {
        onTag: async () => {},
        threadHistory: { maxMessages: -1 },
      }),
    ).toThrow(/non-negative integer/);
  });

  // Regression: `NaN < 0` and `NaN === 0` are both false, so `Number(NaN)`
  // (e.g. an unparsed `Number(process.env.MAX_MESSAGES)`) sailed past both
  // guards and reached `slice(-NaN)`, which is `slice(0)` — the entire
  // history, not zero and not an error.
  test("NaN maxMessages throws synchronously from wireBot()", () => {
    const { bot } = fakeBot();
    expect(() =>
      wireBot(bot, {
        onTag: async () => {},
        threadHistory: { maxMessages: Number.NaN },
      }),
    ).toThrow(/non-negative integer/);
  });

  // Regression: a fractional bound silently truncated via
  // `Array.prototype.slice` instead of being rejected as a misconfiguration.
  test("a fractional maxMessages throws synchronously from wireBot()", () => {
    const { bot } = fakeBot();
    expect(() =>
      wireBot(bot, {
        onTag: async () => {},
        threadHistory: { maxMessages: 2.5 },
      }),
    ).toThrow(/non-negative integer/);
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
      onTag: async (_event, tagThread) => {
        await tagThread.post("the real answer");
      },
      thinkingIndicator: true,
      thinkingIndicatorText: "_On it…_",
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:_On it…_", "edit:the real answer"]);
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
        delete: async () => {},
      }),
    };
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        order.push("onTag");
        await tagThread.post("the real answer");
      },
      acknowledge: true,
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(order).toEqual(["react:eyes", "onTag"]);
    expect(events).toEqual(["post:_Working on it…_", "edit:the real answer"]);
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

  // Regression: a host returning without posting (blessed by TagDispatch —
  // e.g. onThreadMessage deciding there's nothing to add) used to leave the
  // placeholder reading "_Working on it…_" forever.
  test("a host that returns without posting has the placeholder deleted, not left thinking", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async () => {
        // decides there's nothing worth replying with
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:_Working on it…_", "delete"]);
  });

  test("a host that posts through the placeholder does not also get it deleted", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("the real answer");
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual(["post:_Working on it…_", "edit:the real answer"]);
  });

  // Regression: a second thread.post() used to silently re-edit the same
  // placeholder, losing the first half of a multi-part answer.
  test("only the FIRST post() edits the placeholder; a second post() is a new message", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("part one");
        await tagThread.post("part two");
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual([
      "post:_Working on it…_",
      "edit:part one",
      "post:part two",
    ]);
  });

  // Regression: notifyFailure edited the placeholder into the error text
  // unconditionally, even when the host had already posted the real answer
  // and only threw afterward (e.g. in post-answer cleanup) — destroying the
  // answer the user was meant to see.
  test("a post-then-throw does not clobber the already-posted answer with the error text", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("THE REAL ANSWER");
        throw new Error("boom after posting");
      },
      thinkingIndicator: true,
      logger: { warn: () => {} },
    });

    await expect(
      handlers.mention!(thread, { text: "hi", author: human }),
    ).rejects.toThrow("boom after posting");

    expect(events).toEqual(["post:_Working on it…_", "edit:THE REAL ANSWER"]);
  });

  // Regression: postOverride set `used = true` BEFORE awaiting sent.edit().
  // If that edit rejected, the host's `await tagThread.post()` throws (the
  // edit failure propagates), which reaches wireBot's catch → notifyFailure
  // — but notifyFailure saw `used` already true and returned immediately,
  // leaving the placeholder reading "_Working on it…_" forever with the
  // answer never delivered. The round-3 fix for clobbering turned into a
  // round-4 data-loss bug in the same line.
  test("a failing post-edit still lets notifyFailure attempt to resolve the placeholder", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread(false, true, true);
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("THE REAL ANSWER");
      },
      thinkingIndicator: true,
      logger: { warn: () => {} },
    });

    await expect(
      handlers.mention!(thread, { text: "hi", author: human }),
    ).rejects.toThrow("edit failed");

    // The placeholder's edit() always fails in this fake, so the answer
    // could never actually reach the thread either way — but notifyFailure
    // must still have been given the chance to try (not silently no-op
    // because `used` was set before the edit that never succeeded).
    expect(events).toEqual(["post:_Working on it…_"]);
  });

  // Regression: startThinkingIndicator only type-guarded `edit`, then cast
  // the placeholder to `BotSentMessage` (which promises `delete` too). A
  // placeholder with `edit` but no `delete` made `resolveIfUnused` call a
  // nonexistent method, log a warning, and leave the placeholder stranded —
  // the exact failure mode issue 1 exists to prevent.
  test("a placeholder with edit but no delete is not used at all — falls back, placeholder left stranded", async () => {
    const { bot, handlers } = fakeBot();
    const events: string[] = [];
    let postCalls = 0;
    const thread: BotThread = {
      id: "C1:1721800000.000100",
      post: async (text: string) => {
        postCalls += 1;
        events.push(`post:${text}`);
        if (postCalls === 1) {
          // edit-capable, but NOT delete-capable
          return { edit: async () => {}, addReaction: async () => {} };
        }
        return {};
      },
      subscribe: async () => {},
    };
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("normal reply");
      },
      thinkingIndicator: true,
      logger: { warn: () => {} },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    // Falls back to a normal post for the real answer rather than trying to
    // edit a placeholder that can't be deleted if left unused.
    expect(events).toEqual(["post:_Working on it…_", "post:normal reply"]);
  });

  // Regression: when the placeholder can be deleted but not edited, the old
  // code returned `undefined` after the placeholder was already posted,
  // leaving it stranded above the real answer forever.
  test("a placeholder with delete but no edit is retracted instead of littering the thread", async () => {
    const { bot, handlers } = fakeBot();
    const events: string[] = [];
    let postCalls = 0;
    const thread: BotThread = {
      id: "C1:1721800000.000100",
      post: async (text: string) => {
        postCalls += 1;
        events.push(`post:${text}`);
        if (postCalls === 1) {
          // delete-capable, but NOT edit-capable
          return {
            delete: async () => {
              events.push("delete");
            },
            addReaction: async () => {},
          };
        }
        return {};
      },
      subscribe: async () => {},
    };
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("normal reply");
      },
      thinkingIndicator: true,
      logger: { warn: () => {} },
    });

    await handlers.mention!(thread, { text: "hi", author: human });

    expect(events).toEqual([
      "post:_Working on it…_",
      "delete",
      "post:normal reply",
    ]);
  });
});

describe("wireBot ambient bot-guard", () => {
  test("an ambient message whose isBot only resolves to true via userLookup is still blocked", async () => {
    // Regression: the guard used to run on the raw platform isBot flag
    // *before* userLookup resolution, so a platform report of "unknown"
    // that resolved to `true` via users.info still reached onThreadMessage.
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {},
      onThreadMessage: async () => {
        calls += 1;
      },
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

    await handlers.subscribed!(thread, {
      text: "deploy finished",
      author: { ...human, isBot: "unknown" as const },
    });

    expect(calls).toBe(0);
  });

  test("an ambient message with unresolved isBot ('unknown') never dispatches — fails closed, not open", async () => {
    // Regression: the guard was `message.author.isBot !== true`, which lets
    // "unknown" provenance through. Bot-to-bot loops are the disaster case
    // this guard exists to prevent, so unresolved provenance must deny.
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {},
      onThreadMessage: async () => {
        calls += 1;
      },
      // no userLookup: isBot stays "unknown" through toEvent's resolution
    });

    await handlers.subscribed!(thread, {
      text: "deploy finished",
      author: { ...human, isBot: "unknown" as const },
    });

    expect(calls).toBe(0);
  });

  test("an ambient message confirmed human (isBot: false) still dispatches", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    let calls = 0;
    wireBot(bot, {
      onTag: async () => {},
      onThreadMessage: async () => {
        calls += 1;
      },
    });

    await handlers.subscribed!(thread, { text: "hi", author: human });

    expect(calls).toBe(1);
  });
});

describe("wireBot markdown normalization", () => {
  test("tagThread.post() converts markdown to Slack mrkdwn before posting", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("**bold** and [a link](https://example.com)");
      },
    });

    await handlers.mention!(thread, { text: "@scout status?", author: human });

    expect(posts).toEqual(["*bold* and <https://example.com|a link>"]);
  });

  test("a thinking-indicator placeholder edit also receives mrkdwn-converted text", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, events } = fakeEditableThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("# Result\n- done");
      },
      thinkingIndicator: true,
    });

    await handlers.mention!(thread, { text: "@scout status?", author: human });

    expect(events).toContain("edit:*Result*\n• done");
  });

  test("tagThread.post(text, { convertMarkdown: false }) skips mrkdwn conversion", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();
    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("**not converted**", { convertMarkdown: false });
      },
    });

    await handlers.mention!(thread, { text: "@scout status?", author: human });

    expect(posts).toEqual(["**not converted**"]);
  });
});

describe("wireBot Block Kit replies (TagThread.post blocks)", () => {
  /** Captures the request body Slack's `chat.postMessage` would receive. */
  function fakeSlackFetch() {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
        status: 200,
      });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  test("blocks + a bot token → posts to chat.postMessage with text as fallback", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();
    const { calls, fetchImpl } = fakeSlackFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      wireBot(bot, {
        botToken: "xoxb-test",
        onTag: async (_event, tagThread) => {
          await tagThread.post("Deal Brief: Modal", {
            blocks: [{ type: "header", text: { type: "plain_text", text: "Modal" } }],
          });
        },
      });

      await handlers.mention!(thread, { text: "@scout brief", author: human });

      // The Block Kit path bypasses `thread.post()` entirely — it calls
      // Slack's `chat.postMessage` directly (see `postBlockKitMessage`).
      expect(posts).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
      const body = calls[0]!.body;
      expect(body.get("channel")).toBe("C1");
      expect(body.get("thread_ts")).toBe("1721800000.000100");
      expect(body.get("text")).toBe("Deal Brief: Modal");
      expect(JSON.parse(body.get("blocks")!)).toEqual([
        { type: "header", text: { type: "plain_text", text: "Modal" } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unfurl suppression sends a text-only post through the Web API with the flags", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();
    const { calls, fetchImpl } = fakeSlackFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      wireBot(bot, {
        botToken: "xoxb-test",
        onTag: async (_event, tagThread) => {
          await tagThread.post("no preview please https://example.com/x", {
            unfurlLinks: false,
            unfurlMedia: false,
          });
        },
      });

      await handlers.mention!(thread, { text: "@scout brief", author: human });

      // The SDK's thread.post has no unfurl surface, so this takes the Web
      // API path — text only, no `blocks` key.
      expect(posts).toEqual([]);
      expect(calls).toHaveLength(1);
      const body = calls[0]!.body;
      expect(body.get("text")).toBe("no preview please https://example.com/x");
      expect(body.get("unfurl_links")).toBe("false");
      expect(body.get("unfurl_media")).toBe("false");
      expect(body.get("blocks")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unfurl flags ride along with Block Kit posts too", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const { calls, fetchImpl } = fakeSlackFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      wireBot(bot, {
        botToken: "xoxb-test",
        onTag: async (_event, tagThread) => {
          await tagThread.post("card", {
            blocks: [{ type: "divider" }],
            unfurlLinks: false,
          });
        },
      });

      await handlers.mention!(thread, { text: "@scout brief", author: human });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.get("unfurl_links")).toBe("false");
      expect(JSON.parse(calls[0]!.body.get("blocks")!)).toEqual([
        { type: "divider" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unfurl suppression without a bot token degrades to the plain SDK post", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();

    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("plain", { unfurlLinks: false });
      },
    });

    await handlers.mention!(thread, { text: "@scout brief", author: human });

    expect(posts).toEqual(["plain"]);
  });

  test("blocks without a bot token falls back to plain thread.post(text), blocks dropped", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();

    wireBot(bot, {
      onTag: async (_event, tagThread) => {
        await tagThread.post("plain answer", {
          blocks: [{ type: "header", text: { type: "plain_text", text: "Modal" } }],
        });
      },
    });

    await handlers.mention!(thread, { text: "@scout brief", author: human });

    expect(posts).toEqual(["plain answer"]);
  });

  test("an empty blocks array behaves like a plain post — no Slack API call", async () => {
    const { bot, handlers } = fakeBot();
    const { thread, posts } = fakeThread();
    const { calls, fetchImpl } = fakeSlackFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      wireBot(bot, {
        botToken: "xoxb-test",
        onTag: async (_event, tagThread) => {
          await tagThread.post("plain answer", { blocks: [] });
        },
      });

      await handlers.mention!(thread, { text: "@scout brief", author: human });

      expect(posts).toEqual(["plain answer"]);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("convertMarkdown: false protects the Block Kit fallback text too, not just the plain-post path", async () => {
    const { bot, handlers } = fakeBot();
    const { thread } = fakeThread();
    const { calls, fetchImpl } = fakeSlackFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      wireBot(bot, {
        botToken: "xoxb-test",
        onTag: async (_event, tagThread) => {
          await tagThread.post("*already mrkdwn*", {
            convertMarkdown: false,
            blocks: [{ type: "divider" }],
          });
        },
      });

      await handlers.mention!(thread, { text: "@scout brief", author: human });

      // Had the opt-out only guarded the plain-post path, this would have
      // been re-run through `mdToMrkdwn` a second time on its way into the
      // Block Kit fallback `text` field.
      expect(calls[0]!.body.get("text")).toBe("*already mrkdwn*");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
