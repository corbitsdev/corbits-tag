# Architecture

## Composition

```
Slack ──POST /api/tag/slack/webhook──▶ host Hono app
                                          │ mountSlackTag
                                          ▼
                                   Chat SDK bot (slack adapter)
                                   signature verify · dedupe · thread state
                                          │ onNewMention / onSubscribedMessage
                                          ▼
                                       wireBot
                                normalize → TagEvent + TagThread
                                          │
                                          ▼
                              host dispatch (onTag / onThreadMessage)
```

## Decisions

1. **Mount contract mirrors `@corbits/knowledge-engine`.** Mount onto the
   host's app, return handles, authenticate nothing beyond transport
   verification, fail loudly on misuse. One deliberate divergence: the
   webhook route mounts *outside* session auth, because the caller (Slack)
   is not a principal.
2. **Chat SDK owns the platform layer.** Webhook verification, retries and
   dedupe, thread subscription state, markdown conversion, streaming — all
   delegated. This package owns only normalization and the dispatch
   contract. `bot.webhooks.slack` is a fetch-style handler, so the Hono
   seam is one line: `app.post(path, (c) => bot.webhooks.slack(c.req.raw))`.
3. **`wireBot` is the testable seam.** Handler wiring is a pure function
   over a structural `TagBot`, so behavior tests need no Slack, no state
   backend, no network.
4. **Core types are platform-free.** Dispatch written against
   `@corbits/tag-core` ports to future adapters (Telegram, Teams)
   unchanged.
5. **State backend is host-supplied.** Subscription/dedupe state needs a
   store (Redis or Postgres Chat SDK adapters); the host chooses and owns
   it — this package takes a `StateAdapter`, never a connection string.

## Event routing rules

- Mention anywhere → `onTag` (`isMention: true`); thread auto-subscribes
  unless `subscribeOnMention: false`.
- Non-mention message in a subscribed thread → `onThreadMessage`
  (`isMention: false`); absent handler = silently ignored.
- Mention inside a subscribed thread → `onTag`, not `onThreadMessage`.
- Bot-authored messages are dropped before dispatch.
