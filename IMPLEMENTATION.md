# Implementation

## Layout

```
packages/
  tag-core/src/
    types.ts        TagEvent / TagThread / TagDispatch / TagAuthor
    index.ts        exports
  tag-slack/src/
    index.ts        mountSlackTag — Chat construction + route mount
    wire.ts         wireBot — handler wiring over a structural TagBot
    slack-users.ts  cached users.info lookup → email / emailVerified /
                    isRestricted (process-lifetime cache; failures not cached)
    *.test.ts       colocated unit tests (mocked boundaries)
  tag-interchange/src/
    principal.ts    createPrincipalResolver — verified email → principal
    principal.test.ts
    index.ts        exports
```

## Notes for maintainers

- **Bun workspace**, no build step — packages ship as source
  (`module`/`exports` point at `src/index.ts`), same posture as the Chat
  SDK itself. `bun run typecheck` is the compile gate.
- **`exactOptionalPropertyTypes` friction:** the Chat SDK's `SlackAdapter`
  type declares optional props without `| undefined`, so it fails strict
  assignment to `Adapter`; `mountSlackTag` casts at that one boundary with
  a comment. Revisit when upstream tightens its types.
- **Structural `TagBot`:** `wire.ts` depends on the minimal slice of the
  Chat SDK it uses (`onNewMention`, `onSubscribedMessage`, `webhooks`).
  This keeps tests trivial and the SDK upgradeable.
- **Author identity lookup:** `mountSlackTag` wires
  `createSlackUserLookup(botToken)` when a token is present. The lookup
  returns `ok`/`failed`; wire maps failure to `"unknown"` on
  `emailVerified`/`isRestricted` and omits `email`. Only settled outcomes
  (profile or definitive `user_not_found`) are cached.
- **Principal binding is Interchange-only.** `@corbits/tag-interchange`
  depends on `@intx/db`; platform packages must not.
- **The resolver reports, the host decides — mostly.** `createPrincipalResolver`
  is read-only: it returns either a principal read from the `principal` table
  or an `UnresolvedReason` describing what it found, carrying the tenant and
  normalised email so the host need not re-query. It never synthesises a
  principal. It does short-circuit two cases before any query — `isBot ===
  true` and `isRestricted === true` — because a definite bot or a definite
  guest from another workspace isn't an identity this resolver can bind, not
  a policy call about who's eligible. `"unknown"` in either field is never
  collapsed to a deny; it falls through and resolves normally, since the
  resolver cannot tell "confirmed not a bot" from "couldn't find out." Every
  other question — whether an unverified email, an unprovisioned colleague,
  or a suspended membership should be refused or provisioned — is policy,
  and policy lives in the host. `provisionPrincipal` is the separate,
  explicit write half.
- **Tests** run with `bun test ./packages`; the mount tests use a Proxy
  no-op `StateAdapter` because Chat initializes state lazily on the first
  webhook. Behavior coverage lives against `wireBot` and
  `createSlackUserLookup`, not the network.

## Follow-ups

- Interchange dispatch package: TagEvent → workflow mail trigger / agent
  connector thread, run↔thread correlation.
- Worth-responding filter + passive knowledge capture (ambient membership).
- Rich replies: Block Kit cards, streaming status updates.
- Telegram/Teams adapters.
- Align `TagAuthor` (CL-4510) with `AuthorIdentity` so hosts can pass
  authors through with less mapping.
