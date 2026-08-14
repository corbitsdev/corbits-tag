import { describe, expect, test } from "bun:test";

import {
  createSlackFileFetcher,
  createSlackFileLookup,
} from "./slack-files.ts";

describe("createSlackFileFetcher", () => {
  test("fetches a private Slack file with the configured bearer token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("deck", { status: 200 });
    }) as unknown as typeof fetch;
    const fetchFile = createSlackFileFetcher(" xoxb-test ", { fetchImpl });

    const response = await fetchFile(
      "https://files.slack.com/files-pri/T1-F1/deck.pdf",
    );

    expect(await response.text()).toBe("deck");
    expect(calls).toEqual([
      {
        url: "https://files.slack.com/files-pri/T1-F1/deck.pdf",
        authorization: "Bearer xoxb-test",
      },
    ]);
  });

  test("rejects a non-Slack URL before exposing the token to fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    const fetchFile = createSlackFileFetcher("xoxb-secret", { fetchImpl });

    await expect(fetchFile("https://example.com/deck.pdf")).rejects.toThrow(
      /https Slack file URL/,
    );
    expect(fetchCalls).toBe(0);
  });

  test("requires a non-empty bot token", () => {
    expect(() => createSlackFileFetcher("  ")).toThrow(/bot token is required/);
  });
});

describe("createSlackFileLookup", () => {
  test("resolves and caches an id-only Slack file through files.info", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        ok: true,
        file: {
          id: "F0BLCLASS11",
          name: "scout-deck-2026-07-27.pptx.pdf",
          mimetype: "application/pdf",
          size: 3_400_000,
          url_private: "https://files.slack.com/preview",
          url_private_download: "https://files.slack.com/download/scout.pdf",
          private_metadata: "must not leak",
        },
      });
    }) as unknown as typeof fetch;
    const lookup = createSlackFileLookup(" xoxb-test ", { fetchImpl });

    const first = await lookup("F0BLCLASS11");
    const second = await lookup("F0BLCLASS11");

    expect(first).toEqual({
      ok: true,
      file: {
        id: "F0BLCLASS11",
        name: "scout-deck-2026-07-27.pptx.pdf",
        mimeType: "application/pdf",
        size: 3_400_000,
        url: "https://files.slack.com/download/scout.pdf",
      },
    });
    expect(second).toEqual(first);
    expect(calls).toEqual([
      {
        url: "https://slack.com/api/files.info?file=F0BLCLASS11",
        authorization: "Bearer xoxb-test",
      },
    ]);
  });

  test("does not cache a transient files.info failure", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    const lookup = createSlackFileLookup("xoxb-test", {
      fetchImpl,
      logger: { warn: () => {} },
    });

    expect(await lookup("F1")).toEqual({ ok: false, reason: "unavailable" });
    expect(await lookup("F1")).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toBe(2);
  });
});
