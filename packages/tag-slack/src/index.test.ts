import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountSlackTag, shouldAutoWireUserLookup } from "./index.ts";

// A structurally valid StateAdapter is heavy to fake; the mount test focuses
// on the seams this package owns (option validation, route registration).
// Handler behavior is covered in wire.test.ts against the wireBot seam.

/** Every method resolves to undefined — enough for Chat's lazy init path. */
const noopState = () =>
  new Proxy({}, { get: () => async () => undefined }) as never;

describe("mountSlackTag", () => {
  test("throws loudly when onTag is missing", () => {
    const app = new Hono();
    expect(() =>
      mountSlackTag(app, {
        userName: "scout",
        state: noopState(),
        slack: { botToken: "xoxb-test", signingSecret: "shhh" },
      } as never),
    ).toThrow(/onTag/);
  });

  test("mounts the webhook POST route at the default path", async () => {
    const app = new Hono();
    const { path } = mountSlackTag(app, {
      userName: "scout",
      // never used before a webhook arrives — Chat initializes lazily
      state: noopState(),
      slack: { botToken: "xoxb-test", signingSecret: "shhh" },
      onTag: async () => {},
    });

    expect(path).toBe("/api/tag/slack/webhook");
    // An unsigned request must be rejected by the adapter's verification —
    // any response proves the route exists (404 would mean it doesn't).
    const res = await app.request(path, { method: "POST", body: "{}" });
    expect(res.status).not.toBe(404);
  });

  test("honors a custom path", () => {
    const app = new Hono();
    const { path } = mountSlackTag(app, {
      userName: "scout",
      state: noopState(),
      slack: { botToken: "xoxb-test", signingSecret: "shhh" },
      path: "/hooks/slack",
      onTag: async () => {},
    });
    expect(path).toBe("/hooks/slack");
  });
});

describe("shouldAutoWireUserLookup", () => {
  test("auto-wires when a bot token is present and userLookup was never mentioned", () => {
    expect(shouldAutoWireUserLookup({}, "xoxb-test")).toBe(true);
  });

  test("never auto-wires without a bot token", () => {
    expect(shouldAutoWireUserLookup({}, undefined)).toBe(false);
  });

  test("a host-supplied userLookup is never replaced by the auto-wired one", () => {
    expect(
      shouldAutoWireUserLookup({ userLookup: async () => ({ ok: false, reason: "unavailable" }) }, "xoxb-test"),
    ).toBe(false);
  });

  test("userLookup: undefined explicitly disables auto-wiring even with a bot token present", () => {
    // Regression: index.ts documents `userLookup: undefined` as the way to
    // opt out of auto-wired identity lookup, but the mount used to check
    // `!options.userLookup`, which is also true for "never mentioned it" —
    // so it silently re-enabled lookup anyway. `"userLookup" in options` is
    // true here (the key was set, just to `undefined`), so this must be false.
    expect(shouldAutoWireUserLookup({ userLookup: undefined }, "xoxb-test")).toBe(false);
  });
});
