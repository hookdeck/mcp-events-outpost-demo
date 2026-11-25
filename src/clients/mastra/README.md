# Mastra subscriber

[Mastra](https://mastra.ai)'s `MCPClient` (`@mastra/mcp` 2.10.0) subscribing to the demo server's `order.created` events by webhook, with Outpost delivering. Observed against this demo on 2026-11-25: subscribe, delivery (`200` to Outpost's per-message `msg_...` `webhook-id`), refresh, `gap` and `terminated` handling, and unsubscribe all work.

It is a separate package so the demo's own dependencies stay small. Everything it needs is released on npm.

## Run it

1. Start the demo server (`npm run server`) and note a token from `MCP_TOKENS`.
2. Get a public HTTPS callback for the receiver. In Event Gateway, create a source of type `MCP_EVENTS` (only that type answers Outpost's verification challenge) with a `whsec_` signing secret, then forward it to the receiver:

   ```sh
   hookdeck listen 4000 <source-name>
   ```

3. Install and run:

   ```sh
   cd src/clients/mastra
   npm install
   MCP_TOKEN=<token> npm start -- --callback-url https://hkdk.events/<source-id> --secret whsec_...
   ```

   Optional: `--currency USD`, `--high-value`, `--ttl-ms 60000`. `MCP_SERVER_URL` (default `http://localhost:3000/mcp`) and `RECEIVER_PORT` (default `4000`) come from the environment or the repo's `.env`.

4. In the repo root, place an order: `npm run order -- --currency USD --total 100`. The subscriber prints the occurrence.

## What to know

- **Capability key:** Mastra reads only `capabilities.extensions["io.modelcontextprotocol/events"]`. The demo server advertises it.
- **`Mcp-Name`:** Mastra doesn't send it on `events/subscribe` or `events/unsubscribe`. The demo server accepts that.
- **`webhook-id`:** Mastra accepts Outpost's per-message `msg_...` ids. It de-duplicates by `eventId` per subscription, so Outpost retries don't reach your loop twice.
- **Secret:** `webhook.secret` is shared by every subscription. Without it Mastra generates one per subscription, which doesn't work with a single Event Gateway source.
- **No `events/poll`:** the server only offers webhook delivery, so `delivery: 'webhook'` is forced.
