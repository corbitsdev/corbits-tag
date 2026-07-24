# Product

## What this is

Corbits Tag is the reusable chat-tag ingress for Interchange hubs. Tag the
bot in a thread (Slack first) and the mention routes into the host's
dispatch as a normalized `TagEvent`; the host's reply lands back in the
thread. After the first tag the bot can subscribe to the thread — ambient
membership — receiving every subsequent message so the host can decide when
speaking adds value (default posture: silence).

## What it is not

- Not an agent tool — no agent calls it; it *causes* agents/workflows to run.
- Not an auth system — Slack signature verification only; identity mapping
  belongs to the host.
- Not a bot framework — the Chat SDK is the framework; this package is the
  mount + contract layer that makes tags an Interchange-shaped capability.

## Who it's for

Interchange deployments that want a chat-native front door: mention →
conversation or workflow run → reply in-thread. First consumer: the Scout
due-diligence demo (Scout-as-agent, one agent per thread, diligence
workflows initiated as catalog actions).

## Shape

- `@corbits/tag-core` — contracts (`TagEvent`, `TagThread`, `TagDispatch`).
- `@corbits/tag-slack` — `mountSlackTag(app, opts)`; Chat SDK Slack adapter;
  one webhook route; mention + subscribed-message wiring.
- Future: `@corbits/tag-telegram`, `@corbits/tag-teams` on the same contract.
