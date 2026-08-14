#!/usr/bin/env bash
# Manual smoke test for the SDK-17 plan-mode port (bridge:
# apps/server/src/bridge/plan-mode-bridge.ts). Not automatable end-to-end —
# it exercises real streaming/timing behavior in a real browser against a
# real model, which the unit suite intentionally fakes out. Run this once
# after any change to plan-mode-bridge.ts, in-process.ts's propose wiring,
# or the PlanApproval web component, before trusting the port.
#
# Usage: scripts/manual-plan-mode-smoke.sh [base-url]
#   base-url defaults to http://127.0.0.1:8787 — point it at a running
#   `omp-deck` instance (start one with `bun run dev` or your usual command
#   first; this script does not start the server for you).
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m=== Checkpoint %s: %s ===\033[0m\n' "$1" "$2"; }
pause() {
	printf '\033[2m%s\033[0m ' "Press Enter once you have confirmed the above (or Ctrl+C to abort)."
	read -r _
}

bold "Plan-mode manual smoke test"
echo "Target: ${BASE_URL}"
echo "This script only guides you through the browser steps and pauses for"
echo "confirmation — it does not click anything itself. Open ${BASE_URL} in"
echo "a browser and start (or resume) a chat session before continuing."
pause

step 1 "Enter plan mode"
cat <<'EOF'
In the chat composer, press Shift+Tab (or type `/plan`).

Confirm:
  - The composer border/header shows the "Plan" pill.
  - The sidebar badge for this session shows plan mode active.
EOF
pause

step 2 "Ask for something plannable, wait for propose"
cat <<'EOF'
Send a prompt that requires drafting a real plan, e.g.:
  "Plan out adding a dark-mode toggle to the settings page."

Wait for the agent to write a local://<slug>-plan.md file and then submit
its title via xd://propose (you'll see this as a `write` tool call in the
transcript targeting xd://propose, or just watch for the card below).
EOF
pause

step 3 "Card appears AND chat keeps streaming (constraint 1)"
cat <<'EOF'
Confirm BOTH of the following — this is the SDK issue #7684 regression
check. `onToolExecutionEnd` in the bridge must never block the event chain:

  - The inline PlanApproval card appears with the plan content, a
    suggested title, and Reject / Edit / Approve buttons.
  - The chat did NOT go blank or freeze while the card appeared — any
    trailing assistant text/tool activity from before the propose call
    kept rendering normally, and the UI stayed responsive (you can still
    scroll, open the sidebar, etc.) the whole time.
EOF
pause

step 4 "No re-propose loop within ~10s (constraint 2)"
cat <<'EOF'
Wait about 10 seconds WITHOUT clicking anything on the card.

Confirm:
  - Only ONE PlanApproval card is showing — the agent did not silently
    re-submit the same (or a new) proposal while you waited.
  - No new "cancelled" or error bubble appeared in the transcript (the
    silent-abort marker should have suppressed one).

This proves markPlanInternalAbortPending/clearPlanInternalAbortPending
actually aborted the in-flight turn before the card was shown.
EOF
pause

step 5 "Approve: visible handoff bubble, execution, local:// link resolves"
cat <<'EOF'
Click Approve on the card.

Confirm:
  - A new, user-visible chat turn appears with the "Plan approved. You
    MUST execute it now." handoff text — NOT hidden/synthetic. (This is a
    deliberate deck deviation from the TUI, which hides this turn.)
  - The agent actually starts executing the plan (tool calls, edits,
    etc.) afterward, with full tool access restored (not still gated to
    read-only).
  - Any local://<slug>-plan.md link rendered in the transcript resolves
    when clicked — SDK 17 does NOT rename the plan file on approval, so
    the link from before approval must still work after.
  - The Plan pill / sidebar badge cleared.
EOF
pause

step 6 "Reject round exits cleanly"
cat <<'EOF'
Start a fresh plan-mode round (Shift+Tab, ask for another plan, wait for
the card), then click Reject this time.

Confirm:
  - The card disappears.
  - The Plan pill / sidebar badge cleared.
  - The agent surfaces a clear rejection message (not a stack trace / raw
    error) and does not attempt to re-execute anything.
  - The local://*.md file used for that round is untouched on disk (no
    rename, no deletion) — you can skip this if you don't have filesystem
    access to the artifacts dir.
EOF
pause

step 7 "Reload mid-approval replays the card"
cat <<'EOF'
Start a third plan-mode round and wait for the card to appear — but this
time, before clicking anything, reload the browser tab (or open the
session in a second tab).

Confirm:
  - The PlanApproval card re-appears immediately on load, with the same
    plan content and title, without you having to wait for a new event.
  - Clicking Approve or Reject from the reloaded tab still works.
EOF
pause

bold "All 7 checkpoints confirmed. Plan-mode port looks good."
