import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createSlackUserLookup } from "./slack-users.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** `spyOn`'s mock must match `typeof fetch` exactly (incl. `preconnect`); a
 * plain async function covers every call this module makes. */
function mockFetch(impl: () => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    impl as unknown as typeof fetch,
  );
}

describe("createSlackUserLookup", () => {
  afterEach(() => {
    (
      globalThis.fetch as unknown as { mockRestore?: () => void }
    ).mockRestore?.();
  });

  test("returns the profile and caches it — a second call does not refetch", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return jsonResponse({
        ok: true,
        user: { is_bot: false, profile: { email: "ada@example.com" } },
      });
    });

    const lookup = createSlackUserLookup("xoxb-test");
    const first = await lookup("U123");
    const second = await lookup("U123");

    expect(first).toEqual({
      email: "ada@example.com",
      isRestricted: false,
      isBot: false,
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("marks is_restricted/is_ultra_restricted/is_stranger as isRestricted", async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        user: { is_bot: false, is_ultra_restricted: true, profile: {} },
      }),
    );

    const lookup = createSlackUserLookup("xoxb-test");
    const profile = await lookup("U999");

    expect(profile?.isRestricted).toBe(true);
    expect(profile?.email).toBeUndefined();
  });

  test("caches a definitive user_not_found", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: "user_not_found" });
    });

    const lookup = createSlackUserLookup("xoxb-test");
    const first = await lookup("Ugone");
    const second = await lookup("Ugone");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });

  test("does not cache a transient network failure — retries on next call", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network blip");
      return jsonResponse({
        ok: true,
        user: { is_bot: false, profile: { email: "ada@example.com" } },
      });
    });

    const lookup = createSlackUserLookup("xoxb-test");
    const first = await lookup("U123");
    const second = await lookup("U123");

    expect(first).toBeNull();
    expect(second?.email).toBe("ada@example.com");
    expect(calls).toBe(2);
  });

  test("does not cache missing_scope — one config fix should take effect immediately", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: "missing_scope" });
    });

    const lookup = createSlackUserLookup("xoxb-test");
    const first = await lookup("U123");
    const second = await lookup("U123");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toBe(2);
  });
});
