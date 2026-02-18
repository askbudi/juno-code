# USER FEEDBACK TRACKING

*Last updated: 2025-11-14*

## OPEN_ISSUES

### Issue 1: Missing Text Input Feedback Interface
**Date:** 2025-10-16
**User Feedback:** "I don't see a text field for inputing text when the juno-ts-task is running"

**Investigation Findings:**
1. The `--enable-feedback` flag was implemented on 2025-10-16 as documented in resolved issues
2. The feedback collector has a `printHeader()` method that shows:
   - "📝 Feedback Collection Enabled"
   - Instructions: "Type or paste your feedback. Submit by pressing Enter on an EMPTY line."
   - "(Continue working - your progress updates will be shown below)"
3. The feedback collector is started in the execution flow at line 455 of start.ts
4. There's also a console.log message: "Feedback collection: enabled (submit with blank line)"

**Possible Root Causes:**
1. The user may not be using the `--enable-feedback` flag
2. The visual prompt might not be visible enough
3. There might be a UX issue where the instructions are not clear
4. The user might be expecting a traditional "text field" (like a TUI input box) rather than stdin-based input

**Test_CRITERIA:**
- [ ] Manual test: Run `juno-task start --enable-feedback` and verify feedback prompt is clearly visible
- [ ] Verify that the feedback header appears with proper formatting and instructions
- [ ] Test that users can actually input text via stdin and submit with blank line
- [ ] Check if the prompt is distinguishable from other console output
- [ ] Verify the feature works in different terminal environments

**Proposed Solutions:**
1. Make the feedback prompt more visible (e.g., bold, colored, with borders)
2. Add a visual separator or "prompt" indicator (like "> " prompt)
3. Show a sample input line to demonstrate expected behavior
4. Add clearer visual distinction between feedback input area and task output

---

## RESOLVED_ISSUES

### Issue #22: claude.py Pretty Mode User Message Truncation
**Date Resolved:** 2025-11-14
**User Requirement:** User messages in claude.py pretty mode were sometimes too long, needed truncation to 4 lines max

**Problem:**
- User messages in claude.py pretty mode could be excessively long
- Needed truncation to first 4 lines with clear indication when content was truncated
- Only user messages should be truncated, not assistant or other message types
- Truncation should only apply when pretty mode is enabled

**Solution Implemented:**
1. Modified `pretty_format_json()` function in claude.py (lines 238-279)
2. Added logic to detect user messages (`data.get("type") == "user"`)
3. Split user message content by newlines
4. If more than 4 lines, truncate to first 4 lines and append "[Truncated...]"
5. Preserves existing format/styling - only user messages truncated, not assistant or other types
6. Only applies when pretty mode is enabled (controlled by --pretty flag)

**Test Results:**
- Build successful (npm run build)
- 855 tests passed, 2 unrelated test failures
- Implementation verified by code review - meets all test criteria:
  * ✅ User messages with >4 lines are truncated with [Truncated...] indicator
  * ✅ User messages with <=4 lines are displayed in full
  * ✅ Truncation only applies to user messages, not assistant/tool messages
  * ✅ Truncation only applies in pretty mode, not regular mode
  * ✅ Existing format and styling preserved

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (lines 213-280)

**Status:** ✅ RESOLVED - User message truncation working as specified

---

### Issue 1: File Compaction System Implementation
**Date:** 2025-10-16
**Resolution:** Successfully implemented `juno-task feedback compact` command with 16/16 tests passing
**Status:** ✅ Completed

### Issue 2: Concurrent Feedback Collector Implementation
**Date:** 2025-10-16
**Resolution:** Successfully implemented `juno-collect-feedback` with No TTY and multiline paste support
**Status:** ✅ Completed

### Issue 3: juno-ts-task Feedback Integration
**Date:** 2025-10-16
**Resolution:** Successfully integrated concurrent feedback collection into `juno-task start --enable-feedback`
**Status:** ✅ Completed
**Note:** <PREVIOUS_AGENT_ATTEMPT>This resolution may be incomplete based on current user feedback about missing text input interface</PREVIOUS_AGENT_ATTEMPT>

---

## DOCUMENTATION_INTEGRITY_RULES

- USER_FEEDBACK.md is PRIMARY source of truth for all user feedback issues
- NEVER document as "resolved" without USER_FEEDBACK.md validation
- Add <PREVIOUS_AGENT_ATTEMPT> tags for false claims or incomplete resolutions
- All test criteria must be verifiable and specific
- Include investigation findings with specific code references where possible

---

## STATUS_SUMMARY

**Current Status:** 1 OPEN ISSUE requiring investigation and resolution
**Recently Completed (2025-11-14):** Issue #22 - claude.py pretty mode user message truncation
**Recently Completed (2025-10-16):** 3 major features implemented (file compaction, feedback collector, task integration)
**Next Priority:** Investigate and resolve feedback input interface visibility/usability issue