#!/usr/bin/env bash

# log_scanner.sh
#
# Purpose: Scan log files for errors/exceptions and create kanban bug reports
#
# Uses ripgrep for high-performance scanning. Detects common error patterns
# across Python (FastAPI, Django, SQLAlchemy, Postgres), Node.js (Express,
# TypeScript), and general application log formats.
#
# Usage: ./.juno_task/scripts/log_scanner.sh [OPTIONS]
#
# Options:
#   --scan-dir <dir>       Directory to scan (default: project root)
#   --state-file <path>    Path to timestamp state file (default: .juno_task/.log_scanner_state)
#   --dry-run              Show what would be reported without creating tasks
#   --reset                Reset the last-checked timestamp (scan everything)
#   --status               Show current scanner state
#   --verbose              Show detailed progress output
#   --help, -h             Show this help message
#
# Environment Variables:
#   LOG_SCANNER_LAST_CHECKED  Override the last-checked timestamp (ISO 8601)
#   LOG_SCANNER_STATE_FILE    Override state file path
#   LOG_SCANNER_SCAN_DIR      Override scan directory
#   LOG_SCANNER_MAX_TASKS     Max kanban tasks to create per run (default: 10)
#   LOG_SCANNER_LOG_GLOBS     Comma-separated glob patterns for log files
#                             (default: *.log,*.log.*,*.err)
#   JUNO_DEBUG                Enable debug output when set to "true"
#
# Created by: juno-code init command
# Date: Auto-generated during project initialization

set -euo pipefail

VERSION="1.0.0"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Defaults ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
KANBAN_SCRIPT="$SCRIPT_DIR/kanban.sh"

DEFAULT_STATE_FILE=".juno_task/.log_scanner_state"
DEFAULT_SCAN_DIR="$PROJECT_ROOT"
DEFAULT_MAX_TASKS=10
DEFAULT_LOG_GLOBS="*.log,*.log.*,*.err"

STATE_FILE="${LOG_SCANNER_STATE_FILE:-$DEFAULT_STATE_FILE}"
SCAN_DIR="${LOG_SCANNER_SCAN_DIR:-$DEFAULT_SCAN_DIR}"
MAX_TASKS="${LOG_SCANNER_MAX_TASKS:-$DEFAULT_MAX_TASKS}"
LOG_GLOBS="${LOG_SCANNER_LOG_GLOBS:-$DEFAULT_LOG_GLOBS}"

# Modes
DRY_RUN=false
RESET_MODE=false
STATUS_MODE=false
VERBOSE=false

# ── Logging ──────────────────────────────────────────────────────────────────
log_debug() {
    if [ "${JUNO_DEBUG:-false}" = "true" ]; then
        echo -e "${CYAN}[DEBUG]${NC} $1" >&2
    fi
}

log_info() {
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${BLUE}[LOG_SCANNER]${NC} $1" >&2
    fi
}

log_warn() {
    echo -e "${YELLOW}[LOG_SCANNER]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[LOG_SCANNER]${NC} $1" >&2
}

log_success() {
    echo -e "${GREEN}[LOG_SCANNER]${NC} $1" >&2
}

