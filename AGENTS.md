# AGENTS.md

Context for agents continuing work on this repo. Read this, then `README.md` (architecture, Outpost mapping, setup, run steps, gaps, verified vs assumed). Don't duplicate README content here; update the README when behavior changes.

## What this is and why it exists

- **MCP Events** is a draft MCP extension (design sketch by Peter Alexander, Anthropic, Feb 2026; owned by the MCP Triggers & Events WG; not yet a SEP). Clients subscribe to server-side events and get them by poll, push (SSE/stdio), or webhook.
- **OpenAI shipped MCP Events in ChatGPT on 2026-09-29 (DevDay)**, webhook mode only, with challenge verification. No poll, no stream, no `gap`/`terminated`. ChatGPT is the MCP client; its receiver runs in OpenAI's cloud (inferred, the docs use a placeholder host). The audience is MCP server builders publishing ChatGPT plugins.
- **This demo:** an MCP server builder uses **Hookdeck Outpost** as the webhook delivery layer (signing, retries, fan-out, filters, logs).
- Agreed framing: MCP Events webhook delivery is **not a new destination type**; it's HTTP delivery with Standard Webhooks signing plus a handshake and TTLs.
- Goal of the demo: content (blog post / guide / video) and a list of Outpost gaps for MCP Events.

## Key references

- Design sketch: https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-triggers-events/main/docs/design-sketch-proposal.md
- OpenAI implementer guide: https://developers.openai.com/plugins/build/mcp-events
- Standard Webhooks: https://www.standardwebhooks.com/
- Outpost source: https://github.com/hookdeck/outpost. Outpost docs: https://hookdeck.com/docs/outpost

## Status (2026-10-01)

- Server, test client, scripts and tests are done. 93 tests pass (`npm test`), `npm run typecheck` is clean. All offline against `test/mock-outpost.ts`.
- **Run end to end against managed Outpost (2026-10-01)**, with the receiver behind a quick tunnel (`npm run tunnel`). Opening a tunnel exposes the machine to the internet, so ask the user before starting one. README "verified vs assumed" has the results. The project is in Standard mode with topic `order.created`. Found a new Outpost gap: rotated secrets aren't used by a busy destination's cached publisher (README gap 8).
- **ChatGPT tested end to end (2026-10-01)** in developer mode with No Authentication (`ANONYMOUS_PRINCIPAL`), MCP server behind `npm run tunnel -- --port 3000`. Subscribe, verification, Outpost delivery, task run, filtering, and unsubscribe all worked. Results and what ChatGPT sends (callback host, no `ttlMs`, access check via a tool before subscribing) are in README "Try it with ChatGPT".
- Published at https://github.com/hookdeck/mcp-events-outpost-demo.

## Design decisions (keep unless there's a reason)

- **Tenant per principal** (`mcp_<principal>`), one publish per tenant with a live subscription. Single-tenant alternative is documented in the README and rejected for isolation and destination limits.
- **Destination id = subscription id.** Subscription id is `sub_` + 32 hex of SHA-256 over canonical `(principal, delivery.url, name, arguments)`. Deterministic, so subscribe is an idempotent upsert.
- **Publish the full MCP envelope as Outpost `data`** so the delivered body is exactly the MCP event. Consequence: filters address `data.data.<field>` (e.g. `data.data.total`).
- **Verification challenge is done by the server** before creating the destination (Outpost has no handshake). Callback URL SSRF checks happen at subscribe time and on the challenge request; redirects are not followed.
- **TTL sweeper** deletes expired destinations (Outpost has no expiry).
- **Secret rotation** uses Outpost `previous_secret` + `previous_secret_invalid_at` (`SECRET_ROTATION_GRACE_MS`) so Outpost dual-signs.
- **MCP SDK v2** (`@modelcontextprotocol/server|client|node`). The SDK has no Events support: `capabilities.events` is cast, `events/*` are custom request handlers, and the client reads `server/discover` directly. Protocol `2026-07-28` is served.
- **Follow OpenAI where it differs from the spec** (see README section). Don't add `gap`/`terminated`/poll/stream unless asked; ChatGPT doesn't use them.
- Auth: no OAuth, by decision. Demo `MCP_TOKENS` for the test client, `ANONYMOUS_PRINCIPAL` for ChatGPT with No Authentication. Everything keys off the `req.auth` principal, so OAuth could drop in later.

## Next steps (in rough priority)

1. **Remaining ChatGPT checks** (no OAuth: decided 2026-10-01 that the demo skips it; README "Auth: what this demo skips" has the notes): refresh before `refreshBefore` and across a server restart, duplicates, bursts/batching, revoked access, invalid signatures.
2. **Content:** explainer post and guide. Follow the writing conventions below.

The live run against managed Outpost is done (see README). Ask the user before starting any of these.

## Outpost gaps this demo surfaced

Bucketed as in README "Outpost: what it handles and what's open":
- **Open Outpost issues:** 410/413 retried (no non-retryable status codes); rotated secrets ignored by a busy destination's cached publisher (outpost#1084, fixed by #1085, unreleased; managed on v1.5.0); `destination_ids` reported on duplicate publishes and unmatched publishes not recording the event id; managed version not exposed by the API.
- **Platform (whoever runs Outpost):** delivery-time SSRF. Outpost's client follows redirects and has no private-address blocklist; the fix is an SSRF-filtering egress proxy via `DESTINATIONS_PROXY_URL` (outpost#1100, merged 2026-09-30, unreleased).
- **App layer (the MCP server):** verification challenge, subscription expiry (sweeper), fan-out across tenants with per-tenant event ids, `deliveryStatus` assembly, subscribe-time callback checks, poll storage (not implemented).
`hookdeck listen` (the Hookdeck CLI) can't front the test subscriber: Event Gateway sources answer with a static response, so the MCP Events challenge fails. Use `npm run tunnel` instead.

## Working conventions

- TypeScript, ESM, Node. `npm test` (vitest) and `npm run typecheck` must pass before committing. Add tests with new behavior; extend `test/mock-outpost.ts` when calling new Outpost endpoints.
- `ALLOW_LOCAL_CALLBACKS=true` is for the mock/tests only.
- `.env` holds a real Outpost API key. Don't print it or commit it.
- Writing (README, docs, posts): American English, developer-to-developer, no hype, short paragraphs, **no em dashes**, no horizontal rules.
- Git: small focused commits. Don't push or add a remote without asking the user.
- Never post to Slack or other external channels on the user's behalf; draft and show instead.

## Environment gotchas

- `node_modules` was first installed in a Linux VM. If anything native misbehaves on the Mac, `rm -rf node_modules && npm install`. (`package-lock.json` may show a small diff after reinstalling on the Mac; that's expected, commit it.)
- `.git/sandbox-leftovers/` holds empty lock files from that VM. Safe to delete.
