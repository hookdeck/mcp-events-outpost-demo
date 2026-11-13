# AGENTS.md

Context for agents continuing work on this repo. Read this, then `README.md` (architecture, Outpost mapping, setup, run steps, gaps, verified vs assumed). Don't duplicate README content here; update the README when behavior changes.

## What this is and why it exists

- **MCP Events** is a draft MCP extension (design sketch by Peter Alexander, Anthropic, Feb 2026; owned by the MCP Triggers & Events WG; not yet a SEP). Clients subscribe to server-side events and get them by poll, push (SSE/stdio), or webhook.
- **OpenAI shipped MCP Events in ChatGPT on 2026-09-29 (DevDay)**, webhook mode only, with challenge verification. No poll, no stream, no `gap`/`terminated`. ChatGPT is the MCP client; its receiver runs in OpenAI's cloud (inferred, the docs use a placeholder host). The audience is MCP server builders publishing ChatGPT plugins.
- **This demo:** an MCP server builder uses **Hookdeck Outpost** for MCP Events. Since Outpost v1.9.0 (2026-11-12), Outpost runs MCP Events natively (experimental): it serves `events/list` from its event definitions, verifies callbacks, stores and expires subscriptions, filters on arguments, and signs and delivers the MCP envelope. The server authenticates, maps the principal to a tenant, applies its TTL policy, forwards `events/*`, and publishes.
- **History:** the first version (Oct 2026) built verification, expiry and filtering in the server on top of plain webhook destinations. It's at the `diy-webhook-destinations` tag; the README links it.
- Goal of the demo: the reference implementation the guide is built from, and a list of gaps for MCP Events.

## Key references

- Design sketch: https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-triggers-events/main/docs/design-sketch-proposal.md
- OpenAI implementer guide: https://developers.openai.com/plugins/build/mcp-events
- Standard Webhooks: https://www.standardwebhooks.com/
- Outpost source: https://github.com/hookdeck/outpost. Outpost docs: https://hookdeck.com/docs/outpost (MCP Events: /docs/outpost/features/mcp-events and /docs/outpost/destinations/mcp)
- SEP-3415: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415

## Status (2026-11-13)

