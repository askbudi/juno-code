#!/usr/bin/env python3
"""
Test script to verify multi-line string rendering in claude.py
This tests all three cases:
1. Assistant message content
2. Tool result content
3. Result field in final response
"""

import json
import sys
import os

# Add dist/templates/services to path to import ClaudeService
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'dist', 'templates', 'services'))

from claude import ClaudeService

def test_multiline_rendering():
    """Test the pretty_format_json method with different multi-line scenarios"""
    service = ClaudeService()

    print("=" * 80)
    print("MULTI-LINE RENDERING TEST")
    print("=" * 80)

    # Test Case 1: Assistant message with multi-line content
    print("\n1. Testing Assistant Message with Multi-line Content:")
    print("-" * 80)
    assistant_msg = json.dumps({
        "type": "assistant",
        "message": {
            "content": [{
                "type": "text",
                "text": "Line 1\nLine 2\nLine 3"
            }]
        }
    })
    result1 = service.pretty_format_json(assistant_msg)
    print(result1)
    assert '\n' in result1, "Assistant message should be formatted with newlines"
    assert '"content": "Line 1\\nLine 2\\nLine 3"' in result1, "Content should preserve multi-line"
    print("✅ PASS: Assistant message multi-line rendering works")

    # Test Case 2: Tool result with multi-line content
    print("\n2. Testing Tool Result with Multi-line Content:")
    print("-" * 80)
    tool_result_msg = json.dumps({
        "type": "tool_result",
        "content": [{
            "tool_use_id": "call_123",
            "type": "tool_result",
            "content": "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        99G   64G   31G  68% /",
            "is_error": False
        }]
    })
    result2 = service.pretty_format_json(tool_result_msg)
    print(result2)
    # Check if result is formatted with indentation (multiple lines)
    assert result2.count('\n') > 1, "Tool result should be formatted with multiple newlines"
    print("✅ PASS: Tool result multi-line rendering works")

    # Test Case 3: Result field in final response
    print("\n3. Testing Result Field with Multi-line Content:")
    print("-" * 80)
    result_msg = json.dumps({
        "type": "result",
        "subtype": "success",
        "result": "## Status Update\n\n**Current State**: Good\n\n### Details\n\n1. Item 1\n2. Item 2",
        "is_error": False
    })
    result3 = service.pretty_format_json(result_msg)
    print(result3)
    # Check if result is formatted with indentation (multiple lines)
    assert result3.count('\n') > 1, "Result field should be formatted with multiple newlines"
    print("✅ PASS: Result field multi-line rendering works")

    # Test Case 4: Single-line content should NOT be indented
    print("\n4. Testing Single-line Content (should NOT be indented):")
    print("-" * 80)
    single_line_msg = json.dumps({
        "type": "assistant",
        "message": {
            "content": [{
                "type": "text",
                "text": "Single line content"
            }]
        }
    })
    result4 = service.pretty_format_json(single_line_msg)
    print(result4)
    # Single line should be compact (one line of JSON)
    assert result4.count('\n') == 0, "Single-line content should be compact"
    print("✅ PASS: Single-line content remains compact")

    print("\n" + "=" * 80)
    print("ALL TESTS PASSED ✅")
    print("=" * 80)

if __name__ == "__main__":
    test_multiline_rendering()
