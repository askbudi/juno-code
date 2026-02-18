#!/bin/bash

# File Size Monitoring Hook
# Equivalent to the old preflight functionality - monitors file sizes and triggers compaction
# This can be used as a START_ITERATION hook to check file sizes before each iteration

# Configuration (can be overridden by environment variables)
THRESHOLD=${JUNO_FILE_SIZE_THRESHOLD:-500}
ENABLED=${JUNO_FILE_SIZE_MONITORING:-true}

# Exit if disabled
if [ "$ENABLED" = "false" ]; then
    echo "File size monitoring disabled"
    exit 0
fi

# Function to count lines in a file
count_lines() {
    local file="$1"
    if [ -f "$file" ]; then
        wc -l < "$file"
    else
        echo "0"
    fi
}

# Function to get file size in bytes
get_file_size() {
    local file="$1"
    if [ -f "$file" ]; then
        stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

# Working directory (from hook context)
WORK_DIR="${JUNO_WORKING_DIRECTORY:-$(pwd)}"
cd "$WORK_DIR" || exit 1

echo "🔍 Checking file sizes (threshold: $THRESHOLD lines)..."

# Check USER_FEEDBACK.md
FEEDBACK_FILE=".juno_task/USER_FEEDBACK.md"
if [ -f "$FEEDBACK_FILE" ]; then
    FEEDBACK_LINES=$(count_lines "$FEEDBACK_FILE")
    FEEDBACK_SIZE=$(get_file_size "$FEEDBACK_FILE")

    if [ "$FEEDBACK_LINES" -gt "$THRESHOLD" ]; then
        echo "⚠️  $FEEDBACK_FILE is large: $FEEDBACK_LINES lines (${FEEDBACK_SIZE} bytes)"
        echo "Consider archiving resolved issues or compacting the file"

        # Trigger feedback command if CLI is available
        if command -v juno-code >/dev/null 2>&1; then
            echo "📝 Triggering feedback command..."
            juno-code feedback --issue "File $FEEDBACK_FILE is becoming big ($FEEDBACK_LINES lines), you need to compact it and keep it lean."
        fi
    else
        echo "✅ $FEEDBACK_FILE: $FEEDBACK_LINES lines (within threshold)"
    fi
else
    echo "ℹ️  $FEEDBACK_FILE not found"
fi

# Check config files (CLAUDE.md or AGENTS.md based on subagent)
CONFIG_FILE="CLAUDE.md"
if [ "$JUNO_SUBAGENT" != "claude" ] && [ "$JUNO_SUBAGENT" != "CLAUDE" ]; then
    CONFIG_FILE="AGENTS.md"
fi

if [ -f "$CONFIG_FILE" ]; then
    CONFIG_LINES=$(count_lines "$CONFIG_FILE")
    CONFIG_SIZE=$(get_file_size "$CONFIG_FILE")

    # For config files, also check size threshold (30KB)
    SIZE_THRESHOLD=30720  # 30KB

    if [ "$CONFIG_LINES" -gt "$THRESHOLD" ] && [ "$CONFIG_SIZE" -gt "$SIZE_THRESHOLD" ]; then
        echo "⚠️  $CONFIG_FILE is large: $CONFIG_LINES lines (${CONFIG_SIZE} bytes)"
        echo "Consider compacting the configuration file"

        # Trigger feedback command if CLI is available
        if command -v juno-code >/dev/null 2>&1; then
            echo "📝 Triggering feedback command..."
            juno-code feedback --issue "File $CONFIG_FILE is becoming big ($CONFIG_LINES lines), you need to compact it and keep it lean."
        fi
    else
        echo "✅ $CONFIG_FILE: $CONFIG_LINES lines (within threshold)"
    fi
else
    echo "ℹ️  $CONFIG_FILE not found"
fi

echo "File size check completed"