- Rewritten for Outpost's native MCP Events (branch `feat/native-outpost-mcp-events`). `npm test` and `npm run typecheck` pass, offline against `test/mock-outpost.ts`, whose status codes and `mcp_error` bodies were checked against a local Outpost v1.9.0.
- Run end to end against a self-hosted Outpost v1.9.0 (the Outpost repo's `make up/mcp` stack with this repo's `mcp-events.json`), and through Outpost's `mcp-dev check` in publish mode. README "Tests" has the commands.
- **ChatGPT tested (2026-11-13):** subscribe, verification, delivery, a task run and unsubscribe all worked, although Outpost's `webhook-id` (a random `msg_...` per delivery) doesn't equal `eventId`. The **Vercel AI SDK** (`@ai-sdk/mcp` 2.0.99) answers `400` to every delivery for that reason. README "webhook-id and other subscribers" and "Try it with ChatGPT".
- **Managed Outpost:** v1.9.0 is deployed, but the MCP Events settings and the `/mcp/...` routes through `api.outpost.hookdeck.com` come with hookdeck/core#6257 (open as of 2026-11-13). Until it deploys, only self-hosted works.
- **Guide:** [Send MCP Events Webhooks with Outpost](https://hookdeck.com/docs/outpost/guides/send-mcp-events-webhooks-with-outpost), source in hookdeck/website (`src/content/outpost-guides/2026-10-07_send-mcp-events-webhooks-with-outpost.mdoc`). Its code is fragments of this repo, so update the guide when the code it shows changes.

## Design decisions (keep unless there's a reason)

- **Outpost does MCP Events.** The server forwards `events/list`, `events/subscribe` and `events/unsubscribe` to `GET /mcp/events/list` and `POST /tenants/:id/mcp/events/{subscribe,unsubscribe}`, returns a `200` body as the result, and a `422` `mcp_error` as the JSON-RPC error. No verification, expiry, filtering or subscription storage in the server.
- **Tenant per principal** (`mcp_<principal>`); the agent never sends a tenant. One publish per tenant that has subscribed (`data/tenants.json`), each with its own event ID, because Outpost event IDs are project-wide idempotency keys.
- **TTL policy in the server.** Outpost grants `ttlMs` exactly (omitted = 24 h, null = never), so the server sets a default, clamps to min/max, and maps null to the max.
- **Arguments are equality filters on top-level payload fields** (Outpost's semantics). The order carries `highValue` so "orders of 100 or more" can be an argument. `currency` is an enum.
- **Publish the order as `data`.** Outpost builds the envelope; `eventId` is the Outpost event ID.
- **OpenAI where it matters for ChatGPT:** `capabilities.events: {}` (plus SEP-3415's `extensions["io.modelcontextprotocol/events"]`), idempotent unsubscribe (Outpost's NotFound becomes success). Error codes are Outpost's (SEP-3415).
- **`Mcp-Name`:** a header that disagrees with `params.name` gets `-32020` HeaderMismatch; a missing one is accepted, because the MCP SDK client doesn't send it for `events/*`.
- **Outpost SDK** for publish; `fetch` for the MCP routes and Config API (no SDK methods as of 2.0.0).
- **MCP SDK v2**, protocol `2026-07-28`, `events/*` as custom handlers on the low-level `Server`.
- Auth: no OAuth, by decision. `MCP_TOKENS` for the test client, `ANONYMOUS_PRINCIPAL` for ChatGPT with No Authentication.

## Next steps (in rough priority)

1. **Managed Outpost run** once hookdeck/core#6257 is deployed: `npm run outpost:check -- --apply`, then the quickstart with a tunnel.
2. **Vercel AI SDK compatibility:** raise with the Outpost team (hookdeck/outpost#1181 floated an opt-in `webhook-id = eventId` setting) or the AI SDK, whichever the user prefers.

Ask the user before starting any of these.

## Outpost gaps this demo surfaced

- `webhook-id` per delivery vs OpenAI's `webhook-id = eventId`: ChatGPT accepts it, the Vercel AI SDK doesn't (see above).
- Unsubscribe of an unknown subscription answers NotFound; OpenAI wants idempotent success (the server converts it).
- `mcp-dev check` reports `headers.name-missing` (the server accepts a missing `Mcp-Name`) and `unsubscribe.not-found` (the idempotent unsubscribe) as failures. Both are deliberate.
- Earlier gaps (410/413 retried, rotated secrets on busy destinations, SSRF on delivery) are closed by v1.9.0's MCP delivery or earlier releases; the old list is at the `diy-webhook-destinations` tag.

## Working conventions

- TypeScript, ESM, Node. `npm test` (vitest) and `npm run typecheck` must pass before committing. Add tests with new behavior; extend `test/mock-outpost.ts` when calling new Outpost endpoints.
- `.env` holds a real Outpost API key. Don't print it or commit it.
- Writing (README, docs, posts): American English, developer-to-developer, no hype, short paragraphs, **no em dashes**, no horizontal rules.
- Terminology: don't write "app" or "apps". MCP Events is implemented by an **MCP server**; the product that sends webhooks is a **service** (GitHub, Shopify); what a user adds in ChatGPT is a **plugin**. Quote ChatGPT UI labels exactly, even when they say "App". Avoid vague placeholders such as "things" or "behind an MCP server": name the event, server, or service. Write "ID" in prose ("subscription ID"); `id` only for a field or code. Before committing docs, run `grep -nwiE 'apps?|things?|behind' README.md AGENTS.md` and check each hit.
- Mermaid diagrams: render every changed diagram before committing, for example extract the block to a `.mmd` file and run `npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.svg`. Don't use `;` inside labels (Mermaid treats it as a statement separator).
- Git: small focused commits. Don't push or add a remote without asking the user.
- Never post to Slack or other external channels on the user's behalf; draft and show instead.

## Environment gotchas

- `node_modules` was first installed in a Linux VM. If anything native misbehaves on the Mac, `rm -rf node_modules && npm install`. (`package-lock.json` may show a small diff after reinstalling on the Mac; that's expected, commit it.)
- `.git/sandbox-leftovers/` holds empty lock files from that VM. Safe to delete.
