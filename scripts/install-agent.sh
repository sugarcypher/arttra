#!/bin/bash
# Install the arttra ingest LaunchAgent on this Mac.
#
# Usage:
#   scripts/install-agent.sh                              # interactive
#   scripts/install-agent.sh /path/to/drops               # drops folder explicit
#   scripts/install-agent.sh /path/to/drops main          # drops + branch
#
# Reinstall is safe — this command boots out the existing agent first.
# Uninstall:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.arttra.pipeline.plist
#   rm ~/Library/LaunchAgents/com.arttra.pipeline.plist

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is macOS-only. On Linux, run scripts/ingest.sh from cron instead."
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/scripts/com.arttra.pipeline.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.arttra.pipeline.plist"
LABEL="com.arttra.pipeline"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "template missing: $TEMPLATE"
  exit 1
fi

DROPS="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$DROPS" ]]; then
  default_drops="$HOME/Library/Mobile Documents/com~apple~CloudDocs/arttra-drops"
  read -r -p "Drops folder [${default_drops}]: " DROPS
  DROPS="${DROPS:-$default_drops}"
fi

if [[ ! -d "$DROPS" ]]; then
  echo "drops folder does not exist: $DROPS"
  read -r -p "create it now? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    mkdir -p "$DROPS"
  else
    exit 1
  fi
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# Bootstrap the new plist (or reload it).
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "agent already loaded; booting out before reinstall..."
  launchctl bootout "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || true
fi

# Render the template. Pass values as env vars so paths with slashes,
# spaces, and special chars don't need to be escaped for sed.
export HOME REPO DROPS BRANCH
python3 - "$TEMPLATE" "$PLIST_DEST" <<'PY'
import sys, os
src, dest = sys.argv[1], sys.argv[2]
with open(src) as f:
    body = f.read()
body = (body
        .replace("{{HOME}}", os.environ["HOME"])
        .replace("{{REPO}}", os.environ["REPO"])
        .replace("{{DROPS}}", os.environ["DROPS"])
        .replace("{{BRANCH}}", os.environ["BRANCH"]))
with open(dest, "w") as f:
    f.write(body)
PY

echo "wrote $PLIST_DEST"
echo "  REPO   = $REPO"
echo "  DROPS  = $DROPS"
echo "  BRANCH = $BRANCH"

launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo
echo "agent loaded. tail logs with:"
echo "  tail -f \$HOME/Library/Logs/arttra-ingest.out.log \$HOME/Library/Logs/arttra-ingest.err.log"
echo
echo "to confirm it's registered:"
echo "  launchctl list | grep arttra"
