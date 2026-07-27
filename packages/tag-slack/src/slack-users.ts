/**
 * Slack user -> email/restriction lookup.
 *
 * `TagAuthor` carries a Slack user id, handle, and display name, but Slack's
 * mention event does not include the profile email or the guest/restricted
 * flags — those require a `users.info` call, which needs the
 * `users:read.email` scope on the bot token (one scope beyond what the tag
 * package itself needs).
 *
 * Results are cached for the process lifetime: a Slack user's email and
 * restriction status rarely change, and the alternative is an API call on
 * every single mention.
 */
import { defaultLogger, type Logger } from "./logger.ts";

const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type SlackUserProfile = {
  email: string | undefined;
  /** Slack's `is_email_confirmed`: the user proved they control `email`. */
  emailVerified: boolean;
  /**
   * Slack marks accounts from other workspaces in a Connect/shared channel as
   * guests or restricted. Hosts should fail closed on these rather than trust
   * an email their own workspace never verified.
   */
  isRestricted: boolean;
  isBot: boolean;
};

/**
 * The outcome of a lookup.
 *
 * `unavailable` is deliberately distinct from a profile with empty fields.
 * Collapsing them is how a rate limit turns into "this guest is an ordinary
 * member": the caller cannot fail closed on a fact it was never told.
 */
export type SlackUserLookupResult =
  | { ok: true; profile: SlackUserProfile }
  | { ok: false; reason: "not_found" | "unavailable" };

export type SlackUserLookup = (
  userId: string,
) => Promise<SlackUserLookupResult>;

type SlackUser = {
  isBot: boolean;
  isRestricted: boolean;
  emailVerified: boolean;
  email: string | undefined;
};

function isTrue(value: unknown): boolean {
  return value === true;
}

/**
 * Reads the fields we use off an untrusted body.
 *
 * Slack's response is not validated by type assertion: a field arriving in an
 * unexpected shape — an object where a string is documented — would otherwise
 * be typed `string`, flow into the author, and throw somewhere far away.
 */
function readSlackUser(body: unknown): SlackUser | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const user = (body as Record<string, unknown>)["user"];
  if (typeof user !== "object" || user === null) return undefined;
  const u = user as Record<string, unknown>;

  const profile = u["profile"];
  const email =
    typeof profile === "object" && profile !== null
      ? (profile as Record<string, unknown>)["email"]
      : undefined;

  return {
    isBot: isTrue(u["is_bot"]),
    isRestricted:
      isTrue(u["is_restricted"]) ||
      isTrue(u["is_ultra_restricted"]) ||
      isTrue(u["is_stranger"]),
    emailVerified: isTrue(u["is_email_confirmed"]),
    email: typeof email === "string" ? email : undefined,
  };
}

export type SlackUserLookupOptions = {
  /** Logging seam; defaults to `console.warn`. */
  logger?: Logger;
  /**
   * Per-request timeout for the `users.info` call. A deployment on a slower
   * network path may need more headroom than the default; a deployment that
   * wants to fail fast toward "unknown" sooner may want less.
   */
  requestTimeoutMs?: number;
};

export function createSlackUserLookup(
  botToken: string,
  options: SlackUserLookupOptions = {},
): SlackUserLookup {
  const logger = options.logger ?? defaultLogger;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Only settled outcomes are cached: a profile, or a definitive "no such
  // user". Anything transient is retried on the next mention.
  const cache = new Map<string, SlackUserLookupResult>();

  return async function lookup(userId) {
    const cached = cache.get(userId);
    if (cached !== undefined) return cached;

    let body: unknown;
    let httpOk: boolean;
    try {
      const res = await fetch(
        `${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`,
        {
          headers: { authorization: `Bearer ${botToken}` },
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );
      httpOk = res.ok;
      body = await res.json().catch(() => undefined);
    } catch (err) {
      // A transient Slack failure must not be cached — otherwise one blip
      // permanently denies that user for the life of the process.
      logger.warn(
        `tag-slack: users.info failed for ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, reason: "unavailable" };
    }

    // A 429 or 5xx whose body happens to parse must not be read as a profile.
    if (!httpOk) {
      logger.warn(`tag-slack: users.info HTTP error for ${userId}`);
      return { ok: false, reason: "unavailable" };
    }

    const envelope =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const slackOk = envelope["ok"] === true;
    const slackError =
      typeof envelope["error"] === "string" ? envelope["error"] : undefined;
    const user = slackOk ? readSlackUser(body) : undefined;

    if (!slackOk || user === undefined) {
      // `missing_scope` here almost always means users:read.email was not
      // granted — worth calling out by name, it is the #1 setup mistake.
      logger.warn(
        `tag-slack: users.info returned not-ok for ${userId}: ${
          slackError ?? "unknown"
        }`,
      );
      if (slackError === "missing_scope") {
        logger.warn(
          "tag-slack: the bot token is missing the `users:read.email` scope; " +
            "author identity cannot be established without it",
        );
      }
      // A definitive negative is safe to cache; an ambiguous scope/config
      // error is not, since fixing the scope should take effect without a
      // process restart.
      if (slackError === "user_not_found") {
        const settled: SlackUserLookupResult = {
          ok: false,
          reason: "not_found",
        };
        cache.set(userId, settled);
        return settled;
      }
      return { ok: false, reason: "unavailable" };
    }

    const result: SlackUserLookupResult = {
      ok: true,
      profile: {
        email: user.email,
        emailVerified: user.emailVerified,
        isRestricted: user.isRestricted,
        isBot: user.isBot,
      },
    };
    cache.set(userId, result);
    return result;
  };
}
