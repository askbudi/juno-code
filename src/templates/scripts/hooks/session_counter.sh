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
#               "command": "\"$CLAUDE_PROJECT_DIR\"/.juno_task/scripts/hooks/session_counter.sh --threshold 50"
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

VERSION="1.0.0"

# Default values
DEFAULT_THRESHOLD=50
DEFAULT_COUNTER_DIR="/tmp/juno_session_counters"

# Parse environment variables with defaults
THRESHOLD="${JUNO_SESSION_COUNTER_THRESHOLD:-$DEFAULT_THRESHOLD}"
COUNTER_DIR="${JUNO_SESSION_COUNTER_DIR:-$DEFAULT_COUNTER_DIR}"

# Command mode flags
RESET_MODE=false
STATUS_MODE=false

show_help() {
    cat << 'HELPEOF'
session_counter.sh - Claude Code hook for session length monitoring

SYNOPSIS
    session_counter.sh [OPTIONS]

DESCRIPTION
    This hook counts user prompts in a Claude Code session and warns Claude
    when the session becomes too long. Long sessions lead to:

    - Higher API costs (more tokens in context)
    - Lower performance (context window limits)
    - Potential loss of context coherence

    When the threshold is exceeded, the hook outputs a JSON message that
    Claude Code injects as context, reminding Claude to wrap up and save
    progress to kanban/plan.md.

OPTIONS
    --threshold N, -t N
        Set the message count threshold for warnings.
        Default: 50 (or JUNO_SESSION_COUNTER_THRESHOLD env var)

    --reset
        Reset the counter for the current session to 0.
        Reads session_id from stdin JSON.

    --status
        Show current counter status without incrementing.
        Useful for debugging and monitoring.

    --help, -h
        Show this help message.

ENVIRONMENT VARIABLES
    JUNO_SESSION_COUNTER_THRESHOLD
        Default threshold value. Default: 50

    JUNO_SESSION_COUNTER_DIR
        Directory for state files. Default: /tmp/juno_session_counters

    JUNO_DEBUG
        Set to any value to enable debug logging to stderr.

HOOK CONFIGURATION
    Add to ~/.claude/settings.json or .claude/settings.json:

    {
      "hooks": {
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "\"$CLAUDE_PROJECT_DIR\"/.juno_task/scripts/hooks/session_counter.sh --threshold 50"
              }
            ]
          }
        ]
      }
    }

MANUAL TESTING
    # Test with mock input
    echo '{"session_id":"test123","prompt":"hello"}' | ./session_counter.sh -t 5

    # Check status
    echo '{"session_id":"test123"}' | ./session_counter.sh --status

    # Reset counter
    echo '{"session_id":"test123"}' | ./session_counter.sh --reset

EXIT CODES
    Always exits 0 to ensure the hook never blocks Claude Code.
    Errors are logged to stderr but don't affect exit status.

OUTPUT BEHAVIOR
    Under threshold: No output (silent counting)
    At/over threshold: JSON with additionalContext warning message

    The warning message instructs Claude to:
    1. Save remaining tasks to kanban (./.juno_task/scripts/kanban.sh)
    2. Update plan.md with progress
    3. Commit completed work
    4. Update CLAUDE.md with learnings
    5. Finish current task and stop

VERSION
    1.0.0

SEE ALSO
    Claude Code hooks: https://code.claude.com/docs/en/hooks
HELPEOF
}

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
            show_help
            exit 0
            ;;
        --version)
            echo "session_counter.sh version $VERSION"
            exit 0
            ;;
        *)
            # Unknown option, skip silently for hook compatibility
            shift
            ;;
    esac
done

# Ensure counter directory exists
mkdir -p "$COUNTER_DIR" 2>/dev/null || true

# Read JSON input from stdin (Claude Code hook input)
INPUT_JSON=""
if [[ ! -t 0 ]]; then
    INPUT_JSON=$(cat)
fi

# Extract session_id from hook input using multiple methods for robustness
SESSION_ID=""
if [[ -n "$INPUT_JSON" ]]; then
    # Try jq first (most reliable)
    if command -v jq &>/dev/null; then
        SESSION_ID=$(echo "$INPUT_JSON" | jq -r '.session_id // empty' 2>/dev/null || true)
    fi

    # Fallback to grep/sed if jq didn't work
    if [[ -z "$SESSION_ID" ]]; then
        SESSION_ID=$(echo "$INPUT_JSON" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//' || true)
    fi
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
    # Ensure it's a valid number
    if ! [[ "$CURRENT_COUNT" =~ ^[0-9]+$ ]]; then
        CURRENT_COUNT=0
    fi
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

    # Determine severity based on how far over threshold
    SEVERITY="WARNING"
    if [[ $OVER_BY -ge $((THRESHOLD / 2)) ]]; then
        SEVERITY="CRITICAL"
    elif [[ $OVER_BY -ge 10 ]]; then
        SEVERITY="HIGH"
    fi

    # Create the warning message - this will be injected as context for Claude
    WARNING_MESSAGE="SESSION_LENGTH_WARNING [$SEVERITY]: This session has reached $NEW_COUNT messages (threshold: $THRESHOLD). Long sessions reduce performance and increase costs. Please complete your current work as soon as possible: 1) Save any remaining tasks to kanban using './.juno_task/scripts/kanban.sh' 2) Update plan.md with current progress 3) Commit any completed work 4) Update CLAUDE.md with important learnings 5) Finish the current task and stop. A new session can continue where this one left off."

    # Output JSON for Claude to see via additionalContext
    # This format is recognized by Claude Code's UserPromptSubmit hook handler
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
    # Debug logging if enabled
    if [[ -n "${JUNO_DEBUG:-}" ]]; then
        echo "[session_counter] Session $SESSION_ID: message $NEW_COUNT of $THRESHOLD" >&2
    fi
fi

# Always exit 0 - hooks should not block Claude Code
exit 0
