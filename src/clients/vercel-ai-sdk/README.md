# Vercel AI SDK subscriber

The [Vercel AI SDK](https://ai-sdk.dev)'s MCP client (`@ai-sdk/mcp`, `experimental_createMCPClient` and `experimental_createMCPEventWebhook`) subscribing to the demo server's `order.created` events by webhook, with Outpost delivering. Observed against this demo on 2026-11-26 with `@ai-sdk/mcp` 2.0.105 and 2.0.106: subscribe, delivery (`204` to Outpost's per-message `msg_...` `webhook-id`), refresh and unsubscribe work.

**Needs `@ai-sdk/mcp` 2.0.105 or later.** Versions up to 2.0.104 answer `400` to every delivery, because they require `webhook-id` to equal the event's `eventId` (Outpost sends a per-message `msg_...` id), and they ignore a server that advertises events only under `capabilities.extensions`. The fix is [vercel/ai#25451](https://github.com/vercel/ai/pull/25451), in 2.0.105. `package.json` pins 2.0.105.

It is a separate package so the demo's own dependencies stay small.

## Run it

1. Start the demo server (`npm run server`) and note a token from `MCP_TOKENS`.
2. Get a public HTTPS callback for the receiver. In Event Gateway, create a source of type `MCP_EVENTS` (only that type answers Outpost's verification challenge) with a `whsec_` signing secret, then forward it to the receiver:

   ```sh
   hookdeck listen 4000 <source-name>
   ```

   If `hookdeck listen` is logged in to a different project from the one the source is in, Event Gateway accepts the requests but forwards nothing. Pass `--hookdeck-config` for the right project.

3. Install and run:

   ```sh
   cd src/clients/vercel-ai-sdk
   npm install
   MCP_TOKEN=<token> npm start -- --callback-url https://hkdk.events/<source-id> --secret whsec_...
   ```

   Optional: `--currency USD`, `--high-value`, `--ttl-ms 60000`. `MCP_SERVER_URL` (default `http://localhost:3000/mcp`) and `RECEIVER_PORT` (default `4000`) come from the environment or the repo's `.env`.

4. In the repo root, place an order: `npm run order -- --currency USD --total 100`. The subscriber prints the occurrence.

## What to know

- **Capability key:** the client reads the extension key `io.modelcontextprotocol/events` and the flat `capabilities.events`. The demo server advertises both.
- **`Mcp-Name`:** sent on `events/subscribe` and `events/unsubscribe`.
- **Callback URL:** the client appends `?mcp_event_subscription=<key>` and the receiver 401s without it. The Event Gateway source forwards the query string. A proxy that drops it breaks delivery.
- **Secret:** pass `delivery.secret` so every subscription shares one. Without it the SDK generates one per subscription, which doesn't work with a single Event Gateway source.
- **No automatic refresh:** the SDK doesn't renew leases, and the receiver answers `410` once `refreshBefore` has passed. `subscriber.ts` calls `events.refresh()` before the lease ends.
- **No de-duplication:** Outpost and Event Gateway retries re-send the same event, and `onEvent` runs again each time. `subscriber.ts` skips a `(subscription id, eventId)` pair it has already handled, as the SDK docs advise.
- **Terminated subscriptions:** `onTerminated` removes the subscription from the store, so a later `refresh()` or `unsubscribe()` for it throws.
- **No `events/poll`:** the server only offers webhook delivery, and the SDK's events API is webhook-only.
