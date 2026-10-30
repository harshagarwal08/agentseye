// The one-line installer, served by the relay at /install.sh with the relay's own address filled in:
//   curl -fsSL https://<relay>/install.sh | sh
// Everything goes under ~/.agentseye. No sudo, no Homebrew: if Node 20+ is missing, a private copy is downloaded.
export function installScript({ relay = '', repo = '' }) {
  return `#!/bin/sh
# AgentsEye installer. Safe to run again: it updates in place. Remove with: sh -s -- --uninstall
set -eu
REPO="\${AGENTSEYE_REPO:-${repo}}"
RELAY="\${AGENTSEYE_RELAY:-${relay}}"
HOME_DIR="\${AGENTSEYE_HOME:-$HOME/.agentseye}"
APP="$HOME_DIR/app"
NODE_VERSION="22.12.0"
say() { printf '\\033[1;31m●\\033[0m %s\\n' "$1"; }

if [ "\${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/dev.agentseye.server" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/dev.agentseye.server.plist"
  rm -rf "$APP" "$HOME_DIR/node"
  say "AgentsEye removed. Your settings are still in $HOME_DIR (delete it to forget everything)."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "AgentsEye runs on macOS."; exit 1; }
[ -n "$REPO" ] || { echo "No source repository set (AGENTSEYE_REPO=owner/name)."; exit 1; }
mkdir -p "$HOME_DIR"

# Node: use one that is new enough, otherwise fetch a private copy (official build, no admin rights needed).
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
  say "Downloading Node $NODE_VERSION (private to AgentsEye)…"
  rm -rf "$HOME_DIR/node" && mkdir -p "$HOME_DIR/node"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$ARCH.tar.gz" | tar -xz -C "$HOME_DIR/node" --strip-components 1
  NODE="$HOME_DIR/node/bin/node"
fi
NPM="$(dirname "$NODE")/npm"; [ -x "$NPM" ] || NPM="npm"

say "Downloading AgentsEye…"
TMP="$(mktemp -d)"
curl -fsSL "\${AGENTSEYE_TARBALL:-https://codeload.github.com/$REPO/tar.gz/HEAD}" | tar -xz -C "$TMP" --strip-components 1
( cd "$TMP" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$TMP" "$APP"; rm -rf "$APP.old"
printf '{"repo":"%s"}\\n' "$REPO" > "$HOME_DIR/install.json"

[ -n "$RELAY" ] && "$NODE" "$APP/bin/agentseye.js" set-relay "$RELAY"
if [ -n "\${AGENTSEYE_SKIP_SERVICE:-}" ]; then say "Installed (service skipped)."; exit 0; fi
"$NODE" "$APP/bin/agentseye.js" install-service
sleep 2
say "AgentsEye is running and starts at login."
say "Opening http://localhost:4480 — choose a password, then scan the QR code with your phone."
open "http://localhost:4480" 2>/dev/null || true
`;
}