# ── Help ─────────────────────────────────────────────────────────────────────
show_help() {
    cat << 'HELPEOF'
log_scanner.sh - Scan log files for errors and create kanban bug reports

SYNOPSIS
    log_scanner.sh [OPTIONS]

DESCRIPTION
    Scans log files in the project for errors, exceptions, tracebacks, and
    other failure indicators. When issues are found, creates kanban tasks
    with context (surrounding lines) so an agent can investigate.

    Uses ripgrep (rg) for high-performance searching. Falls back to grep
    if ripgrep is not installed.

    Only scans entries newer than the last scan to avoid duplicate reports.

OPTIONS
    --scan-dir <dir>
        Directory to scan for log files. Default: project root

    --state-file <path>
        Path to the state file that tracks last scan time.
        Default: .juno_task/.log_scanner_state

    --dry-run
        Show what errors would be reported without creating kanban tasks.

    --reset
        Clear the last-checked timestamp so the next run scans all entries.

    --status
        Show current scanner state (last scan time, log file count).

    --verbose
        Show detailed progress during scanning.

    --help, -h
        Show this help message.

ENVIRONMENT VARIABLES
    LOG_SCANNER_LAST_CHECKED
        Override the last-checked timestamp (ISO 8601 format).
        Takes precedence over the state file.

    LOG_SCANNER_STATE_FILE
        Override the state file path.

    LOG_SCANNER_SCAN_DIR
        Override the directory to scan.

    LOG_SCANNER_MAX_TASKS
        Maximum kanban tasks to create per run. Default: 10

    LOG_SCANNER_LOG_GLOBS
        Comma-separated glob patterns for log files.
        Default: *.log,*.log.*,*.err

    JUNO_DEBUG
        Set to "true" for debug output.

DETECTED PATTERNS
    Python:
        - Traceback (most recent call last)
        - Exception, Error suffixed classes (ValueError, TypeError, etc.)
        - FastAPI/Starlette errors, HTTPException
        - SQLAlchemy/database errors (IntegrityError, OperationalError)
        - PostgreSQL errors (FATAL, ERROR, PANIC)
        - Django errors (ImproperlyConfigured, etc.)

    Node.js:
        - Unhandled promise rejection, uncaught exception
        - TypeError, ReferenceError, SyntaxError, RangeError
        - ECONNREFUSED, ENOENT, EACCES, ETIMEDOUT
        - Express/Fastify errors
        - Stack traces (at Module., at Object., at Function.)

    General:
        - FATAL, CRITICAL, PANIC log levels
        - ERROR log level (with common log formats)
        - Segmentation fault, core dump, out of memory
        - Connection refused/timeout/reset
        - Permission denied, access denied
        - Killed, OOMKilled

EXAMPLES
    # Scan project logs (first run scans everything)
    ./.juno_task/scripts/log_scanner.sh

    # Dry run to preview what would be reported
    ./.juno_task/scripts/log_scanner.sh --dry-run --verbose

    # Scan a specific directory
    ./.juno_task/scripts/log_scanner.sh --scan-dir /var/log/myapp

    # Reset and re-scan all entries
    ./.juno_task/scripts/log_scanner.sh --reset && ./.juno_task/scripts/log_scanner.sh

    # Use as a pre-run hook in config.json
    # {
    #   "hooks": {
    #     "START_ITERATION": {
    #       "commands": ["./.juno_task/scripts/log_scanner.sh --verbose"]
    #     }
    #   }
    # }

VERSION
    1.0.0

SEE ALSO
    kanban.sh, run_until_completion.sh
HELPEOF
}

# ── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --scan-dir)
            if [[ -n "${2:-}" ]]; then
                SCAN_DIR="$2"
                shift 2
            else
                log_error "--scan-dir requires a directory path"
                exit 1
            fi
            ;;
        --state-file)
            if [[ -n "${2:-}" ]]; then
                STATE_FILE="$2"
                shift 2
            else
                log_error "--state-file requires a file path"
                exit 1
            fi
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --reset)
            RESET_MODE=true
            shift
            ;;
        --status)
            STATUS_MODE=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        --version)
            echo "log_scanner.sh version $VERSION"
            exit 0
            ;;
        *)
            log_warn "Unknown option: $1 (ignored)"
            shift
            ;;
    esac
done

# ── Resolve paths ────────────────────────────────────────────────────────────
cd "$PROJECT_ROOT"

