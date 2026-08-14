import "./arktype.ts";
import { type } from "arktype";
import { defaultLogger, type Logger } from "./logger.ts";

export type SlackFileFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<Response>;

export type CreateSlackFileFetcherOptions = {
  fetchImpl?: typeof fetch;
};

export type SlackFileMetadata = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  url?: string;
};

export type SlackFileLookupResult =
  | { ok: true; file: SlackFileMetadata }
  | { ok: false; reason: "not_found" | "unavailable" };

export type SlackFileLookup = (
  fileId: string,
) => Promise<SlackFileLookupResult>;

export type CreateSlackFileLookupOptions = {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  requestTimeoutMs?: number;
};

const SlackPrivateFileUrl = type("string").narrow((raw, ctx) => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "slack.com" ||
        host.endsWith(".slack.com") ||
        host === "slack-files.com" ||
        host.endsWith(".slack-files.com"))
    ) {
      return true;
    }
  } catch {
    // The ArkType error below is the public failure shape.
  }
  return ctx.mustBe("an https Slack file URL");
});

const SlackFileInfoEnvelope = type({
  "ok?": "boolean",
  "error?": "string",
  "file?": type({
    "id?": "string",
    "name?": "string",
    "mimetype?": "string",
    "size?": "number",
    "url_private?": "string",
    "url_private_download?": "string",
  }),
}).or("undefined");

const SLACK_FILES_INFO_URL = "https://slack.com/api/files.info";
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Builds an authenticated downloader for Slack `url_private` file URLs.
 * Initial host validation happens before fetch so a forged attachment URL
 * cannot send the bot token directly to an arbitrary origin. Redirect
 * credential handling follows the injected Fetch implementation.
 */
export function createSlackFileFetcher(
  botToken: string,
  options: CreateSlackFileFetcherOptions = {},
): SlackFileFetcher {
  const token = botToken.trim();
  if (token === "") throw new Error("tag-slack: a bot token is required to fetch files");
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (rawUrl, signal) => {
    const url = SlackPrivateFileUrl(rawUrl);
    if (url instanceof type.errors) {
      throw new Error(`tag-slack: ${url.summary}`);
    }
    return await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      ...(signal !== undefined ? { signal } : {}),
    });
  };
}

/**
 * Resolves full metadata for Slack events that expose only a file id.
 * The API origin is fixed; event data is used only as an encoded query value.
 */
export function createSlackFileLookup(
  botToken: string,
  options: CreateSlackFileLookupOptions = {},
): SlackFileLookup {
  const token = botToken.trim();
  if (token === "") throw new Error("tag-slack: a bot token is required to look up files");
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? defaultLogger;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const cache = new Map<string, SlackFileLookupResult>();

  return async (fileId) => {
    const cached = cache.get(fileId);
    if (cached !== undefined) return cached;

    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(
        `${SLACK_FILES_INFO_URL}?file=${encodeURIComponent(fileId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );
      body = await response.json().catch(() => undefined);
    } catch (cause) {
      logger.warn(
        `tag-slack: files.info failed for ${fileId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return { ok: false, reason: "unavailable" };
    }

    if (!response.ok) {
      logger.warn(`tag-slack: files.info HTTP error for ${fileId}`);
      return { ok: false, reason: "unavailable" };
    }

    const parsed = SlackFileInfoEnvelope(body);
    if (parsed instanceof type.errors || parsed === undefined) {
      logger.warn(`tag-slack: files.info returned malformed metadata for ${fileId}`);
      return { ok: false, reason: "unavailable" };
    }
    const raw = parsed.file;
    if (parsed.ok !== true || raw === undefined || raw.id === undefined) {
      const reason =
        parsed.error === "file_not_found" ? "not_found" : "unavailable";
      const result: SlackFileLookupResult = { ok: false, reason };
      if (reason === "not_found") cache.set(fileId, result);
      logger.warn(
        `tag-slack: files.info returned not-ok for ${fileId}: ${
          parsed.error ?? "unknown"
        }`,
      );
      return result;
    }

    const result: SlackFileLookupResult = {
      ok: true,
      file: {
        id: raw.id,
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.mimetype !== undefined ? { mimeType: raw.mimetype } : {}),
        ...(raw.size !== undefined ? { size: raw.size } : {}),
        ...(raw.url_private_download !== undefined
          ? { url: raw.url_private_download }
          : raw.url_private !== undefined
            ? { url: raw.url_private }
            : {}),
      },
    };
    cache.set(fileId, result);
    return result;
  };
}
