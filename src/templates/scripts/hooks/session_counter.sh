#!/bin/bash
# session_counter.sh - Claude Code hook for tracking session message count
#
# This hook counts messages in a Claude Code session and warns when the session
# becomes lengthy (long conversations = lower performance = higher cost).
#
# Usage as a Claude Code hook:
#   Configure in ~/.claude/settings.json or .claude/settings.json:
#   {
#     "hooks": {
#       "UserPromptSubmit": [
#         {
#           "hooks": [
#             {
#               "type": "command",
#               "command": "$CLAUDE_PROJECT_DIR/.juno_task/scripts/hooks/session_counter.sh --threshold 50"
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Environment Variables:
#   JUNO_SESSION_COUNTER_THRESHOLD - Threshold for warning (default: 50)
#   JUNO_SESSION_COUNTER_DIR       - Directory for counter files (default: /tmp/juno_session_counters)
#
# Arguments:
#   --threshold N, -t N   Set warning threshold (overrides ENV)
#   --reset               Reset counter for current session
#   --status              Show current counter value without incrementing
#   --help, -h            Show this help message
#
# Exit Codes:
#   0 - Always (hooks should not block on counting)
#
# Output:
#   When threshold is exceeded, outputs JSON to stdout for Claude to see:
#   {
#     "hookSpecificOutput": {
#       "hookEventName": "UserPromptSubmit",
#       "additionalContext": "SESSION_LENGTH_WARNING: ..."
#     }
#   }
#

set -e

# Default values
DEFAULT_THRESHOLD=50
DEFAULT_COUNTER_DIR="/tmp/juno_session_counters"

# Parse environment variables with defaults
THRESHOLD="${JUNO_SESSION_COUNTER_THRESHOLD:-$DEFAULT_THRESHOLD}"
COUNTER_DIR="${JUNO_SESSION_COUNTER_DIR:-$DEFAULT_COUNTER_DIR}"

# Command mode flags
RESET_MODE=false
STATUS_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --threshold|-t)
            if [[ -n "$2" && "$2" =~ ^[0-9]+$ ]]; then
                THRESHOLD="$2"
                shift 2
            else
                echo "Error: --threshold requires a numeric value" >&2
                exit 0
            fi
            ;;
        --reset)
            RESET_MODE=true
            shift
            ;;
        --status)
            STATUS_MODE=true
            shift
            ;;
        --help|-h)
            # Extract help from script header
            sed -n '2,/^$/p' "$0" | sed 's/^# //' | sed 's/^#//'
            exit 0
            ;;
        *)
            # Unknown option, skip
            shift
            ;;
    esac
done

# Ensure counter directory exists
mkdir -p "$COUNTER_DIR"

# Read JSON input from stdin (Claude Code hook input)
INPUT_JSON=""
if [[ ! -t 0 ]]; then
    INPUT_JSON=$(cat)
fi

# Extract session_id from hook input
SESSION_ID=""
if [[ -n "$INPUT_JSON" ]]; then
    SESSION_ID=$(echo "$INPUT_JSON" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//' || true)
fi

# Fallback to environment variable if no session_id in input
if [[ -z "$SESSION_ID" ]]; then
    SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
fi

# Create a safe filename from session_id
SAFE_SESSION_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
COUNTER_FILE="$COUNTER_DIR/session_${SAFE_SESSION_ID}.count"

# Handle reset mode
if [[ "$RESET_MODE" == "true" ]]; then
    if [[ -f "$COUNTER_FILE" ]]; then
        rm "$COUNTER_FILE"
        echo "Counter reset for session: $SESSION_ID" >&2
    else
        echo "No counter found for session: $SESSION_ID" >&2
    fi
    exit 0
fi

# Read current counter
CURRENT_COUNT=0
if [[ -f "$COUNTER_FILE" ]]; then
    CURRENT_COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
fi

# Handle status mode (don't increment)
if [[ "$STATUS_MODE" == "true" ]]; then
    echo "Session: $SESSION_ID" >&2
    echo "Message count: $CURRENT_COUNT" >&2
    echo "Threshold: $THRESHOLD" >&2
    if [[ $CURRENT_COUNT -ge $THRESHOLD ]]; then
        echo "Status: THRESHOLD EXCEEDED" >&2
    else
        REMAINING=$((THRESHOLD - CURRENT_COUNT))
        echo "Status: OK ($REMAINING messages until warning)" >&2
    fi
    exit 0
fi

# Increment counter
NEW_COUNT=$((CURRENT_COUNT + 1))
echo "$NEW_COUNT" > "$COUNTER_FILE"

# Check if threshold exceeded
if [[ $NEW_COUNT -ge $THRESHOLD ]]; then
    # Calculate how much over threshold
    OVER_BY=$((NEW_COUNT - THRESHOLD))

    # Determine severity
    SEVERITY="WARNING"
    if [[ $OVER_BY -ge $((THRESHOLD / 2)) ]]; then
        SEVERITY="CRITICAL"
    fi

    # Create the warning message
    WARNING_MESSAGE="SESSION_LENGTH_WARNING: This session has reached $NEW_COUNT messages (threshold: $THRESHOLD). Long sessions reduce performance and increase costs. $SEVERITY: Please complete your current work as soon as possible. Save any important progress to the kanban (./scripts/kanban.sh) and plan.md using a subagent, then conclude this session. You can start a fresh session to continue work."

    # Output JSON for Claude to see via additionalContext
    cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "$WARNING_MESSAGE"
  }
}
EOF
else
    # Under threshold - no output needed
    # But we can optionally log to stderr for debugging
    if [[ -n "$JUNO_DEBUG" ]]; then
        echo "[session_counter] Session $SESSION_ID: message $NEW_COUNT of $THRESHOLD" >&2
    fi
fi

exit 0