# Make STATE_FILE absolute if relative
if [[ "$STATE_FILE" != /* ]]; then
    STATE_FILE="$PROJECT_ROOT/$STATE_FILE"
fi

# Make SCAN_DIR absolute if relative
if [[ "$SCAN_DIR" != /* ]]; then
    SCAN_DIR="$PROJECT_ROOT/$SCAN_DIR"
fi

# ── Prereqs ──────────────────────────────────────────────────────────────────
# Detect search tool: prefer ripgrep for speed
SEARCH_CMD=""
if command -v rg &>/dev/null; then
    SEARCH_CMD="rg"
    log_debug "Using ripgrep (rg) for search"
elif command -v grep &>/dev/null; then
    SEARCH_CMD="grep"
    log_warn "ripgrep not found, falling back to grep (slower)"
else
    log_error "Neither ripgrep (rg) nor grep found. Cannot scan logs."
    exit 1
fi

# ── State management ────────────────────────────────────────────────────────
get_last_checked() {
    # Priority: ENV > state file > epoch
    if [[ -n "${LOG_SCANNER_LAST_CHECKED:-}" ]]; then
        echo "$LOG_SCANNER_LAST_CHECKED"
        return
    fi
    if [[ -f "$STATE_FILE" ]]; then
        cat "$STATE_FILE" 2>/dev/null || echo ""
    else
        echo ""
    fi
}

save_last_checked() {
    local timestamp="$1"
    local state_dir
    state_dir="$(dirname "$STATE_FILE")"
    mkdir -p "$state_dir" 2>/dev/null || true
    echo "$timestamp" > "$STATE_FILE"
    log_debug "Saved last-checked timestamp: $timestamp"
}

# Convert ISO timestamp to epoch seconds (cross-platform)
timestamp_to_epoch() {
    local ts="$1"
    if [[ -z "$ts" ]]; then
        echo "0"
        return
    fi
    # Try GNU date first, then BSD date
    if date -d "$ts" +%s 2>/dev/null; then
        return
    elif date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null; then
        return
    elif date -j -f "%Y-%m-%d %H:%M:%S" "$ts" +%s 2>/dev/null; then
        return
    else
        echo "0"
    fi
}

# Get current time as ISO 8601
now_iso() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Get file modification time as epoch (cross-platform)
file_mtime_epoch() {
    local filepath="$1"
    if stat -c %Y "$filepath" 2>/dev/null; then
        return
    elif stat -f %m "$filepath" 2>/dev/null; then
        return
    else
        echo "0"
    fi
}

# ── Handle modes ─────────────────────────────────────────────────────────────

# Handle --reset
if [[ "$RESET_MODE" = "true" ]]; then
    if [[ -f "$STATE_FILE" ]]; then
        rm "$STATE_FILE"
        log_success "Last-checked timestamp reset. Next run will scan all log entries."
    else
        log_info "No state file found. Nothing to reset."
    fi
    exit 0
fi

# Handle --status
if [[ "$STATUS_MODE" = "true" ]]; then
    echo "=== Log Scanner Status ===" >&2
    echo "Scan directory: $SCAN_DIR" >&2
    echo "State file: $STATE_FILE" >&2
    echo "Max tasks per run: $MAX_TASKS" >&2
    echo "Log globs: $LOG_GLOBS" >&2
    echo "Search tool: $SEARCH_CMD" >&2

    last_ts=$(get_last_checked)
    if [[ -n "$last_ts" ]]; then
        echo "Last scan: $last_ts" >&2
    else
        echo "Last scan: never (will scan all entries)" >&2
    fi

    # Count log files
    log_count=0
    IFS=',' read -ra GLOBS <<< "$LOG_GLOBS"
    for glob in "${GLOBS[@]}"; do
        glob=$(echo "$glob" | xargs)  # trim whitespace
        count=$(find "$SCAN_DIR" -name "$glob" -type f 2>/dev/null | wc -l | xargs)
        log_count=$((log_count + count))
    done
    echo "Log files found: $log_count" >&2
    exit 0
fi

# ── Build the error pattern ─────────────────────────────────────────────────
#
# Single comprehensive regex pattern for ripgrep.
# We use alternation (|) to combine all patterns into one rg call for speed.
# The pattern is case-insensitive for some parts but case-sensitive for others,
# so we use two passes: one case-insensitive for general terms, one
# case-sensitive for specific class names.

# Case-INSENSITIVE patterns (general error indicators)
# These catch error/exception mentions regardless of casing
PATTERN_INSENSITIVE=$(cat << 'PATEOF'
(fatal|panic|critical)\s*[:\]|]
|segmentation\s+fault
|core\s+dump(ed)?
|out\s+of\s+memory
|oom\s*kill
|killed\s+process
|connection\s+(refused|timed?\s*out|reset)
|permission\s+denied
|access\s+denied
|stack\s*overflow
|deadlock\s+detected
|disk\s+full
|no\s+space\s+left
|too\s+many\s+open\s+files
PATEOF
)

# Case-SENSITIVE patterns (specific error classes and log formats)
PATTERN_SENSITIVE=$(cat << 'PATEOF'
Traceback \(most recent call last\)
|^\s*(raise\s+)?\w*Error(\(|:|\s)
|^\s*(raise\s+)?\w*Exception(\(|:|\s)
|\b(ValueError|TypeError|KeyError|AttributeError|ImportError|ModuleNotFoundError)\b
|\b(RuntimeError|StopIteration|IndexError|NameError|FileNotFoundError)\b
|\b(ConnectionError|TimeoutError|OSError|IOError|PermissionError)\b
|\b(IntegrityError|OperationalError|ProgrammingError|DataError|DatabaseError)\b
|\b(HTTPException|RequestValidationError|ValidationError)\b
|\b(ImproperlyConfigured|ObjectDoesNotExist)\b
|\bERROR\b\s*[\[|\]:]
|\bFATAL\b\s*[\[|\]:]
|\bPANIC\b\s*[\[|\]:]
|\bCRITICAL\b\s*[\[|\]:]
|\bUnhandledPromiseRejection\b
|\buncaughtException\b
|\bUnhandled\s+rejection\b
|\b(ECONNREFUSED|ENOENT|EACCES|ETIMEDOUT|EADDRINUSE|EPERM|ENOMEM)\b
|\bReferenceError\b
|\bSyntaxError\b
|\bRangeError\b
|\bURIError\b
|\bEvalError\b
|\bAggregateError\b
|ERR!\s
|npm\s+ERR!
|Error:\s+Cannot\s+find\s+module
|SIGKILL|SIGTERM|SIGSEGV|SIGABRT
PATEOF
)

# Clean up patterns: remove newlines to form single-line regex
PATTERN_INSENSITIVE=$(echo "$PATTERN_INSENSITIVE" | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')
PATTERN_SENSITIVE=$(echo "$PATTERN_SENSITIVE" | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')

# ── Build glob arguments ────────────────────────────────────────────────────
build_glob_args() {
    local globs_csv="$1"
    local args=()
    IFS=',' read -ra GLOBS <<< "$globs_csv"
    for glob in "${GLOBS[@]}"; do
        glob=$(echo "$glob" | xargs)  # trim
        if [[ "$SEARCH_CMD" == "rg" ]]; then
            args+=("--glob" "$glob")
        fi
    done
    echo "${args[@]}"
}

# ── Scan for errors ─────────────────────────────────────────────────────────
# Collects matching lines with context into a temporary results file.
# Each "hit" is a block of lines (match + context).

scan_logs() {
    local results_file="$1"
    local last_checked_ts="$2"
    local last_checked_epoch=0
    local total_hits=0

    if [[ -n "$last_checked_ts" ]]; then
        last_checked_epoch=$(timestamp_to_epoch "$last_checked_ts")
    fi

    log_info "Scanning directory: $SCAN_DIR"
    log_info "Last checked: ${last_checked_ts:-never}"

    # Build glob arguments for rg
    local glob_args
    IFS=' ' read -ra glob_args <<< "$(build_glob_args "$LOG_GLOBS")"

    # Collect log files and filter by modification time
    local log_files=()
    IFS=',' read -ra GLOBS <<< "$LOG_GLOBS"
    for glob in "${GLOBS[@]}"; do
        glob=$(echo "$glob" | xargs)
        while IFS= read -r f; do
            if [[ -n "$f" && -f "$f" ]]; then
                # Filter by file modification time
                local fmtime
                fmtime=$(file_mtime_epoch "$f")
                if [[ "$fmtime" -gt "$last_checked_epoch" ]] || [[ "$last_checked_epoch" -eq 0 ]]; then
                    log_files+=("$f")
                fi
            fi
        done < <(find "$SCAN_DIR" -name "$glob" -type f \
            -not -path "*/.git/*" \
            -not -path "*/node_modules/*" \
            -not -path "*/.venv*" \
            -not -path "*/__pycache__/*" \
            -not -path "*/dist/*" \
            -not -path "*/.juno_task/*" \
            2>/dev/null || true)
    done

    local file_count=${#log_files[@]}
    log_info "Found $file_count log file(s) modified since last scan"

    if [[ "$file_count" -eq 0 ]]; then
        log_info "No log files to scan."
        return 0
    fi

    # Run ripgrep (or grep) on each file
    for logfile in "${log_files[@]}"; do
        log_debug "Scanning: $logfile"

        local rel_path
        rel_path=$(realpath --relative-to="$PROJECT_ROOT" "$logfile" 2>/dev/null || echo "$logfile")

        if [[ "$SEARCH_CMD" == "rg" ]]; then
            # Case-insensitive pass
            rg --no-heading --line-number --context 3 \
                --ignore-case \
                "$PATTERN_INSENSITIVE" \
                "$logfile" 2>/dev/null | while IFS= read -r line; do
                echo "FILE:$rel_path|$line"
            done >> "$results_file" || true

            # Case-sensitive pass
            rg --no-heading --line-number --context 3 \
                "$PATTERN_SENSITIVE" \
                "$logfile" 2>/dev/null | while IFS= read -r line; do
                echo "FILE:$rel_path|$line"
            done >> "$results_file" || true
        else
            # grep fallback — case-insensitive pass
            grep -n -i -E "$PATTERN_INSENSITIVE" \
                -B 3 -A 3 \
                "$logfile" 2>/dev/null | while IFS= read -r line; do
                echo "FILE:$rel_path|$line"
            done >> "$results_file" || true

            # grep fallback — case-sensitive pass
            grep -n -E "$PATTERN_SENSITIVE" \
                -B 3 -A 3 \
                "$logfile" 2>/dev/null | while IFS= read -r line; do
                echo "FILE:$rel_path|$line"
            done >> "$results_file" || true
        fi
    done

    # Count unique matching blocks (separated by -- in rg/grep context output)
    if [[ -f "$results_file" ]]; then
        total_hits=$(grep -c "^FILE:" "$results_file" 2>/dev/null || echo "0")
    fi

    log_info "Found $total_hits matching line(s) across $file_count file(s)"
    return 0
}

# ── Deduplicate and group results ────────────────────────────────────────────
# Groups results by file and creates distinct error blocks.
# Returns an array of error descriptions suitable for kanban tasks.

deduplicate_results() {
    local results_file="$1"
    local output_file="$2"

    if [[ ! -f "$results_file" ]] || [[ ! -s "$results_file" ]]; then
        return 0
    fi

    # Group consecutive lines from the same file into blocks.
    # rg/grep context separators (--) denote block boundaries.
    local current_file=""
    local current_block=""
    local block_count=0

    while IFS= read -r raw_line; do
        if [[ "$raw_line" == *"--"* ]] && [[ ! "$raw_line" == FILE:* ]]; then
            # Block separator — flush current block
            if [[ -n "$current_block" && "$block_count" -lt "$MAX_TASKS" ]]; then
                echo "---BLOCK---" >> "$output_file"
                echo "file: $current_file" >> "$output_file"
                echo "$current_block" >> "$output_file"
                block_count=$((block_count + 1))
                current_block=""
            fi
            continue
        fi

        if [[ "$raw_line" == FILE:* ]]; then
            # Extract file path and content
            local file_part="${raw_line#FILE:}"
            local file_name="${file_part%%|*}"
            local content="${file_part#*|}"

            if [[ "$file_name" != "$current_file" && -n "$current_block" && "$block_count" -lt "$MAX_TASKS" ]]; then
                # New file — flush previous block
                echo "---BLOCK---" >> "$output_file"
                echo "file: $current_file" >> "$output_file"
                echo "$current_block" >> "$output_file"
                block_count=$((block_count + 1))
                current_block=""
            fi

            current_file="$file_name"
            if [[ -n "$current_block" ]]; then
                current_block="$current_block"$'\n'"$content"
            else
                current_block="$content"
            fi
        fi
    done < "$results_file"

    # Flush last block
    if [[ -n "$current_block" && "$block_count" -lt "$MAX_TASKS" ]]; then
        echo "---BLOCK---" >> "$output_file"
        echo "file: $current_file" >> "$output_file"
        echo "$current_block" >> "$output_file"
        block_count=$((block_count + 1))
    fi

    log_info "Grouped into $block_count error block(s)"
}

# ── Create kanban tasks ──────────────────────────────────────────────────────
create_kanban_tasks() {
    local blocks_file="$1"
    local tasks_created=0

    if [[ ! -f "$blocks_file" ]] || [[ ! -s "$blocks_file" ]]; then
        log_info "No error blocks to report."
        return 0
    fi

    if [[ ! -f "$KANBAN_SCRIPT" ]]; then
        log_error "kanban.sh not found at: $KANBAN_SCRIPT"
        log_error "Cannot create tasks. Run 'juno-code init' first."
        return 1
    fi

    local current_file=""
    local current_body=""
    local in_block=false

    while IFS= read -r line; do
        if [[ "$line" == "---BLOCK---" ]]; then
            # Flush previous block as a kanban task
            if [[ "$in_block" = "true" && -n "$current_body" ]]; then
                create_single_task "$current_file" "$current_body"
                tasks_created=$((tasks_created + 1))
                if [[ "$tasks_created" -ge "$MAX_TASKS" ]]; then
                    log_warn "Reached max tasks limit ($MAX_TASKS). Stopping."
                    break
                fi
            fi
            current_file=""
            current_body=""
            in_block=true
            continue
        fi

        if [[ "$line" == file:\ * ]]; then
            current_file="${line#file: }"
            continue
        fi

        if [[ "$in_block" = "true" ]]; then
            if [[ -n "$current_body" ]]; then
                current_body="$current_body"$'\n'"$line"
            else
                current_body="$line"
            fi
        fi
    done < "$blocks_file"

    # Flush last block
    if [[ "$in_block" = "true" && -n "$current_body" && "$tasks_created" -lt "$MAX_TASKS" ]]; then
        create_single_task "$current_file" "$current_body"
        tasks_created=$((tasks_created + 1))
    fi

    if [[ "$tasks_created" -gt 0 ]]; then
        log_success "Created $tasks_created kanban task(s) from log errors"
    else
        log_info "No new kanban tasks created."
    fi
}

create_single_task() {
    local file="$1"
    local body="$2"

    # Truncate body if too long (keep first 40 lines)
    local line_count
    line_count=$(echo "$body" | wc -l | xargs)
    if [[ "$line_count" -gt 40 ]]; then
        body=$(echo "$body" | head -40)
        body="$body"$'\n'"... (truncated, $line_count total lines)"
    fi

    # Extract the first actual error line for the task title
    local error_line
    error_line=$(echo "$body" | grep -m1 -iE \
        '(error|exception|fatal|panic|critical|traceback|refused|denied|killed|segfault|ECONNREFUSED|ENOENT)' \
        2>/dev/null || echo "Error detected in log")
    error_line=$(echo "$error_line" | head -c 120)  # cap length

    local task_body="[Bug Report - Log Scanner]
File: $file
Error: $error_line

Context:
$body"

    if [[ "$DRY_RUN" = "true" ]]; then
        echo "" >&2
        echo -e "${YELLOW}[DRY RUN] Would create task:${NC}" >&2
        echo -e "  File: $file" >&2
        echo -e "  Error: $error_line" >&2
        echo -e "  Context lines: $line_count" >&2
        return 0
    fi

    log_info "Creating kanban task for error in $file..."

    # Escape single quotes in the task body for shell safety
    local escaped_body
    escaped_body=$(printf '%s' "$task_body" | sed "s/'/'\\\\''/g")

    # Create the kanban task
    local result
    if result=$("$KANBAN_SCRIPT" create "$task_body" --tags "log-scanner,bug-report" < /dev/null 2>&1); then
        local task_id
        task_id=$(echo "$result" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//' || echo "unknown")
        log_success "Created task $task_id for: $error_line"
    else
        log_error "Failed to create kanban task: $result"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
    local scan_start
    scan_start=$(now_iso)

    log_info "=== Log Scanner v$VERSION ==="
    log_info "Scan directory: $SCAN_DIR"

    # Get last-checked timestamp
    local last_checked
    last_checked=$(get_last_checked)

    # Create temp files for intermediate results
    local tmp_dir
    tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t 'log_scanner')
    local raw_results="$tmp_dir/raw_results.txt"
    local grouped_blocks="$tmp_dir/grouped_blocks.txt"
    touch "$raw_results" "$grouped_blocks"

    # Cleanup on exit
    trap "rm -rf '$tmp_dir'" EXIT

    # Phase 1: Scan log files
    log_info "Phase 1: Scanning log files..."
    scan_logs "$raw_results" "$last_checked"

    # Phase 2: Deduplicate and group
    log_info "Phase 2: Grouping results..."
    deduplicate_results "$raw_results" "$grouped_blocks"

    # Phase 3: Create kanban tasks (or dry-run)
    log_info "Phase 3: Creating kanban tasks..."
    create_kanban_tasks "$grouped_blocks"

    # Save the scan timestamp (even in dry-run to avoid re-scanning on next real run)
    if [[ "$DRY_RUN" != "true" ]]; then
        save_last_checked "$scan_start"
    fi

    log_info "Scan complete."
}

main
