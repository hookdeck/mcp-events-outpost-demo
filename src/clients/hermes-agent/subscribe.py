"""Subscribes Hermes Agent to an MCP Events server by calling Hermes's own event tools.

Run with the Hermes virtual environment's Python:
    HERMES_HOME=.hermes-example/home .hermes-example/venv/bin/python -I src/clients/hermes-agent/subscribe.py

It connects the MCP servers in HERMES_HOME/config.yaml the way Hermes does, then calls the
registered `list_event_types`, `subscribe_event` and (on exit) `unsubscribe_event` tools, and stays
running so Hermes's refresh loop keeps the subscription alive. Deliveries are received by
`hermes gateway run`, not by this process.

Two things differ from a model-driven session, and both are needed to use an Event Gateway source:
  1. Approval. subscribe_event asks a person to approve every subscription. A model-driven session
     asks in the chat; this script skips that prompt because you are running it yourself.
  2. Secret. Hermes generates a new signing secret for each subscription, but an MCP_EVENTS source
     verifies Outpost's challenge with the secret it was created with. So a NEW subscription's secret
     is set to the source's (from state.json). Without this, subscribing fails with `challenge_failed`.
"""
import argparse, json, os, signal, sys, time

parser = argparse.ArgumentParser()
parser.add_argument("--server", default="demo", help="MCP server name in config.yaml")
parser.add_argument("--event", default="order.created")
parser.add_argument("--arguments", default='{"currency": "USD"}', help="event arguments as JSON")
parser.add_argument("--instructions", default="Summarize the order in one sentence.")
parser.add_argument("--state", default=os.path.join(os.path.dirname(os.environ["HERMES_HOME"]), "state.json"))
parser.add_argument("--stay", type=float, default=0, help="seconds to stay running (0 = until Ctrl+C)")
parser.add_argument("--keep", action="store_true", help="do not unsubscribe on exit")
args = parser.parse_args()

from tools import mcp_tool_events as events  # Hermes's MCP Events client

secret = json.load(open(args.state))["secret"]
events._consent_error = lambda server_name, tool_args: None  # 1. skip the approval prompt
events._new_secret = lambda: secret                          # 2. use the Event Gateway source's secret

from tools.mcp_tool_discovery import discover_mcp_tools
from tools.registry import registry

names = discover_mcp_tools()
if not names:
    sys.exit("No MCP tools registered. Is the MCP server running, and was Hermes installed with the [mcp] extra?")
prefix = f"mcp__{args.server}__"
tool_args = {"name": args.event, "arguments": json.loads(args.arguments)}

print("event types:", [e["name"] for e in json.loads(registry.dispatch(prefix + "list_event_types", {}))["events"]], flush=True)
result = json.loads(registry.dispatch(prefix + "subscribe_event", {**tool_args, "instructions": args.instructions, "deliver": "log"}))
print("subscribe:", json.dumps(result), flush=True)
if "error" in result:
    sys.exit(1)

stop = False
def _stop(*_):
    global stop
    stop = True
signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)
print("subscribed; keeping the refresh loop alive. Ctrl+C to unsubscribe and exit.", flush=True)
deadline = time.time() + args.stay if args.stay else None
while not stop and (deadline is None or time.time() < deadline):
    time.sleep(0.5)
if not args.keep:
    print("unsubscribe:", registry.dispatch(prefix + "unsubscribe_event", tool_args), flush=True)
