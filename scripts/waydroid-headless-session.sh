#!/bin/sh

set -eu

session_pid=""

stop_session() {
  if [ -n "$session_pid" ]; then
    kill -TERM "$session_pid" 2>/dev/null || true
    wait "$session_pid" 2>/dev/null || true
  fi
}

trap stop_session INT TERM EXIT

waydroid session start &
session_pid=$!

# show-full-ui must share the session D-Bus created by dbus-run-session.
attempt=0
while kill -0 "$session_pid" 2>/dev/null && [ "$attempt" -lt 90 ]; do
  if waydroid status 2>/dev/null | grep -q 'Session:[[:space:]]*RUNNING'; then
    waydroid show-full-ui || true
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

wait "$session_pid"

