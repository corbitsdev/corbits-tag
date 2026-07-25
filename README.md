# Corbits Tag

Chat-tag **ingress** you mount onto an [Interchange](https://github.com/corbitsdev) hub: tag the bot in a thread and the mention arrives at your dispatch as a normalized event; your reply lands back in the thread.

Two packages:

- **`@corbits/tag-core`** — transport-agnostic contracts: `TagEvent`, `TagThread`, `TagDispatch`. Write dispatch logic once.
- **`@corbits/tag-slack`** — `mountSlackTag(app, opts)` for Slack, built on the [Chat SDK](https://chat-sdk.dev) Slack adapter. Telegram/Teams adapters follow the same contract later.

This is a **bridge, not a tool**: no agent calls it — it pushes thread events _into_ your system and relays replies out. What a tag means (answer, start a workflow, stay silent) is entirely the host's dispatch.

## Install

```bash
bun add @corbits/tag-slack
```

Requires Bun 1.2+. `@corbits/tag-core` comes with it; install core alone if
you only want the contracts. Until the packages are on npm, install from the
repository:

```bash
bun add github:corbitsdev/corbits-tag
```

## Setup

1. Create a Slack app with an `app_mention` event subscription and the
   `app_mentions:read`, `chat:write`, and `channels:history` scopes.
2. Point its event URL at your deployment: `https://<host>/api/tag/slack/webhook`.
3. Provide `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (env or the `slack`
   option).
4. Provide a state backend for thread subscriptions — `@chat-adapter/state-pg`
   (peer dep `pg`) or `@chat-adapter/state-redis` (peer dep `redis`):

   ```bash
   bun add @chat-adapter/state-pg pg
   ```

## Mount it

```ts
import { mountSlackTag } from "@corbits/tag-slack";
import { createPostgresState } from "@chat-adapter/state-pg";

// `app` is your Hono app (e.g. an Interchange createApp).
mountSlackTag(app, {
  userName: "scout",
  // `url` (not `connectionString`); defaults to POSTGRES_URL or DATABASE_URL.
  // Pass `{ client: pgPool }` instead to reuse an existing pool.
  state: createPostgresState({ url: process.env.DATABASE_URL! }),
  // credentials may also come from SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET
  slack: { botToken, signingSecret },
  onTag: async (event, thread) => {
    await thread.post(`Looking into **${event.text}** — back shortly.`);
    // ...dispatch a workflow run, mail an agent, etc.
  },
  onThreadMessage: async (event, thread) => {
    // ambient messages in subscribed threads; default posture is silence
  },
});
```

That mounts `POST /api/tag/slack/webhook` (configurable via `path`).

## Security posture — read this

- The route mounts **outside** your session auth: Slack is not a principal. The Chat SDK adapter verifies the **Slack request signature**; that is the only authentication this package performs.
- Everything past signature verification is the **host's trust decision** — starting with the mapping from Slack workspace/author to whatever identity your dispatch acts as. Do not let a tag reach privileged actions without deciding that mapping deliberately.
- The bot's own messages are filtered out before dispatch (no self-trigger loops).

## Development

```bash
bun install
bun run typecheck && bun run test
```

Requires Bun 1.2+. Unit tests are colocated under `packages/*/src` and run entirely against mocked boundaries — no live Slack needed.

## License

LGPL-2.1 — see [`LICENSE`](LICENSE).
