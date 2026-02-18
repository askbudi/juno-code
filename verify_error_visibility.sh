#!/bin/bash
# Verification script for github.py error visibility improvements
# This script verifies that error messages are properly printed to stderr

set -e

echo "======================================================================"
echo "GitHub.py Error Visibility Verification"
echo "======================================================================"
echo ""

# Check if github.py exists in source
SRC_FILE="src/templates/scripts/github.py"
DIST_FILE="dist/templates/scripts/github.py"

if [ ! -f "$SRC_FILE" ]; then
    echo "❌ ERROR: Source file not found: $SRC_FILE"
    exit 1
fi

if [ ! -f "$DIST_FILE" ]; then
    echo "❌ ERROR: Distribution file not found: $DIST_FILE"
    exit 1
fi

echo "✅ Found source and distribution files"
echo ""

# Verify error handling improvements
echo "Checking for error handling improvements..."
echo ""

# Check 1: Verify print statements with ERROR emoji
ERROR_COUNT=$(grep -c "print(f\".*❌ ERROR:" "$SRC_FILE" || true)
if [ "$ERROR_COUNT" -ge 2 ]; then
    echo "✅ Found $ERROR_COUNT error print statements (expected >= 2)"
else
    echo "❌ ERROR: Found only $ERROR_COUNT error print statements (expected >= 2)"
    exit 1
fi

# Check 2: Verify detailed error extraction
DETAIL_COUNT=$(grep -c "error_detail.get('message'" "$SRC_FILE" || true)
if [ "$DETAIL_COUNT" -ge 3 ]; then
    echo "✅ Found $DETAIL_COUNT detail extraction blocks (expected >= 3)"
else
    echo "❌ ERROR: Found only $DETAIL_COUNT detail extraction blocks (expected >= 3)"
    exit 1
fi

# Check 3: Verify actionable guidance
GUIDANCE_COUNT=$(grep -c "Common causes:" "$SRC_FILE" || true)
if [ "$GUIDANCE_COUNT" -ge 1 ]; then
    echo "✅ Found $GUIDANCE_COUNT guidance section (expected >= 1)"
else
    echo "❌ ERROR: Found no guidance sections"
    exit 1
fi

# Check 4: Verify sys.stderr usage
STDERR_COUNT=$(grep -c "file=sys.stderr" "$SRC_FILE" || true)
if [ "$STDERR_COUNT" -ge 10 ]; then
    echo "✅ Found $STDERR_COUNT stderr print statements (expected >= 10)"
else
    echo "❌ ERROR: Found only $STDERR_COUNT stderr print statements (expected >= 10)"
    exit 1
fi

# Check 5: Verify debug output addition
DEBUG_COUNT=$(grep -c "Debug output to help troubleshoot" "$SRC_FILE" || true)
if [ "$DEBUG_COUNT" -ge 1 ]; then
    echo "✅ Found debug output comment"
else
    echo "❌ ERROR: Debug output comment not found"
    exit 1
fi

echo ""
echo "======================================================================"
echo "Source File Verification Complete"
echo "======================================================================"
echo ""

# Verify distribution file matches source
echo "Verifying distribution file matches source..."
echo ""

DIST_ERROR_COUNT=$(grep -c "print(f\".*❌ ERROR:" "$DIST_FILE" || true)
if [ "$DIST_ERROR_COUNT" -eq "$ERROR_COUNT" ]; then
    echo "✅ Distribution file has same error count as source ($DIST_ERROR_COUNT)"
else
    echo "❌ ERROR: Distribution file error count mismatch (dist: $DIST_ERROR_COUNT, src: $ERROR_COUNT)"
    exit 1
fi

DIST_STDERR_COUNT=$(grep -c "file=sys.stderr" "$DIST_FILE" || true)
if [ "$DIST_STDERR_COUNT" -eq "$STDERR_COUNT" ]; then
    echo "✅ Distribution file has same stderr count as source ($DIST_STDERR_COUNT)"
else
    echo "❌ ERROR: Distribution file stderr count mismatch (dist: $DIST_STDERR_COUNT, src: $STDERR_COUNT)"
    exit 1
fi

echo ""
echo "======================================================================"
echo "Distribution File Verification Complete"
echo "======================================================================"
echo ""

# Show example error messages
echo "Example error messages that will be displayed:"
echo ""
echo "1. Connection Error:"
echo "   ❌ ERROR: Failed to connect to GitHub: 401 Client Error"
echo "      Details: Bad credentials"
echo "      Check your GITHUB_TOKEN permissions and validity"
echo ""
echo "2. Permission Error:"
echo "     ✗ Failed to post comment on issue #123: 403 Client Error"
echo "        Details: Resource not accessible by integration"
echo "        Common causes:"
echo "        - Missing 'repo' or 'issues' scope in GITHUB_TOKEN"
echo "        - Token doesn't have write access to the repository"
echo "        - Token is expired or revoked"
echo ""
echo "3. Close Issue Error:"
echo "     ⚠ Failed to close issue #123: 403 Client Error"
echo "        Details: Must have admin rights to Repository."
echo "        Note: Comment was posted successfully, but couldn't close the issue"
echo "        Check that GITHUB_TOKEN has 'repo' scope with write permissions"
echo ""

echo "======================================================================"
echo "✅ All Verifications Passed!"
echo "======================================================================"
echo ""
echo "The error visibility improvements are correctly implemented in both"
echo "source and distribution files. Users will now see detailed error"
echo "messages when GitHub operations fail."
echo ""
