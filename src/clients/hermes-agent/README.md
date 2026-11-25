# Hermes Agent as a subscriber

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) has an experimental MCP Events client with webhook delivery. This example runs Hermes v0.23.4 as a subscriber to this demo's MCP server: Outpost delivers each matching order to Hermes's webhook listener, through an Event Gateway source, and each delivery starts an agent run.

Tested on 2026-11-25 against managed Outpost 1.11.1. See [what was observed](#what-was-observed) for the limits.

## How it fits together

```text
Hermes (subscribe.py) --events/subscribe--> MCP server (npm run server) --> Outpost
Outpost --signed delivery--> Event Gateway MCP_EVENTS source --hookdeck listen--> Hermes webhook listener (:4840)
```

- Hermes builds its callback as `<public_url>/webhooks/<route>`. `public_url` is the Event Gateway source URL.
- An `MCP_EVENTS` source answers Outpost's verification challenge and passes the Standard Webhooks headers through unchanged. `hookdeck listen` forwards the deliveries to the listener on localhost, so no tunnel is needed.
- Hermes generates a new signing secret for every subscription, but the source verifies the challenge with the secret it was created with. `subscribe.py` therefore gives a new subscription the source's secret. Without that, subscribe fails with `challenge_failed`.
- Events start an agent run only while `hermes gateway run` is running.

## Prerequisites

- The demo's own setup (steps 1 and 2 of the main README): `npm install`, `OUTPOST_API_KEY`, and `npm run outpost:check`.
- `HOOKDECK_API_KEY` for an Event Gateway project, in `.env`. Use a throwaway project: the example creates one source and one connection.
- [`uv`](https://docs.astral.sh/uv/) and git.
- A model provider for Hermes, if you want the agent runs to complete. Put its key in `.hermes-example/home/.env` (for example `ANTHROPIC_API_KEY=...`, with `model:` set in `config.yaml`, or run `hermes model`). Without one, deliveries still arrive and are acknowledged, and the agent run fails.

## Run it

Use five terminals, from the repo root. `.hermes-example/` holds the Hermes checkout, its virtual environment and its home directory (all gitignored), so your own `~/.hermes` is not touched.

```sh
npm run hermes:install                       # Hermes v0.23.4 into .hermes-example/
npm run hermes:setup                         # creates the Event Gateway source, writes Hermes's config
npm run server                               # 1. the MCP server (port 3000)
hookdeck listen 4840 mcp-events-hermes-src   # 2. forwards deliveries to Hermes
HERMES_HOME=.hermes-example/home .hermes-example/venv/bin/hermes gateway run        # 3. Hermes's webhook listener
HERMES_HOME=.hermes-example/home .hermes-example/venv/bin/python -I \
  src/clients/hermes-agent/subscribe.py                                             # 4. subscribe (stays running)
npm run order -- --total 150 --currency USD  # 5. place an order
```

`hookdeck listen` needs the Hookdeck CLI logged in to the same project as `HOOKDECK_API_KEY`, or run it with that key set.

**Success:** `subscribe.py` prints `subscribe: {"subscribed": ...}`; after the order, `.hermes-example/home/logs/gateway.log` has `POST event=... delivery=mcp-event:evt_ord_...` and `inbound message: platform=webhook`; `hookdeck listen` shows `[202]`.

Ctrl+C in `subscribe.py` unsubscribes. `npm run hermes:setup -- --delete` removes the Event Gateway connection.

## What Hermes does with MCP Events

| Behavior | Detail |
|---|---|
| Opt-in | `events: true` on the server entry registers `list_event_types`, `subscribe_event` and `unsubscribe_event`. Hermes doesn't read the server's `events` capability |
| Approval | Every `subscribe_event` asks a person to approve it, because each event starts an unattended agent run. A one-shot `hermes chat -q` declines it |
| Callback | `<platforms.webhook.extra.public_url>/webhooks/<mcp-server-route>`, with a per-subscription `whsec_` secret |
| Delivery | Standard Webhooks signature checked, then `202` and an agent run. A repeated `eventId` is acknowledged with `200` and doesn't run again |
| Refresh | At 80% of the granted lifetime, while the MCP connection is up (the process running `subscribe.py` here) |
| Not supported | `poll` and `push` delivery |

## What was observed

Results from the observed-client test run on 2026-11-25 are in the rig branch (`rig/results/hermes-agent.md`). Hermes accepts Outpost's `msg_` `webhook-id`, sends no `Mcp-Name` on `events/subscribe`, and needs the secret seeded for an `MCP_EVENTS` source (see above).
