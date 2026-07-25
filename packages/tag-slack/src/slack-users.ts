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

const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";
const REQUEST_TIMEOUT_MS = 5_000;

export type SlackUserProfile = {
  email: string | undefined;
  /**
   * Slack marks accounts from other workspaces in a Connect/shared channel as
   * guests or restricted. Hosts should fail closed on these rather than trust
   * an email their own workspace never verified.
   */
  isRestricted: boolean;
  isBot: boolean;
};

export type SlackUserLookup = (
  userId: string,
) => Promise<SlackUserProfile | null>;

type UsersInfoResponse = {
  ok?: boolean;
  error?: string;
  user?: {
    is_bot?: boolean;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
    is_stranger?: boolean;
    profile?: { email?: string };
  };
};

export function createSlackUserLookup(botToken: string): SlackUserLookup {
  const cache = new Map<string, SlackUserProfile | null>();

  return async function lookup(userId) {
    const cached = cache.get(userId);
    if (cached !== undefined) return cached;

    let json: UsersInfoResponse;
    try {
      const res = await fetch(
        `${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`,
        {
          headers: { authorization: `Bearer ${botToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      json = (await res.json()) as UsersInfoResponse;
    } catch (err) {
      // A transient Slack failure must not be cached — otherwise one blip
      // permanently denies that user for the life of the process.
      console.warn(
        `tag-slack: users.info failed for ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }

    if (!json.ok || !json.user) {
      // `missing_scope` here almost always means users:read.email was not
      // granted — worth calling out by name, it is the #1 setup mistake.
      console.warn(
        `tag-slack: users.info returned not-ok for ${userId}: ${
          json.error ?? "unknown"
        }`,
      );
      if (json.error === "missing_scope") {
        console.warn(
          "tag-slack: the bot token is missing the `users:read.email` scope; " +
            "TagAuthor.email/isRestricted cannot be populated without it",
        );
      }
      // A definitive negative (user_not_found) is safe to cache; an ambiguous
      // scope/config error is not, since fixing the scope should take effect
      // without a process restart.
      if (json.error === "user_not_found") cache.set(userId, null);
      return null;
    }

    const profile: SlackUserProfile = {
      email: json.user.profile?.email,
      isRestricted:
        json.user.is_restricted === true ||
        json.user.is_ultra_restricted === true ||
        json.user.is_stranger === true,
      isBot: json.user.is_bot === true,
    };
    cache.set(userId, profile);
    return profile;
  };
}
