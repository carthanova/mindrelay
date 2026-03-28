#!/usr/bin/env bash
# MindRelay native messaging host installer
# Usage: ./install.sh [extension-id]
# If extension-id is omitted, auto-detects from Chrome profile.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_SRC="$SCRIPT_DIR/../target/release/mindrelay-host"
BINARY_DEST="$HOME/Library/Application Support/MindRelay/mindrelay-host"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_DEST="$MANIFEST_DIR/com.mindrelay.host.json"
DATA_DIR="$HOME/Library/Application Support/MindRelay"

# ── Resolve extension ID ──────────────────────────────────────────────────────

EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
  # Try to auto-detect from Chrome preferences (looks for unpacked extensions)
  PREFS="$HOME/Library/Application Support/Google/Chrome/Default/Preferences"
  if [ -f "$PREFS" ]; then
    EXTENSION_ID=$(python3 -c "
import json, sys
prefs = json.load(open('$PREFS'))
exts = prefs.get('extensions', {}).get('settings', {})
for eid, ext in exts.items():
    manifest = ext.get('manifest', {})
    if manifest.get('name', '').lower() in ['mindrelay', 'mind relay']:
        print(eid)
        sys.exit(0)
" 2>/dev/null || true)
  fi
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "Could not auto-detect extension ID."
  echo "Usage: ./install.sh <extension-id>"
  echo "Find your extension ID at chrome://extensions"
  exit 1
fi

echo "Using extension ID: $EXTENSION_ID"

# ── Install binary ────────────────────────────────────────────────────────────

if [ ! -f "$BINARY_SRC" ]; then
  echo "Binary not found. Building..."
  cd "$SCRIPT_DIR/.."
  cargo build --release -p mindrelay-host
fi

mkdir -p "$DATA_DIR"
cp "$BINARY_SRC" "$BINARY_DEST"
chmod +x "$BINARY_DEST"
echo "Installed binary: $BINARY_DEST"

# ── Write Chrome native messaging manifest ────────────────────────────────────

mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DEST" <<EOF
{
  "name": "com.mindrelay.host",
  "description": "MindRelay native messaging host",
  "path": "$BINARY_DEST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Registered manifest: $MANIFEST_DEST"
echo ""
echo "MindRelay native host installed successfully."
echo "Reload your extension at chrome://extensions to activate."
