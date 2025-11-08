#!/usr/bin/env bash

# clean_logs_folder.sh
#
# Purpose: Archive log files older than 3 days from .juno_task/logs/*.logs to .juno_task/logs/archive.zip
#
# This script:
# 1. Finds all .logs files in .juno_task/logs/ that are 3 days or older
# 2. Adds them to .juno_task/logs/archive.zip (creates or appends)
# 3. Removes the archived log files to free up space
#
# Usage: ./clean_logs_folder.sh
#
# Created by: juno-code init command
# Date: Auto-generated during project initialization

set -euo pipefail  # Exit on error, undefined variable, or pipe failure

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUNO_TASK_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="${JUNO_TASK_DIR}/logs"
ARCHIVE_FILE="${LOGS_DIR}/archive.zip"
LOG_PATTERN="*.logs"
DAYS_OLD=3

# Logging function
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if logs directory exists
if [ ! -d "$LOGS_DIR" ]; then
    log_warning "Logs directory not found: $LOGS_DIR"
    log_info "Creating logs directory..."
    mkdir -p "$LOGS_DIR"
    log_success "Logs directory created"
    exit 0
fi

# Check if zip command is available
if ! command -v zip &> /dev/null; then
    log_error "zip command not found. Please install zip utility."
    log_info "  macOS: zip is pre-installed"
    log_info "  Ubuntu/Debian: sudo apt-get install zip"
    log_info "  RHEL/CentOS: sudo yum install zip"
    exit 1
fi

# Find log files older than specified days
log_info "Searching for log files older than ${DAYS_OLD} days in: $LOGS_DIR"

# Use find command to locate old log files
# -type f: only files
# -name: match pattern
# -mtime +N: modified more than N days ago
OLD_LOGS=$(find "$LOGS_DIR" -maxdepth 1 -type f -name "$LOG_PATTERN" -mtime +${DAYS_OLD} 2>/dev/null || true)

# Count the number of files found
FILE_COUNT=$(echo "$OLD_LOGS" | grep -c . || echo "0")

if [ "$FILE_COUNT" -eq 0 ]; then
    log_info "No log files older than ${DAYS_OLD} days found. Nothing to archive."
    exit 0
fi

log_info "Found ${FILE_COUNT} log file(s) to archive"

# Create a temporary list file for files to archive
TEMP_LIST=$(mktemp)
trap 'rm -f "$TEMP_LIST"' EXIT  # Clean up temp file on exit

echo "$OLD_LOGS" > "$TEMP_LIST"

# Archive the old log files
log_info "Archiving log files to: $ARCHIVE_FILE"

# Change to logs directory to avoid storing full paths in zip
cd "$LOGS_DIR"

# Initialize counters
ARCHIVED_COUNT=0
FAILED_COUNT=0

# Process each file
while IFS= read -r log_file; do
    if [ -z "$log_file" ]; then
        continue
    fi

    # Get just the filename (remove directory path)
    filename=$(basename "$log_file")

    # Check if file still exists (safety check)
    if [ ! -f "$filename" ]; then
        log_warning "File not found: $filename (skipping)"
        continue
    fi

    # Add file to archive (update if exists, create if doesn't)
    # -u: update existing archive or create new
    # -q: quiet mode
    # -9: maximum compression
    if zip -u -q -9 "archive.zip" "$filename" 2>/dev/null; then
        # Verify file was added to archive before deleting
        if unzip -t "archive.zip" "$filename" &>/dev/null; then
            # File successfully archived, now remove it
            rm -f "$filename"
            ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
            log_success "Archived and removed: $filename"
        else
            log_error "Verification failed for: $filename (file NOT removed)"
            FAILED_COUNT=$((FAILED_COUNT + 1))
        fi
    else
        log_error "Failed to archive: $filename"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
done < "$TEMP_LIST"

# Return to original directory
cd - > /dev/null

# Print summary
echo ""
log_info "=== Archive Summary ==="
log_success "Successfully archived: ${ARCHIVED_COUNT} file(s)"

if [ "$FAILED_COUNT" -gt 0 ]; then
    log_warning "Failed to archive: ${FAILED_COUNT} file(s)"
fi

if [ -f "$ARCHIVE_FILE" ]; then
    ARCHIVE_SIZE=$(du -h "$ARCHIVE_FILE" | cut -f1)
    log_info "Archive location: $ARCHIVE_FILE"
    log_info "Archive size: $ARCHIVE_SIZE"

    # Show archive contents count
    TOTAL_ARCHIVED=$(unzip -l "$ARCHIVE_FILE" 2>/dev/null | tail -1 | awk '{print $2}')
    log_info "Total files in archive: ${TOTAL_ARCHIVED}"
fi

echo ""
log_success "Log cleanup completed!"

# Exit with appropriate code
if [ "$FAILED_COUNT" -gt 0 ]; then
    exit 2  # Partial success
else
    exit 0  # Complete success
fi
