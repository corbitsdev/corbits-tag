/**
 * Create the account a chat author never signed up for.
 *
 * A Slack workspace member has no Interchange account and is not going to make
 * one — the whole point of a chat integration is that they never leave chat.
 * This mints the identity on their behalf so grants can be evaluated normally,
 * rather than routing everyone through a shared principal that the grant layer
 * cannot tell apart.
 *
 * The `user` row carries no credential. Under better-auth, credentials live in
 * the separate `account` table, so a row created here cannot be signed into
 * until a real signup links to it. That is the point: it is a **pre-seeded
 * account**, and when the person later signs in with Google or Slack,
 * better-auth matches them by email and they arrive with this principal, its
 * grants and their history already attached.
 *
 * This module never decides *whether* to provision. That is the host's policy —
 * notably whether an unverified email or a guest is eligible. See
 * `createPrincipalResolver` for the read half.
 */
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { grant, principal, principalRole, role, user } from "@intx/db/schema";

import type { ResolvedPrincipal } from "./principal.ts";

/** A grant attached directly to this principal, for the exception case. */
export type DirectGrant = {
  resource: string;
  action: string;
  effect?: "allow" | "deny" | "ask";
};

export type ProvisionRequest = {
  tenantId: string;
  /** Lower-cased before use; the unique index on `user.email` is case-sensitive. */
  email: string;
  /** Display name, e.g. the author's Slack full name. */
  name: string;
  /**
   * Role names within the tenant. Preferred over `grants` for anything more
   * than one person: a role is one grant plus a membership row each, so
   * changing what everyone can read is a single update and revoking one
   * person is a single delete.
   */
  roles?: readonly string[];
  /** Grants bound to this principal alone. Use when a role would be overkill. */
  grants?: readonly DirectGrant[];
};

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Idempotently ensure a user, a principal and its grants exist.
 *
 * Safe to call on every mention: it upserts against the existing unique
 * constraints rather than checking-then-inserting, so two mentions landing in
 * the same second cannot produce a duplicate or throw.
 */
export async function provisionPrincipal(
  db: DB["db"],
  request: ProvisionRequest,
): Promise<ResolvedPrincipal> {
  const email = request.email.trim().toLowerCase();
  if (!email) throw new ProvisionError("cannot provision without an email");

  return await db.transaction(async (tx) => {
    // `emailVerified` stays false: the platform confirmed this address for its
    // own purposes, which is not the same as this app verifying it. A later
    // real signup does that properly.
    const [userRow] = await tx
      .insert(user)
      .values({
        id: generateId("usr"),
        name: request.name,
        email,
        emailVerified: false,
      })
      .onConflictDoUpdate({
        target: user.email,
        set: { updatedAt: new Date() },
      })
      .returning();

    if (!userRow) throw new ProvisionError(`could not upsert user ${email}`);

    const [principalRow] = await tx
      .insert(principal)
      .values({
        id: generateId("prn"),
        tenantId: request.tenantId,
        kind: "user",
        refId: userRow.id,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [principal.tenantId, principal.kind, principal.refId],
        set: { updatedAt: new Date() },
      })
      .returning();

    if (!principalRow) {
      throw new ProvisionError(`could not upsert principal for ${email}`);
    }

    for (const roleName of request.roles ?? []) {
      const roleRow = await tx.query.role.findFirst({
        where: and(eq(role.tenantId, request.tenantId), eq(role.name, roleName)),
      });
      if (!roleRow) {
        // Loud: a typo'd role silently granting nothing is worse than a throw,
        // because the principal would exist and authorize nothing.
        throw new ProvisionError(
          `role "${roleName}" does not exist in tenant ${request.tenantId}`,
        );
      }
      await tx
        .insert(principalRole)
        .values({ principalId: principalRow.id, roleId: roleRow.id })
        .onConflictDoNothing();
    }

    for (const direct of request.grants ?? []) {
      await tx
        .insert(grant)
        .values({
          id: generateId("grt"),
          tenantId: request.tenantId,
          principalId: principalRow.id,
          resource: direct.resource,
          action: direct.action,
          effect: direct.effect ?? "allow",
          origin: "system",
        })
        .onConflictDoNothing();
    }

    return {
      principalId: principalRow.id,
      tenantId: request.tenantId,
      userId: userRow.id,
      email,
    };
  });
}
