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
