#!/usr/bin/env python3
"""Test script for user message truncation in claude.py"""

import json
import sys
import os

# Add dist/templates/services to path so we can import the ClaudeService
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'dist/templates/services'))

from claude import ClaudeService

def test_truncation():
    """Test various truncation scenarios"""

    print("=" * 80)
    print("Testing User Message Truncation in claude.py")
    print("=" * 80)

    # Test 1: Default truncation (4 lines)
    print("\n[Test 1] Default truncation (4 lines, no env var set)")
    service = ClaudeService()
    assert service.user_message_truncate == 4, f"Expected 4, got {service.user_message_truncate}"
    print("✓ Default value is 4")

    # Test 2: Custom truncation (2 lines)
    print("\n[Test 2] Custom truncation via ENV (2 lines)")
    os.environ["CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE"] = "2"
    service = ClaudeService()
    assert service.user_message_truncate == 2, f"Expected 2, got {service.user_message_truncate}"
    print("✓ Custom value works: 2")

    # Test 3: No truncation (-1)
    print("\n[Test 3] No truncation via ENV (-1)")
    os.environ["CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE"] = "-1"
    service = ClaudeService()
    assert service.user_message_truncate == -1, f"Expected -1, got {service.user_message_truncate}"
    print("✓ No truncation value works: -1")

    # Test 4: Test actual truncation logic with 4-line message (should NOT truncate)
    print("\n[Test 4] 4-line message with 4-line limit (should NOT truncate)")
    os.environ["CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE"] = "4"
    service = ClaudeService()

    user_message = {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": "Line 1\nLine 2\nLine 3\nLine 4"
                }
            ]
        }
    }

    result = service.pretty_format_json(json.dumps(user_message))
    assert "[Truncated...]" not in result, "Should NOT truncate 4-line message with 4-line limit"
    print("✓ 4-line message NOT truncated")
    print(f"  Output: {result}")

    # Test 5: Test actual truncation logic with 6-line message (should truncate)
    print("\n[Test 5] 6-line message with 4-line limit (SHOULD truncate)")
    user_message = {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"
                }
            ]
        }
    }

    result = service.pretty_format_json(json.dumps(user_message))
    assert "[Truncated...]" in result, "Should truncate 6-line message with 4-line limit"
    # Count lines in output
    lines_in_result = result.count('\n')
    print("✓ 6-line message WAS truncated")
    print(f"  Output preview: {result[:200]}...")

    # Test 6: No truncation with -1
    print("\n[Test 6] 10-line message with -1 (no truncation)")
    os.environ["CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE"] = "-1"
    service = ClaudeService()

    user_message = {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": "\n".join([f"Line {i}" for i in range(1, 11)])
                }
            ]
        }
    }

    result = service.pretty_format_json(json.dumps(user_message))
    assert "[Truncated...]" not in result, "Should NOT truncate with -1"
    print("✓ 10-line message NOT truncated with -1")

    # Test 7: Verify assistant messages are NOT truncated
    print("\n[Test 7] Assistant messages should NOT be truncated")
    os.environ["CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE"] = "2"
    service = ClaudeService()

    assistant_message = {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"
                }
            ]
        }
    }

    result = service.pretty_format_json(json.dumps(assistant_message))
    assert "[Truncated...]" not in result, "Assistant messages should NOT be truncated"
    print("✓ Assistant messages NOT affected by truncation")

    print("\n" + "=" * 80)
    print("All tests PASSED! ✓")
    print("=" * 80)

if __name__ == "__main__":
    try:
        test_truncation()
        sys.exit(0)
    except AssertionError as e:
        print(f"\n❌ Test FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
