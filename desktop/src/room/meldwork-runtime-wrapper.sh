#!/bin/sh
# OAR starts this as OAR_CLAUDE_BIN / OAR_CODEX_BIN. Before exec'ing the real
# CLI it records the process identity in a private per-run PID file, so the
# room service can find and stop a runtime that survived a hard crash.
#
# The record is <pid>\t<ps lstart>. exec keeps the PID and its start time, so
# the sweep can reject a reused PID. LC_ALL=C keeps the timestamp format
# identical to the sweep's `ps`.
if [ -n "$MELDWORK_ROOM_RUN_ID" ] && [ -n "$MELDWORK_ROOM_STATE_DIR" ] && [ -n "$MELDWORK_RUNTIME_BIN" ]; then
  case "$MELDWORK_ROOM_RUN_ID" in
    *[!A-Za-z0-9._-]*|'') ;;
    *)
      mkdir -p "$MELDWORK_ROOM_STATE_DIR" 2>/dev/null
      started=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      if [ -n "$started" ]; then
        printf '%s\t%s\n' "$$" "$started" > "$MELDWORK_ROOM_STATE_DIR/$MELDWORK_ROOM_RUN_ID.pid" 2>/dev/null
      fi
      ;;
  esac
fi
exec "$MELDWORK_RUNTIME_BIN" "$@"
