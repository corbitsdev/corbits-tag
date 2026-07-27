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
      ok: true,
      profile: {
        email: "ada@example.com",
        emailVerified: false,
        isRestricted: false,
        isBot: false,
      },
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

    expect(profile.ok && profile.profile.isRestricted).toBe(true);
    expect(profile.ok && profile.profile.email).toBeUndefined();
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

    expect(first).toEqual({ ok: false, reason: "not_found" });
    expect(second).toEqual(first);
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

    expect(first).toEqual({ ok: false, reason: "unavailable" });
    expect(second.ok && second.profile.email).toBe("ada@example.com");
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

    // Unavailable, not "no such user": fixing the scope must take effect
    // without a restart, so this outcome is never cached.
    expect(first).toEqual({ ok: false, reason: "unavailable" });
    expect(second).toEqual(first);
    expect(calls).toBe(2);
  });
});

describe("failures are never mistaken for a profile", () => {
  test("an HTTP error whose body parses is not read as a profile", async () => {
    // A 500 from a proxy that happens to return {"ok":true} once produced a
    // fully-populated bogus profile — and cached it for the process lifetime.
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ ok: true, user: { is_bot: false, profile: {} } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });

    const lookup = createSlackUserLookup("xoxb-test");
    expect(await lookup("U123")).toEqual({ ok: false, reason: "unavailable" });
    // Not cached: the next mention retries rather than being stuck.
    await lookup("U123");
    expect(calls).toBe(2);
  });

  test("a profile field in an unexpected shape does not become the email", async () => {
    // Slack returning an object where a string is documented used to be cast
    // to `string` and thrown far away, inside the unguarded dispatch path.
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        user: { is_bot: false, profile: { email: { primary: "a@b.c" } } },
      }),
    );

    const result = await createSlackUserLookup("xoxb-test")("U123");
    expect(result.ok && result.profile.email).toBeUndefined();
  });

  test("reads is_email_confirmed", async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        user: {
          is_bot: false,
          is_email_confirmed: true,
          profile: { email: "ada@example.com" },
        },
      }),
    );

    const result = await createSlackUserLookup("xoxb-test")("U123");
    expect(result.ok && result.profile.emailVerified).toBe(true);
  });

  test("an unconfirmed email is reported as unverified, not dropped", async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        user: { is_bot: false, profile: { email: "squatter@example.com" } },
      }),
    );

    const result = await createSlackUserLookup("xoxb-test")("U123");
    expect(result.ok && result.profile.email).toBe("squatter@example.com");
    expect(result.ok && result.profile.emailVerified).toBe(false);
  });
});
