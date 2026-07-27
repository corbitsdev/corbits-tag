# @corbits/tag-interchange

Binds a chat author to an Interchange principal by email. This is the piece
that lets a mountable tag package (e.g. `@corbits/tag-slack`) answer as a
specific, real Interchange identity instead of trusting whatever a platform
event claims.

`tag-core` is transport contracts with zero dependencies; `tag-slack` and
friends are platform adapters. Neither should know about Interchange identity —
that dependency belongs here, in a package only hosts mounting onto an
Interchange hub need to install.

Two halves:

- `createPrincipalResolver` — read-only lookup. Never writes, never decides.
- `provisionPrincipal` — the explicit write: creates the account a chat
  author never signed up for.

## Resolving

```ts
import { createPrincipalResolver } from "@corbits/tag-interchange";

const resolve = createPrincipalResolver({ db, tenantSlug: "acme" });

const result = await resolve(author);
// { ok: true,  principal: { principalId, tenantId, userId, email } }
// { ok: false, reason: UnresolvedReason, tenantId, email }
```

`author` is an `AuthorIdentity` (or `null` if the host's own profile lookup
failed):

```ts
type AuthorIdentity = {
  userId: string;
  email: string | undefined;
  emailVerified: boolean | "unknown";
  isRestricted: boolean | "unknown";
  isBot: boolean | "unknown";
};
```

