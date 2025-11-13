#!/usr/bin/env python3
"""
Test script to verify multi-line string rendering fix in claude.py
"""

import json
import sys
from datetime import datetime

# Simulate the ClaudeService pretty_format_json method
class TestClaudeService:
    def __init__(self):
        self.message_counter = 0

    def pretty_format_json(self, json_line: str):
        """
        Format JSON line for pretty output.
        This is the NEW implementation that fixes Issue #17.
        """
        try:
            data = json.loads(json_line)
            self.message_counter += 1

            # Get current datetime in readable format
            now = datetime.now().strftime("%I:%M:%S %p")

            # For assistant messages, show simplified output
            if data.get("type") == "assistant":
                message = data.get("message", {})
                content_list = message.get("content", [])

                # Extract text content or tool_use from content array
                text_content = ""
                tool_use_data = None

                for item in content_list:
                    if isinstance(item, dict):
                        if item.get("type") == "text":
                            text_content = item.get("text", "")
                            break
                        elif item.get("type") == "tool_use":
                            # Extract tool name and input for tool_use
                            tool_use_data = {
                                "name": item.get("name", ""),
                                "input": item.get("input", {})
                            }
                            break

                # Create simplified output with datetime, content/tool_use, and counter
                simplified = {
                    "type": "assistant",
                    "datetime": now,
                    "counter": f"#{self.message_counter}"
                }

                # Add either content or tool_use data
                if tool_use_data:
                    simplified["tool_use"] = tool_use_data
                    # Normal JSON output for tool_use
                    return json.dumps(simplified, ensure_ascii=False)
                else:
                    # For content, check if it has newlines
                    if '\n' in text_content:
                        # Multi-line content: print JSON metadata, then raw content
                        metadata = {
                            "type": "assistant",
                            "datetime": now,
                            "counter": f"#{self.message_counter}"
                        }
                        # Print metadata as compact JSON on first line
                        output = json.dumps(metadata, ensure_ascii=False)
                        # Then print content label and raw multi-line text
                        output += "\ncontent:\n" + text_content
                        return output
                    else:
                        # Single-line content: normal JSON
                        simplified["content"] = text_content
                        return json.dumps(simplified, ensure_ascii=False)
            else:
                # For other message types, show full message with datetime and counter
                output = {
                    "datetime": now,
                    "counter": f"#{self.message_counter}",
                    **data
                }

                # Check if 'result' field has multi-line content
                if "result" in output and isinstance(output["result"], str) and '\n' in output["result"]:
                    # Multi-line result: separate metadata from content
                    result_value = output.pop("result")
                    # Print metadata as compact JSON
                    metadata_json = json.dumps(output, ensure_ascii=False)
                    # Then print result label and raw multi-line text
                    return metadata_json + "\nresult:\n" + result_value
                else:
                    # Normal JSON output
                    return json.dumps(output, ensure_ascii=False)

        except json.JSONDecodeError:
            # If not valid JSON, return as-is
            return json_line


def main():
    """Test the multi-line rendering fix"""
    service = TestClaudeService()

    print("=" * 80)
    print("TEST 1: Single-line content (should be compact JSON)")
    print("=" * 80)

    test1 = json.dumps({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "This is a single line response"}
            ]
        }
    })

    result1 = service.pretty_format_json(test1)
    print(result1)
    print()

    print("=" * 80)
    print("TEST 2: Multi-line content with \\n\\n (should show actual newlines)")
    print("=" * 80)

    test2 = json.dumps({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "This is line 1\n\nThis is line 2 after blank line\n\nThis is line 3"}
            ]
        }
    })

    result2 = service.pretty_format_json(test2)
    print(result2)
    print()

    print("=" * 80)
    print("TEST 3: tool_result with multi-line result field")
    print("=" * 80)

    test3 = json.dumps({
        "type": "tool_result",
        "result": "Result line 1\n\nResult line 2 after blank\n\nResult line 3"
    })

    result3 = service.pretty_format_json(test3)
    print(result3)
    print()

    print("=" * 80)
    print("TEST 4: tool_use (should be compact JSON)")
    print("=" * 80)

    test4 = json.dumps({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "tool_use", "name": "Read", "input": {"file_path": "/foo/bar"}}
            ]
        }
    })

    result4 = service.pretty_format_json(test4)
    print(result4)
    print()

    print("=" * 80)
    print("VERIFICATION:")
    print("=" * 80)
    print("✓ Test 1: Should be ONE line of compact JSON")
    print("✓ Test 2: Should show metadata JSON on line 1, then 'content:' label, then actual multi-line text")
    print("✓ Test 3: Should show metadata JSON on line 1, then 'result:' label, then actual multi-line text")
    print("✓ Test 4: Should be ONE line of compact JSON")
    print("\nIf the above tests show ACTUAL newlines (not \\n\\n), the fix is working!")


if __name__ == "__main__":
    main()
