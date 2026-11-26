#!/usr/bin/env bash
# Installs Cassetto for this user: the app in ~/.local/opt/cassetto, a `cassetto` command in
# ~/.local/bin, and Cassetto in the applications menu. Run it from the unpacked folder.
#   ./install.sh            install (or update)
#   ./install.sh --remove   take it away again (projects are never touched)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/opt/cassetto"
BIN="$HOME/.local/bin/cassetto"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

if [ "${1:-}" = "--remove" ]; then
  rm -rf "$DEST" "$BIN" "$APPS/cassetto.desktop" "$ICONS/cassetto.svg"
  echo "Cassetto removed. Your projects and settings (~/.config/cassetto) are still there."
  exit 0
fi

if [ "$HERE" != "$DEST" ]; then
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  cp -a "$HERE" "$DEST"
fi
mkdir -p "$(dirname "$BIN")" "$APPS" "$ICONS"
ln -sf "$DEST/cassetto" "$BIN"
cp "$DEST/icon.svg" "$ICONS/cassetto.svg"
sed "s#@EXEC@#$DEST/cassetto#" "$DEST/cassetto.desktop" > "$APPS/cassetto.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true
echo "Cassetto installed. Open it from the applications menu, or run: cassetto"