This is deliberately **not** `@corbits/tag-core`'s `TagAuthor` yet — main still
lacks `email` / `isRestricted` (tracked in
[CL-4510](https://linear.app/abklabs/issue/CL-4510)). Once those land with the
same unions, a host can pass a `TagAuthor` through after any remaining
platform-specific mapping. Until then the host builds an `AuthorIdentity`
itself (e.g. from a cached Slack `users.info` call).

### Resolution chain

Mirrors `resolvePrincipal` in Interchange's `hub-api/src/middleware/git-token-auth.ts`
— the in-tree precedent for a non-session auth path:

> tenant by slug → author email → better-auth user (case-folded) → `principal`
> where `(tenantId, kind: "user", refId: userId)` → assert `status === "active"`

The principal is **read from the `principal` table, never synthesized**, so
grants still evaluate normally. This supplies authentication from a
non-session trust root; it does not bypass authorization — every grant is
still evaluated against a real principal row, exactly as it would be for a
session-authenticated user.

### `UnresolvedReason`

The resolver reports what it found; it does not decide whether an asker should
be turned away. Two exceptions are hard-coded rather than left to the host —
see "What the resolver decides for itself" below.

| Reason               | Meaning                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `lookup_failed`      | `author` was `null` — the host's own profile lookup returned nothing.       |
| `bot_author`         | `isBot === true`. Not a person.                                             |
| `restricted_author`  | `isRestricted === true`. Guest or shared-channel account from another workspace. |
| `no_email`           | No usable email after trimming — host couldn't read one, or it was blank.  |
| `no_account`         | Email doesn't match any `user` row. Same-workspace member, unprovisioned.  |
| `not_a_member`       | User row exists, but no `principal` row for `(tenantId, kind: "user", refId)`. |
| `principal_inactive` | Principal row exists but `status !== "active"`.                            |
| `tenant_not_found`   | `tenantSlug` doesn't match any `tenant` row — a misconfiguration, not the asker's fault. |

Every `ok: false` result carries `tenantId` and `email` when the resolver got
far enough to learn them, so the host can call `provisionPrincipal` without
re-querying anything.

`emailVerified` is read but never gates resolution here — verification is not
this resolver's business; it's context the host may use to decide whether to
provision. `"unknown"` in `isBot` / `isRestricted` is never collapsed to a
deny — the resolver cannot tell "confirmed not a bot" from "couldn't find
out," and only a confirmed `true` short-circuits (see below).

### What the resolver decides for itself

`isBot === true` and `isRestricted === true` are checked before any query and
return `bot_author` / `restricted_author` without touching the database. This
is not a policy call about who's *eligible* — it's a claim about what the
resolver *can* bind: a definite bot or a definite guest from another workspace
isn't the kind of identity this resolver deals in. Everything else — whether
an unverified email, an unprovisioned colleague, or a suspended membership
should be provisioned, refused, or escalated — is left entirely to the host.

## Provisioning

```ts
import { provisionPrincipal } from "@corbits/tag-interchange";

const principal = await provisionPrincipal(db, {
  tenantId,
  email: author.email,
  name: author.displayName,
  roles: ["chat-member"],
});
```

`provisionPrincipal` creates the account a chat author never signed up for —
the whole point of a chat integration is that they never leave chat to do it
themselves. It's transactional and idempotent: it upserts against the
existing unique constraints (`user.email`, `(tenantId, kind, refId)` on
`principal`) rather than checking-then-inserting, so two mentions landing in
the same window don't produce a duplicate or throw.

The created `user` row carries no credential — under better-auth, credentials
live in the separate `account` table, so a row created here can't be signed
into. `emailVerified` is set `false` and stays that way: the platform
confirmed this address for its own purposes (e.g. Slack's own verification),
which is not the same as this app verifying it. When the person later signs
in for real (Google, Slack OAuth, etc.), better-auth matches them by email and
they arrive at this same principal, with its grants and history already
attached.

Roles vs. direct grants:

- **Prefer `roles`** for anything more than one person. A role is one grant
  plus one membership row per person; changing what everyone can read is a
  single update, and revoking one person is a single delete.
- **Use `grants`** only for a genuine exception — a grant bound to this one
  principal that no role should carry.

A role name that doesn't exist throws `ProvisionError` and rolls back the
whole transaction — a typo'd role silently granting nothing is worse than a
throw, since the principal would exist and authorize nothing. An empty or
whitespace-only email also throws `ProvisionError` before any write.

## Mechanism vs. policy

This package supplies mechanism, not policy. `createPrincipalResolver` reports
facts (does an account exist, is it a member, is it active); `provisionPrincipal`
performs a write when told to. Neither package decides *who* gets an account
or *what* they can do once they have one — that's the host's call, informed by
whatever it knows about the platform (verified email, workspace membership,
admin allowlist, etc.).

A realistic host might provision on `no_account` and `not_a_member`, and
refuse everything else:

```ts
const result = await resolve(author);

if (result.ok) {
  return runAsPrincipal(result.principal);
}

switch (result.reason) {
  case "no_account":
  case "not_a_member": {
    const principal = await provisionPrincipal(db, {
      tenantId: result.tenantId!,
      email: result.email!,
      name: author.displayName,
      roles: ["chat-member"],
    });
    return runAsPrincipal(principal);
  }
  default:
    // bot_author, restricted_author, no_email, principal_inactive,
    // tenant_not_found, lookup_failed: refuse. See UNRESOLVED_MESSAGE
    // for asker-facing text per reason.
    return refuse(UNRESOLVED_MESSAGE[result.reason]);
}
```

A host with a stricter policy — say, only provisioning verified-email members
of an allowlisted workspace — checks `author.emailVerified` and its own
allowlist before calling `provisionPrincipal`, and refuses `no_account`
otherwise. That decision belongs entirely outside this package.

## Security posture

This supplies authentication from a non-session trust root: a platform
ingress mounts outside session auth, so the only thing proven before the
resolver runs is that the event came from the configured workspace — nothing
about who may read what. Matching the author's email to an existing
`principal` row turns that into an identity the way Linear's Slack
integration does, without a per-user auth step.

This does **not** bypass authorization. The resolved principal is always a
real row from the `principal` table — never synthesized — so every grant is
evaluated against it exactly as it would be for a session-authenticated user.
A provisioned principal starts with only the roles and grants the host
explicitly attaches; provisioning an account is not the same as granting it
anything.
