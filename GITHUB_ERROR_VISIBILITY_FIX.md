# GitHub.py Error Visibility Fix

## Problem

The `github.py` script's `respond` command (called during sync) was not posting comments to GitHub issues or closing them, but **no error messages were being shown to users**. This made it impossible for users to diagnose authentication or permission issues with their GITHUB_TOKEN.

### Root Cause

1. **Logging to stderr by default**: Python's `logging.basicConfig()` sends all log output to stderr with timestamps
2. **Errors only logged, not printed**: HTTPError exceptions were caught and logged with `logger.error()` but never explicitly printed to the console
3. **Minimal error details**: The error messages didn't extract or display the detailed error information from GitHub API responses
4. **No actionable guidance**: Users weren't given any hints about common causes or how to fix the issues

## Solution

Enhanced error visibility by:

1. **Explicit stderr printing**: Added `print(..., file=sys.stderr)` for all critical errors
2. **Detailed error extraction**: Extract and display GitHub API error messages from HTTPError.response.json()
3. **HTTP status codes**: Show HTTP status codes when JSON parsing fails
4. **Actionable guidance**: Provide specific troubleshooting steps for common error scenarios

## Changes Made

### Location 1: GitHub API Connection Test (handle_fetch)
**File**: `src/templates/scripts/github.py`
**Lines**: 954-965

```python
except requests.exceptions.HTTPError as e:
    error_msg = f"Failed to connect to GitHub: {e}"
    logger.error(error_msg)
    print(f"\n❌ ERROR: {error_msg}", file=sys.stderr)
    if hasattr(e, 'response') and e.response is not None:
        try:
            error_detail = e.response.json()
            print(f"   Details: {error_detail.get('message', 'No details available')}", file=sys.stderr)
        except:
            print(f"   HTTP Status: {e.response.status_code}", file=sys.stderr)
    print("   Check your GITHUB_TOKEN permissions and validity", file=sys.stderr)
    return 1
```

### Location 2: GitHub API Connection Test (handle_respond)
**File**: `src/templates/scripts/github.py`
**Lines**: 1097-1108

Same enhancement as Location 1, ensures both fetch and respond commands show clear error messages.

### Location 3: Comment Posting Errors
**File**: `src/templates/scripts/github.py`
**Lines**: 1225-1243

```python
except requests.exceptions.HTTPError as e:
    errors_count += 1
    error_msg = f"  ✗ Failed to post comment on issue #{issue_number}: {e}"
    logger.error(error_msg)
    print(f"\n{error_msg}", file=sys.stderr)
    if hasattr(e, 'response') and e.response is not None:
        try:
            error_detail = e.response.json()
            detail_msg = f"     Details: {error_detail.get('message', 'No details available')}"
            logger.error(detail_msg)
            print(detail_msg, file=sys.stderr)
        except:
            status_msg = f"     HTTP Status: {e.response.status_code}"
            logger.error(status_msg)
            print(status_msg, file=sys.stderr)
    print("     Common causes:", file=sys.stderr)
    print("     - Missing 'repo' or 'issues' scope in GITHUB_TOKEN", file=sys.stderr)
    print("     - Token doesn't have write access to the repository", file=sys.stderr)
    print("     - Token is expired or revoked", file=sys.stderr)
```

### Location 4: Issue Closing Errors
**File**: `src/templates/scripts/github.py`
**Lines**: 1209-1225

```python
except requests.exceptions.HTTPError as e:
    warning_msg = f"  ⚠ Failed to close issue #{issue_number}: {e}"
    logger.warning(warning_msg)
    print(f"\n{warning_msg}", file=sys.stderr)
    if hasattr(e, 'response') and e.response is not None:
        try:
            error_detail = e.response.json()
            detail_msg = f"     Details: {error_detail.get('message', 'No details available')}"
            logger.warning(detail_msg)
            print(detail_msg, file=sys.stderr)
        except:
            status_msg = f"     HTTP Status: {e.response.status_code}"
            logger.warning(status_msg)
            print(status_msg, file=sys.stderr)
    print("     Note: Comment was posted successfully, but couldn't close the issue", file=sys.stderr)
    print("     Check that GITHUB_TOKEN has 'repo' scope with write permissions", file=sys.stderr)
```

### Location 5: Debug Output Before Posting
**File**: `src/templates/scripts/github.py`
**Lines**: 1210-1212

```python
# Debug output to help troubleshoot
logger.debug(f"Posting comment to {owner}/{repo_name} issue #{issue_number}")
logger.debug(f"Comment preview: {comment_body[:100]}...")
```

## Example Error Output

### Authentication Failure
```
❌ ERROR: Failed to connect to GitHub: 401 Client Error: Unauthorized for url: https://api.github.com/user
   Details: Bad credentials
   Check your GITHUB_TOKEN permissions and validity
```

### Permission Denied (Missing Scopes)
```
  ✗ Failed to post comment on issue #123: 403 Client Error: Forbidden
     Details: Resource not accessible by integration
     Common causes:
     - Missing 'repo' or 'issues' scope in GITHUB_TOKEN
     - Token doesn't have write access to the repository
     - Token is expired or revoked
```

### Issue Close Permission Error
```
  ⚠ Failed to close issue #123: 403 Client Error: Forbidden
     Details: Must have admin rights to Repository.
     Note: Comment was posted successfully, but couldn't close the issue
     Check that GITHUB_TOKEN has 'repo' scope with write permissions
```

## Testing

### Test Script Created
**File**: `test_github_error_output.py`
**Purpose**: Verify error message formatting and detail extraction

**Tests**:
- ✅ HTTPError object creation and attribute verification
- ✅ Error message formatting
- ✅ JSON detail extraction
- ✅ Permission error scenario handling
- ✅ Expected output format verification

### Running Tests
```bash
cd juno-task-ts
python3 test_github_error_output.py
```

## User Impact

### Before Fix
- Users saw no error messages when GitHub operations failed
- Impossible to diagnose GITHUB_TOKEN permission issues
- Silent failures led to confusion and support requests

### After Fix
- Clear, actionable error messages displayed to users
- Detailed GitHub API error messages shown
- Specific troubleshooting guidance provided
- Users can self-diagnose and fix token permission issues

## Common Issues Users Can Now Diagnose

1. **Bad credentials (401)**: Token is invalid or expired
2. **Forbidden (403)**: Token lacks required scopes
3. **Not found (404)**: Repository doesn't exist or token lacks access
4. **Resource not accessible**: Token missing 'repo' or 'issues' scope
5. **Must have admin rights**: Token lacks admin permissions for closing issues

## Backward Compatibility

✅ **Fully backward compatible**
- All logging behavior preserved
- Error codes remain unchanged
- Only adds additional error output to stderr
- No breaking changes to function signatures or return values

## Files Modified

1. `src/templates/scripts/github.py` (Lines: 954-965, 1097-1108, 1209-1243)
2. Build system automatically copies to `dist/templates/scripts/github.py`

## Version

- **Fixed in**: juno-code@1.0.39+
- **Date**: 2026-01-16
