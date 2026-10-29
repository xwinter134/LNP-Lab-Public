#!/bin/bash
#
# Double-click this file in Finder to start LNP Lab.
#
# It updates the folder from git if it can, serves it on http://localhost:8787 and opens the browser.
# Closing the Terminal window it opens, or pressing Ctrl+C in it, stops the app. Your data lives in the
# browser and is not affected either way.
#
# A double-clicked .command does not read your shell profile, so Homebrew's paths are added by hand below.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
URL="http://localhost:$PORT/"

say() { printf '%s\n' "$*"; }
hold() { say ''; say 'Press return to close this window.'; read -r _; }

if ! command -v node >/dev/null 2>&1; then
  say 'Node is not installed, or Finder cannot find it.'
  say 'Install it from https://nodejs.org (the LTS build), then double-click this file again.'
  hold; exit 1
fi

# Already running? Then there is nothing to start; just bring the window up.
if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
  say "LNP Lab is already running on port $PORT. Opening it."
  open "$URL"
  exit 0
fi

# Pick up whatever has been pushed since last time. A fast-forward only, so local work is never discarded:
# if the pull cannot be done cleanly the app still starts, on the version you have.
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  say 'Checking for an update …'
  if git pull --ff-only --quiet 2>/dev/null; then
    say "Now on: $(git log --oneline -1)"
  else
    say 'No clean update available, starting the version you have.'
    say "Currently on: $(git log --oneline -1 2>/dev/null)"
  fi
fi

say ''
say "Starting LNP Lab on $URL"
say 'Leave this window open while you work. Close it or press Ctrl+C to stop.'
say ''

node scripts/serve.mjs &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null' EXIT INT TERM

# Wait for the server to answer before opening the browser, so Safari does not land on an error page.
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 1 "$URL" 2>/dev/null; then break; fi
  sleep 0.25
done

if curl -fsS -o /dev/null --max-time 1 "$URL" 2>/dev/null; then
  open "$URL"
else
  say "The server did not come up on port $PORT. Another program may be using it."
  say "Try: PORT=8788 open this file again, or stop whatever holds the port."
fi

wait "$SERVER"
