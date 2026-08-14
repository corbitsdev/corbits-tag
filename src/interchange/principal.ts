/**
 * Chat author -> Interchange principal, by verified email.
 *
 * A platform ingress mounts outside session auth, so the only thing proven
 * before this resolver runs is that the event came from the workspace we
 * configured — nothing about who may read what. This turns that into an
 * identity the way Linear's Slack integration does: match the author's
 * verified email to an existing account, no per-user auth step.
 *
 * The returned principal is read from the `principal` table, never
 * synthesized, so Interchange's grants still evaluate normally. This supplies
 * authentication from a different trust root; it does not bypass
 * authorization. Chain mirrors `resolvePrincipal` in Interchange's
 * `hub-api/src/middleware/git-token-auth.ts`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import { principal, tenant, user } from "@intx/db/schema";

/**
 * What the host verified about an author before calling the resolver. Not
 * `tag-core`'s `TagAuthor` yet — that lacks `email`/`isRestricted` (CL-4510).
 * Once it has them, a `TagAuthor` satisfies this structurally.
 */
export type AuthorIdentity = {
  /** Platform-unique id, for logging and correlation. */
  userId: string;
  email: string | undefined;
  /**
   * Whether the platform confirmed the author controls `email`. `"unknown"`
   * when the adapter could not find out — never collapse that to `false`,
   * since a host deciding whether to create an account keyed on this address
   * cannot tell an unverified address from an unasked question.
   */
  emailVerified: boolean | "unknown";
  /** Guest or shared-channel account from another workspace. */
  isRestricted: boolean | "unknown";
  isBot: boolean | "unknown";
};

/** `null` means the host's profile lookup failed — nothing was verified. */
export type AuthorLookup = AuthorIdentity | null;

export type ResolvedPrincipal = {
  principalId: string;
  tenantId: string;
  /** Absent for `shared` — it stands for no particular human. */
  userId: string | undefined;
  email: string | undefined;
};

/**
 * Why an author did not resolve to a principal.
 *
 * These are findings, not verdicts. Whether a bot, a guest or an unprovisioned
 * colleague should be refused is the host's policy — `principal.kind` includes
 * `agent`, so a package that hard-denied bots would foreclose the model
 * Interchange already supports. The resolver reports; the host decides.
 */
export type UnresolvedReason =
  | "lookup_failed"
  | "bot_author"
  | "restricted_author"
  | "no_email"
  | "no_account"
  | "not_a_member"
  | "principal_inactive"
  | "tenant_not_found";

export type PrincipalResolution =
  | { ok: true; principal: ResolvedPrincipal }
  | {
      ok: false;
      reason: UnresolvedReason;
      /**
       * Everything the resolver learned on the way, so the host can apply its
       * own policy without repeating the lookups. `tenantId` is present once
       * the configured tenant has been found; `email` once one was read.
       */
      tenantId: string | undefined;
      email: string | undefined;
    };

/**
 * Suggested asker-facing text per reason. Hosts may override — these are
 * deliberately vague, since telling an unknown asker exactly which check they
 * failed is itself a small disclosure.
 */
export const UNRESOLVED_MESSAGE: Record<UnresolvedReason, string> = {
  lookup_failed:
    "I couldn't verify who you are just now. Try again in a moment.",
  bot_author: "I don't answer other bots.",
  restricted_author:
    "I can only answer people in this workspace — guest and shared-channel accounts aren't mapped to an Interchange identity.",
  no_email:
    "I couldn't read a verified email for you, so I can't tell which Interchange account you are.",
  no_account: "I don't have an account for you yet.",
  not_a_member:
    "Your Interchange account isn't a member of this tenant, so I have nothing I'm allowed to show you.",
  principal_inactive:
    "Your Interchange membership isn't active, so I can't run a search as you.",
  tenant_not_found:
    "This integration is misconfigured — its tenant doesn't exist. This is an operator problem, not yours.",
};

export type PrincipalResolverDeps = {
  db: DB["db"];
  tenantSlug: string;
};

export type PrincipalResolver = (
  author: AuthorLookup,
) => Promise<PrincipalResolution>;

/**
 * Resolves a chat author to an existing principal. Read-only.
 *
 * Deliberately makes no policy decision and creates nothing. It reports what
 * it found — including `bot_author` and `restricted_author`, which it does not
 * treat as terminal — and leaves refusing, provisioning or upgrading to the
 * host. See `provisionPrincipal` for the write half.
 */
export function createPrincipalResolver(
  deps: PrincipalResolverDeps,
): PrincipalResolver {
  const { db, tenantSlug } = deps;

  return async function resolve(author) {
    const unresolved = (
      reason: UnresolvedReason,
      tenantId?: string,
      email?: string,
    ): PrincipalResolution => ({ ok: false, reason, tenantId, email });

    if (!author) return unresolved("lookup_failed");
    if (author.isBot === true) return unresolved("bot_author");
    if (author.isRestricted === true) return unresolved("restricted_author");

    const email = author.email?.trim().toLowerCase();
    if (!email) return unresolved("no_email");

    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenant.slug, tenantSlug),
    });
    if (!tenantRow) return unresolved("tenant_not_found", undefined, email);

    // Folds both sides: better-auth preserves signup casing and `user.email`
    // is case-sensitive `text`, so lowercasing only the input silently misses.
    const userRow = await db.query.user.findFirst({
      where: sql`lower(${user.email}) = ${email}`,
    });
    if (!userRow) return unresolved("no_account", tenantRow.id, email);

    const principalRow = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantRow.id),
        eq(principal.kind, "user"),
        eq(principal.refId, userRow.id),
      ),
    });
    if (!principalRow) return unresolved("not_a_member", tenantRow.id, email);
    if (principalRow.status !== "active") {
      return unresolved("principal_inactive", tenantRow.id, email);
    }

    return {
      ok: true,
      principal: {
        principalId: principalRow.id,
        tenantId: tenantRow.id,
        userId: userRow.id,
        email,
      },
    };
  };
}
