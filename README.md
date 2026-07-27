# Corbits Tag

Chat-tag **ingress** you mount onto an [Interchange](https://github.com/corbitsdev) hub: tag the bot in a thread and the mention arrives at your dispatch as a normalized event; your reply lands back in the thread.

Three packages:

- **`@corbits/tag-core`** — transport-agnostic contracts: `TagEvent`, `TagThread`, `TagDispatch`. Write dispatch logic once.
- **`@corbits/tag-slack`** — `mountSlackTag(app, opts)` for Slack, built on the [Chat SDK](https://chat-sdk.dev) Slack adapter. Telegram/Teams adapters follow the same contract later.
- **`@corbits/tag-interchange`** — optional Interchange host binding: map a chat author to a real principal by email, or provision one on first contact. No shared or synthesized principal at any point.

This is a **bridge, not a tool**: no agent calls it — it pushes thread events _into_ your system and relays replies out. What a tag means (answer, start a workflow, stay silent) is entirely the host's dispatch.

## Install

```bash
bun add @corbits/tag-slack
```

Requires Bun 1.2+. `@corbits/tag-core` comes with it; install core alone if
you only want the contracts. Hosts mounting onto Interchange that need
principal binding also install `@corbits/tag-interchange`. Until the packages
are on npm, install from the repository:

```bash
bun add github:corbitsdev/corbits-tag
```

## Setup

1. Create a Slack app with an `app_mention` event subscription and the
   `app_mentions:read`, `chat:write`, and `channels:history` scopes.
   Add `users:read` and `users:read.email` if your dispatch maps Slack authors
   to identities — see [Mapping authors to identities](#mapping-authors-to-identities).
   Add `reactions:write` if you enable `acknowledge` — see note below.
2. Point its event URL at your deployment: `https://<host>/api/tag/slack/webhook`.
3. Provide `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (env or the `slack`
   option).
4. Provide a state backend (Redis or Postgres Chat SDK state adapter) for
   thread subscriptions.

## Mount it

```ts
import { mountSlackTag } from "@corbits/tag-slack";
import { createPostgresState } from "@chat-adapter/state-postgres";

// `app` is your Hono app (e.g. an Interchange createApp).
mountSlackTag(app, {
  userName: "scout",
  state: createPostgresState({ connectionString: process.env.DATABASE_URL! }),
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

## Acknowledging receipt

Set `acknowledge: true` to have the package react to a message the moment it
dispatches to your `onTag`/`onThreadMessage`, so a user can tell "seen, bot
is working on it" apart from "never arrived." Off by default. Requires the
bot token's **`reactions:write`** scope — **and the app must be reinstalled**
after adding it, since scope changes don't take effect on an
already-installed app. A missing scope logs once and never blocks
answering. The emoji is configurable via `acknowledgeEmoji` (default
`"eyes"`).

## Thinking indicator

Set `thinkingIndicator: true` to post a placeholder immediately on dispatch
and transparently edit it in place when your dispatch calls
`thread.post()` with the real answer — your call site needs no changes.
Off by default. Text is configurable via `thinkingIndicatorText` (default a
neutral, bot-name-free message); if your dispatch throws, the placeholder is
replaced with `thinkingIndicatorErrorText` rather than left reading
"thinking" forever. If the placeholder can't be posted, or `thread.post()`
doesn't return something edit-capable, this falls back to a normal post and
answering proceeds unaffected.

(Slack's native `assistant.threads.setStatus` was investigated and rejected
for this: it requires the app to be a registered Slack Assistant — an
`assistant` feature block plus `assistant:write` scope — which this
mechanism doesn't assume any host has configured.)

## Ambient thread messages

By default the mount only fires `onTag` for explicit `@mentions`. Once a
thread is subscribed (on first mention, or manually via `thread.subscribe()`),
every subsequent message in it also reaches your `onThreadMessage` hook, with
`event.trigger` set to `"mention"` or `"ambient"` (`event.isMention` mirrors
`trigger === "mention"`). Silence — not answering ambient messages — is the
correct default posture; `onThreadMessage` just delivers the event, it never
decides whether to reply.

**`onThreadMessage` requires identity resolution to actually fire.** The
ambient path refuses to dispatch unless the author's `isBot` resolves to a
confirmed `false` — an unresolved `"unknown"` is treated as "could be a bot"
and dropped, because ambient dispatch is unsolicited and a bot answering
another bot is the loop this guard exists to prevent. `isBot` only resolves
away from `"unknown"` via `userLookup` (auto-wired whenever a bot token is
present — see below). If you set `userLookup: undefined` to opt out, or have
no bot token, `onThreadMessage` will silently never fire. This is a
deliberate asymmetry with `TagAuthor` resolution generally, where `"unknown"`
stays `"unknown"` and the host decides what to do with it.

## Thread history

Set `threadHistory: { maxMessages? }` to populate `TagEvent.priorTurns` with
prior messages in the same thread, oldest-first, excluding the current
message — useful for follow-up questions ("what sources did you use?") that
only make sense with the conversation so far:

```ts
mountSlackTag(app, {
  // ...
  threadHistory: { maxMessages: 20 }, // default 50
  onTag: async (event) => {
    for (const turn of event.priorTurns ?? []) {
      // turn.authorId, turn.text, turn.isBot
    }
  },
});
```

Off by default — it costs one extra Slack API call (`conversations.replies`,
via `Thread.refresh()`) per mention. `maxMessages` bounds how many of the
thread's cached messages are *kept*, not the raw fetch; `maxMessages: 0`
means "no history" (skips the refresh entirely), and a negative value throws
rather than being silently reinterpreted. A failed refresh, or a Chat SDK
bot too old to support `refresh()`, yields an empty `priorTurns` rather than
dropping the event. What to do with prior turns — how many to actually use,
whether to include the bot's own answers, how to fit them into a prompt — is
entirely your call; this package only fetches and normalizes them.

## Security posture — read this

- The route mounts **outside** your session auth: Slack is not a principal. The Chat SDK adapter verifies the **Slack request signature**; that is the only authentication `@corbits/tag-slack` performs.
- Everything past signature verification is the **host's trust decision** — starting with the mapping from Slack workspace/author to whatever identity your dispatch acts as. Do not let a tag reach privileged actions without deciding that mapping deliberately.
- When mounting on Interchange, `@corbits/tag-interchange` is the recommended binding: chat email → real principal, never synthesized, never shared. `provisionPrincipal` is the explicit write for a first-contact author — it mints a real per-person account, not a shared one.
- The bot's own messages are filtered out before dispatch (no self-trigger loops).

## Mapping authors to identities

`TagAuthor` carries `userId`, `userName`, `fullName`, `isBot`, and optional
identity facts: `email`, `emailVerified`, and `isRestricted`.
`@corbits/tag-slack` fills the identity facts via a cached `users.info` call
when a bot token is available. When a fact could not be established (missing
scope, network error, no lookup wired), `email` is omitted and
`emailVerified` / `isRestricted` are `"unknown"` — never a permissive
boolean default. A host can fail closed on a fact it was never told; it
cannot fail closed on `false`.

**`email` is omitted without the `users:read.email` scope.** A host that
grants only the three scopes listed above gets `missing_scope` from Slack at
runtime — after the app is already installed — and `tag-slack` logs that
scope by name so it's easy to spot. Treat a missing email as "can't map this
author," never as "any identity is fine."

**Guest and shared-channel accounts must not be trusted by email.**
`isRestricted` is `true` for accounts Slack marks `is_restricted`,
`is_ultra_restricted`, or `is_stranger` — from other workspaces in a
Connect/shared channel. Their email was never verified by _your_ workspace,
so matching it against your user table is a privilege-escalation path:
anyone who can set a profile email in their own workspace and get into a
shared channel can impersonate one of your users. Reject them. Treat
`"unknown"` the same as restricted — the fact was not established.

**Unconfirmed profile emails are not trustworthy.** `emailVerified` mirrors
Slack's `is_email_confirmed`. Hosts that match or create accounts by email
must require `emailVerified === true`: an unconfirmed address lets someone
claim an address they do not own, and anything later matching on that
address inherits the claim.

```ts
onTag: async (event) => {
  const { email, emailVerified, isRestricted, isBot } = event.author;

  if (isBot !== false) return deny();
  if (isRestricted !== false) return deny(); // true | "unknown"
  if (emailVerified !== true) return deny(); // false | "unknown"
  if (!email) return deny();

  const identity = await yourIdentityStore.findByEmail(email);
  if (!identity) return deny(); // no fallback identity — see below
};
```

**Fail closed, with no fallback.** Every miss should deny: no email,
unconfirmed email, no matching account, inactive account, guest, bot, or a
failed `users.info` call. Falling back to a service identity is tempting and
wrong — it silently gives an unmatched Slack poster whatever that identity
can reach, which is the escalation the deny paths exist to prevent.

If you are mapping to an Interchange principal, **read the principal row out
of the database rather than constructing one**. A row from the `principal`
table still goes through normal grant evaluation, so you are supplying
authentication from a different trust root, not bypassing authorization.
Check the capability grant too if your dispatch skips the HTTP layer — the
data layer's own ACLs are not a substitute for "may this principal do this
at all".

## Development

```bash
bun install
bun run typecheck && bun run test
```

Requires Bun 1.2+. Unit tests are colocated under `packages/*/src` and run entirely against mocked boundaries — no live Slack needed.

## License

LGPL-2.1 — see [`LICENSE`](LICENSE).
