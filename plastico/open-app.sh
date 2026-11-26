#!/usr/bin/env bash
# Start Plastico (or just open it if it is already running). Closing this window stops it.
cd "$(dirname "$0")"
URL=http://127.0.0.1:8766/
if curl -s -o /dev/null --max-time 1 "$URL"; then
  # setsid: the window must outlive this terminal, which closes as soon as the script ends
  if command -v google-chrome >/dev/null; then setsid -f google-chrome --app="$URL" --new-window >/dev/null 2>&1
  else setsid -f xdg-open "$URL" >/dev/null 2>&1; fi
  sleep 1
  exit 0
fi
echo "Plastico is running. Keep this window open while you use it; close it to quit."
exec "$HOME/.local/bin/uv" run plastico app
