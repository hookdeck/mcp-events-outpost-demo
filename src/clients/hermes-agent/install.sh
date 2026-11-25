#!/bin/sh
# Installs Hermes Agent v0.23.4 into its own directory (default .hermes-example/, gitignored),
# in a virtual environment, so nothing is installed globally and your own ~/.hermes is untouched.
# Needs git and uv (https://docs.astral.sh/uv/).
set -eu
DIR="${HERMES_EXAMPLE_DIR:-.hermes-example}"
mkdir -p "$DIR"
if [ ! -d "$DIR/hermes-agent" ]; then
  git clone --depth 1 --branch v0.23.4 https://github.com/NousResearch/hermes-agent.git "$DIR/hermes-agent"
fi
[ -d "$DIR/venv" ] || uv venv --python 3.14 "$DIR/venv"
DIR="$(cd "$DIR" && pwd)"
# [mcp]: the MCP client (without it Hermes skips MCP servers silently).
# aiohttp: the gateway's webhook listener (without it "Webhook: aiohttp not installed").
# [anthropic]: the model provider used when an event starts an agent run. Swap for your provider's extra.
(cd "$DIR/hermes-agent" && VIRTUAL_ENV="$DIR/venv" uv pip install -e ".[mcp,anthropic]" aiohttp==3.14.5)
HERMES_HOME="$DIR/home" "$DIR/venv/bin/hermes" --version | head -1
