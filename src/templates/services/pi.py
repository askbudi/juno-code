#!/usr/bin/env python3
"""
Pi Agent Service Script for juno-code
Headless wrapper around the Pi coding agent CLI with JSON streaming and shorthand model support.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class PiService:
    """Service wrapper for Pi coding agent headless mode."""

    DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

    # Model shorthands — Pi is multi-provider so shorthands include provider/model format.
    # All colon-prefixed shorthands are expanded before being passed to pi CLI.
    MODEL_SHORTHANDS: Dict[str, str] = {
        # Meta shorthand
        ":pi": "anthropic/claude-sonnet-4-6",
        ":default": "anthropic/claude-sonnet-4-6",
        # Anthropic
        ":sonnet": "anthropic/claude-sonnet-4-6",
        ":opus": "anthropic/claude-opus-4-6",
        ":haiku": "anthropic/claude-haiku-4-5-20251001",
        # OpenAI
        ":gpt-5": "openai/gpt-5",
        ":gpt-4o": "openai/gpt-4o",
        ":o3": "openai/o3",
        ":codex": "openai/gpt-5.3-codex",
        # Google
        ":gemini-pro": "google/gemini-2.5-pro",
        ":gemini-flash": "google/gemini-2.5-flash",
        # Groq
        ":groq": "groq/llama-4-scout-17b-16e-instruct",
        # xAI
        ":grok": "xai/grok-3",
    }

    # Default stream types to suppress (Pi outputs lifecycle events that are noisy)
    DEFAULT_HIDDEN_STREAM_TYPES = {
        "auto_compaction_start",
        "auto_compaction_end",
        "auto_retry_start",
        "auto_retry_end",
        "session",
        "message_start",
        "message_end",
        "tool_execution_update",
    }

    # message_update sub-events to suppress (streaming deltas are noisy;
    # completion events like text_end, thinking_end, toolcall_end are kept)
    _PI_HIDDEN_MESSAGE_UPDATE_EVENTS = {
        "text_delta",
        "text_start",
        "thinking_delta",
        "thinking_start",
        "toolcall_delta",
        "toolcall_start",
    }

    # Prettifier mode constants
    PRETTIFIER_PI = "pi"
    PRETTIFIER_CLAUDE = "claude"
    PRETTIFIER_CODEX = "codex"
    PRETTIFIER_LIVE = "live"

    def __init__(self):
        self.model_name = self.DEFAULT_MODEL
        self.project_path = os.getcwd()
        self.prompt = ""
        self.verbose = False
        self.last_result_event: Optional[dict] = None
        self.session_id: Optional[str] = None
        self.message_counter = 0
        self.prettifier_mode = self.PRETTIFIER_PI
        # Claude prettifier state
        self.user_message_truncate = int(os.environ.get("CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE", "4"))
        # Codex prettifier state
        self._item_counter = 0
        self._codex_first_assistant_seen = False
        self._codex_tool_result_max_lines = int(os.environ.get("PI_TOOL_RESULT_MAX_LINES", "6"))
        # Keys to hide from intermediate assistant messages in Codex mode
        self._codex_metadata_keys = {"api", "provider", "model", "usage", "stopReason", "timestamp"}

    def expand_model_shorthand(self, model: str) -> str:
        """Expand shorthand model names (colon-prefixed) to full identifiers."""
        if model.startswith(":"):
            return self.MODEL_SHORTHANDS.get(model, model)
        return model

    def _detect_prettifier_mode(self, model: str) -> str:
        """Detect which prettifier to use based on the resolved model name.

        Pi CLI always uses its own event protocol (message, turn_end,
        message_update, agent_end, etc.) regardless of the underlying LLM.
        The exception is Codex models where Pi wraps Codex-format events
        (agent_reasoning, agent_message, exec_command_end).
        Claude models still use Pi's event protocol, NOT Claude CLI events.
        """
        model_lower = model.lower()
        if "codex" in model_lower:
            return self.PRETTIFIER_CODEX
        # All non-Codex models (including Claude) use Pi's native event protocol
        return self.PRETTIFIER_PI

    def check_pi_installed(self) -> bool:
        """Check if pi CLI is installed and available."""
        try:
            result = subprocess.run(
                ["which", "pi"],
                capture_output=True,
                text=True,
                check=False,
            )
            return result.returncode == 0
        except Exception:
            return False

    def parse_arguments(self) -> argparse.Namespace:
        """Parse command line arguments for the Pi service."""
        parser = argparse.ArgumentParser(
            description="Pi Agent Service - Wrapper for Pi coding agent headless mode",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
Examples:
  %(prog)s -p "Review this code" -m :sonnet
  %(prog)s -pp prompt.txt --model openai/gpt-4o
  %(prog)s -p "Refactor module" --thinking high
  %(prog)s -p "Fix bug" --provider anthropic --model claude-sonnet-4-5-20250929
  %(prog)s -p "Audit code" -m :gpt-5 --tools read,bash,edit

Model shorthands:
  :pi, :default    -> anthropic/claude-sonnet-4-6
  :sonnet          -> anthropic/claude-sonnet-4-6
  :opus            -> anthropic/claude-opus-4-6
  :haiku           -> anthropic/claude-haiku-4-5-20251001
  :gpt-5           -> openai/gpt-5
  :gpt-4o          -> openai/gpt-4o
  :o3              -> openai/o3
  :codex           -> openai/gpt-5.3-codex
  :gemini-pro      -> google/gemini-2.5-pro
  :gemini-flash    -> google/gemini-2.5-flash
  :groq            -> groq/llama-4-scout-17b-16e-instruct
  :grok            -> xai/grok-3
            """,
        )

        prompt_group = parser.add_mutually_exclusive_group(required=False)
        prompt_group.add_argument("-p", "--prompt", type=str, help="Prompt text to send to Pi")
        prompt_group.add_argument("-pp", "--prompt-file", type=str, help="Path to file containing the prompt")

        parser.add_argument(
            "--cd",
            type=str,
            default=os.environ.get("PI_PROJECT_PATH", os.getcwd()),
            help="Project path (absolute). Default: current directory (env: PI_PROJECT_PATH)",
        )

        parser.add_argument(
            "-m",
            "--model",
            type=str,
            default=os.environ.get("PI_MODEL", self.DEFAULT_MODEL),
            help=(
                "Model name. Supports shorthands (:pi, :sonnet, :opus, :gpt-5, :gemini-pro, etc.) "
                f"or provider/model format. Default: {self.DEFAULT_MODEL} (env: PI_MODEL)"
            ),
        )

        parser.add_argument(
            "--provider",
            type=str,
            default=os.environ.get("PI_PROVIDER", ""),
            help="LLM provider (anthropic, openai, google, etc.). Overrides provider in model string. (env: PI_PROVIDER)",
        )

        parser.add_argument(
            "--thinking",
            type=str,
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
            default=os.environ.get("PI_THINKING", None),
            help="Thinking level (off/minimal/low/medium/high/xhigh). (env: PI_THINKING)",
        )

        parser.add_argument(
            "--tools",
            type=str,
            default=os.environ.get("PI_TOOLS", None),
            help="Comma-separated tool list (read,bash,edit,write,grep,find,ls). (env: PI_TOOLS)",
        )

        parser.add_argument(
            "--no-tools",
            action="store_true",
            help="Disable all built-in Pi tools.",
        )

        parser.add_argument(
            "--system-prompt",
            type=str,
            default=os.environ.get("PI_SYSTEM_PROMPT", None),
            help="Replace Pi's system prompt with custom text. (env: PI_SYSTEM_PROMPT)",
        )

        parser.add_argument(
            "--append-system-prompt",
            type=str,
            default=os.environ.get("PI_APPEND_SYSTEM_PROMPT", None),
            help="Append to Pi's default system prompt. (env: PI_APPEND_SYSTEM_PROMPT)",
        )

        parser.add_argument(
            "--no-extensions",
            action="store_true",
            help="Disable Pi extensions.",
        )

        parser.add_argument(
            "--no-skills",
            action="store_true",
            help="Disable Pi skills.",
        )

        parser.add_argument(
            "--no-session",
            action="store_true",
            default=os.environ.get("PI_NO_SESSION", "false").lower() == "true",
            help="Disable session persistence (ephemeral mode). (env: PI_NO_SESSION)",
        )

        parser.add_argument(
            "--resume",
            type=str,
            default=None,
            help="Resume a previous session by session ID. Passed to Pi CLI as --session <id>.",
        )

        parser.add_argument(
            "--auto-instruction",
            type=str,
            default=os.environ.get("PI_AUTO_INSTRUCTION", ""),
            help="Instruction text prepended to the prompt. (env: PI_AUTO_INSTRUCTION)",
        )

        parser.add_argument(
            "--additional-args",
            type=str,
            default="",
            help="Space-separated additional pi CLI arguments to append.",
        )

        parser.add_argument(
            "--pretty",
            type=str,
            default=os.environ.get("PI_PRETTY", "true"),
            help="Pretty-print JSON output (true/false). Default: true (env: PI_PRETTY)",
        )

        parser.add_argument(
            "--verbose",
            action="store_true",
            default=os.environ.get("PI_VERBOSE", "false").lower() == "true",
            help="Verbose mode: print command before execution and enable live stream output with real-time text streaming. (env: PI_VERBOSE)",
        )

        return parser.parse_args()

    def read_prompt_file(self, file_path: str) -> str:
        """Read prompt content from a file."""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except FileNotFoundError:
            print(f"Error: Prompt file not found: {file_path}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error reading prompt file: {e}", file=sys.stderr)
            sys.exit(1)

    def build_pi_command(self, args: argparse.Namespace) -> Tuple[List[str], Optional[str]]:
        """Construct the Pi CLI command for headless JSON streaming execution.

        Returns (cmd, stdin_prompt): cmd is the argument list, stdin_prompt is
        the prompt text to pipe via stdin (or None to pass as positional arg).
        For multiline or large prompts we pipe via stdin so Pi reads it
        naturally without command-line quoting issues.
        """
        cmd = ["pi", "--mode", "json"]

        # Model: if provider/model format, split and pass separately
        model = self.model_name
        provider = args.provider.strip() if args.provider else ""

        if "/" in model and not provider:
            # Split provider/model-id format
            parts = model.split("/", 1)
            provider = parts[0]
            model = parts[1]

        if provider:
            cmd.extend(["--provider", provider])

        cmd.extend(["--model", model])

        # Thinking level
        if args.thinking:
            cmd.extend(["--thinking", args.thinking])

        # Tool control
        if args.no_tools:
            cmd.append("--no-tools")
        elif args.tools:
            cmd.extend(["--tools", args.tools])

        # System prompt
        if args.system_prompt:
            cmd.extend(["--system-prompt", args.system_prompt])
        elif args.append_system_prompt:
            cmd.extend(["--append-system-prompt", args.append_system_prompt])

        # Extension/skill control
        if args.no_extensions:
            cmd.append("--no-extensions")
        if args.no_skills:
            cmd.append("--no-skills")

        # Session control
        if getattr(args, "resume", None):
            cmd.extend(["--session", args.resume])
        elif args.no_session:
            cmd.append("--no-session")

        # Build prompt with optional auto-instruction
        full_prompt = self.prompt
        if args.auto_instruction:
            full_prompt = f"{args.auto_instruction}\n\n{full_prompt}"

        # For multiline or large prompts, pipe via stdin to avoid command-line
        # argument issues. Pi CLI reads stdin when isTTY is false and
        # automatically prepends it to messages in print mode.
        # For simple single-line prompts, pass as positional arg + -p flag.
        stdin_prompt: Optional[str] = None
        if "\n" in full_prompt or len(full_prompt) > 4096:
            # Pipe via stdin — Pi auto-enables print mode when stdin has data
            stdin_prompt = full_prompt
        else:
            # Print mode for non-interactive execution + positional arg
            cmd.append("-p")
            cmd.append(full_prompt)

        # Additional raw arguments
        if args.additional_args:
            extra = args.additional_args.strip().split()
            if extra:
                cmd.extend(extra)

        return cmd, stdin_prompt

    # ── Codex prettifier helpers ──────────────────────────────────────────

    def _first_nonempty_str(self, *values) -> str:
        """Return the first non-empty string value."""
        for val in values:
            if isinstance(val, str) and val != "":
                return val
        return ""

    def _extract_content_text(self, payload: dict) -> str:
        """Join text-like fields from content arrays (item.* schema)."""
        content = payload.get("content") if isinstance(payload, dict) else None
        parts: List[str] = []
        if isinstance(content, list):
            for entry in content:
                if not isinstance(entry, dict):
                    continue
                text_val = (
                    entry.get("text")
                    or entry.get("message")
                    or entry.get("output_text")
                    or entry.get("input_text")
                )
                if isinstance(text_val, str) and text_val != "":
                    parts.append(text_val)
        return "\n".join(parts) if parts else ""

    def _extract_command_output_text(self, payload: dict) -> str:
        """Extract aggregated/command output from various item.* layouts."""
        if not isinstance(payload, dict):
            return ""
        result = payload.get("result") if isinstance(payload.get("result"), dict) else None
        content_text = self._extract_content_text(payload)
        return self._first_nonempty_str(
            payload.get("aggregated_output"),
            payload.get("output"),
            payload.get("formatted_output"),
            result.get("aggregated_output") if result else None,
            result.get("output") if result else None,
            result.get("formatted_output") if result else None,
            content_text,
        )

    def _extract_reasoning_text(self, payload: dict) -> str:
        """Extract reasoning text from legacy and item.* schemas."""
        if not isinstance(payload, dict):
            return ""
        reasoning_obj = payload.get("reasoning") if isinstance(payload.get("reasoning"), dict) else None
        result_obj = payload.get("result") if isinstance(payload.get("result"), dict) else None
        content_text = self._extract_content_text(payload)
        return self._first_nonempty_str(
            payload.get("text"),
            payload.get("reasoning_text"),
            reasoning_obj.get("text") if reasoning_obj else None,
            result_obj.get("text") if result_obj else None,
            content_text,
        )

    def _extract_message_text_codex(self, payload: dict) -> str:
        """Extract final/assistant message text from item.* schemas."""
        if not isinstance(payload, dict):
            return ""
        result_obj = payload.get("result") if isinstance(payload.get("result"), dict) else None
        content_text = self._extract_content_text(payload)
        return self._first_nonempty_str(
            payload.get("message"),
            payload.get("text"),
            payload.get("final"),
            result_obj.get("message") if result_obj else None,
            result_obj.get("text") if result_obj else None,
            content_text,
        )

    def _normalize_codex_event(self, obj_dict: dict):
        """Normalize legacy (msg-based) and new item.* schemas into a common tuple."""
        msg = obj_dict.get("msg") if isinstance(obj_dict.get("msg"), dict) else {}
        outer_type = (obj_dict.get("type") or "").strip()
        item = obj_dict.get("item") if isinstance(obj_dict.get("item"), dict) else None

        msg_type = (msg.get("type") or "").strip() if isinstance(msg, dict) else ""
        payload = msg if isinstance(msg, dict) else {}

        if not msg_type and item is not None:
            msg_type = (item.get("type") or "").strip() or outer_type
            payload = item
        elif not msg_type:
            msg_type = outer_type

        return msg_type, payload, outer_type

    def _normalize_item_id(self, payload: dict, outer_type: str) -> Optional[str]:
        """Prefer existing id on item.* payloads; otherwise synthesize sequential item_{n}."""
        item_id = payload.get("id") if isinstance(payload, dict) else None
        if isinstance(item_id, str) and item_id.strip():
            parsed = self._parse_item_number(item_id)
            if parsed is not None and parsed + 1 > self._item_counter:
                self._item_counter = parsed + 1
            return item_id.strip()

        if isinstance(outer_type, str) and outer_type.startswith("item."):
            generated = f"item_{self._item_counter}"
            self._item_counter += 1
            return generated

        return None

    def _parse_item_number(self, item_id: str) -> Optional[int]:
        """Return numeric component from item_{n} ids or None if unparseable."""
        if not isinstance(item_id, str):
            return None
        item_id = item_id.strip()
        if not item_id.startswith("item_"):
            return None
        try:
            return int(item_id.split("item_", 1)[1])
        except Exception:
            return None

    def _strip_thinking_signature(self, content_list: list) -> list:
        """Remove thinkingSignature, textSignature, and encrypted_content from content items."""
        if not isinstance(content_list, list):
            return content_list
        for item in content_list:
            if isinstance(item, dict):
                item.pop("thinkingSignature", None)
                item.pop("textSignature", None)
                item.pop("encrypted_content", None)
        return content_list

    def _sanitize_codex_event(self, obj: dict, strip_metadata: bool = True) -> dict:
        """Deep-sanitize a Codex event: strip thinkingSignature and encrypted_content
        from any nested content arrays, and optionally remove metadata keys from
        nested message dicts.

        Handles Pi-wrapped events like message_update which nest messages under
        'partial', 'message', 'assistantMessageEvent', etc.
        """
        if not isinstance(obj, dict):
            return obj

        # Strip thinkingSignature from top-level content
        if isinstance(obj.get("content"), list):
            self._strip_thinking_signature(obj["content"])

        # Remove encrypted signatures and encrypted_content anywhere
        obj.pop("encrypted_content", None)
        obj.pop("textSignature", None)

        # Remove metadata keys from this level
        if strip_metadata:
            for mk in self._codex_metadata_keys:
                obj.pop(mk, None)

        # Recurse into known nested message containers
        for nested_key in ("partial", "message", "assistantMessageEvent"):
            nested = obj.get(nested_key)
            if isinstance(nested, dict):
                self._sanitize_codex_event(nested, strip_metadata)

        # Recurse into content arrays to strip encrypted_content from items
        content = obj.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    item.pop("encrypted_content", None)
                    item.pop("thinkingSignature", None)
                    # If thinkingSignature was a string containing encrypted_content, it's already removed
                    # Also recurse deeper if needed
                    self._sanitize_codex_event(item, strip_metadata=False)

        return obj

    def _truncate_tool_result_text(self, text: str) -> str:
        """Truncate tool result text to max lines, rendering newlines properly."""
        if not isinstance(text, str):
            return text
        # Unescape JSON-escaped newlines for human-readable display
        display_text = text.replace("\\n", "\n").replace("\\t", "\t")
        lines = display_text.split("\n")
        max_lines = self._codex_tool_result_max_lines
        if len(lines) <= max_lines:
            return display_text
        shown = "\n".join(lines[:max_lines])
        remaining_text = "\n".join(lines[max_lines:])
        remaining_chars = len(remaining_text)
        return f"{shown}\n[{remaining_chars} characters remaining]"

    def _is_codex_final_message(self, parsed: dict) -> bool:
        """Detect if this is the final assistant message (contains type=text content or stopReason=stop)."""
        if not isinstance(parsed, dict):
            return False
        if parsed.get("stopReason") == "stop":
            return True
        content = parsed.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    return True
        return False

    def _format_pi_codex_message(self, parsed: dict) -> Optional[str]:
        """Format a Pi-wrapped Codex message (role-based with content arrays).

        Handles:
        - Stripping thinkingSignature from thinking content
        - Truncating toolResult text to configured max lines
        - Hiding metadata keys from intermediate assistant messages
        """
        if not isinstance(parsed, dict):
            return None

        role = parsed.get("role", "")
        now = datetime.now().strftime("%I:%M:%S %p")
        self.message_counter += 1

        # --- toolResult role: truncate text content ---
        if role == "toolResult":
            header: Dict = {
                "type": "toolResult",
                "datetime": now,
                "counter": f"#{self.message_counter}",
                "toolName": parsed.get("toolName", ""),
            }
            is_error = parsed.get("isError", False)
            if is_error:
                header["isError"] = True

            content = parsed.get("content")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text_val = item.get("text", "")
                        truncated = self._truncate_tool_result_text(text_val)
                        if "\n" in truncated:
                            return json.dumps(header, ensure_ascii=False) + "\ncontent:\n" + truncated
                        header["content"] = truncated
                        return json.dumps(header, ensure_ascii=False)

            return json.dumps(header, ensure_ascii=False)

        # --- assistant role: strip thinkingSignature and manage metadata ---
        if role == "assistant":
            content = parsed.get("content")
            if isinstance(content, list):
                self._strip_thinking_signature(content)

            is_final = self._is_codex_final_message(parsed)
            is_first = not self._codex_first_assistant_seen
            self._codex_first_assistant_seen = True

            show_metadata = is_first or is_final

            # Build display object
            display: Dict = {}
            for key, value in parsed.items():
                if not show_metadata and key in self._codex_metadata_keys:
                    continue
                display[key] = value

            # Add datetime and counter
            display["datetime"] = now
            display["counter"] = f"#{self.message_counter}"

            # Extract main content for pretty display
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, dict):
                        if item.get("type") == "thinking":
                            thinking_text = item.get("thinking", "")
                            if thinking_text:
                                parts.append(f"[thinking] {thinking_text}")
                        elif item.get("type") == "toolCall":
                            name = item.get("name", "")
                            args = item.get("arguments", {})
                            if isinstance(args, dict):
                                cmd = args.get("command", "")
                                if cmd:
                                    parts.append(f"[toolCall] {name}: {cmd}")
                                else:
                                    args_str = json.dumps(args, ensure_ascii=False)
                                    if len(args_str) > 200:
                                        args_str = args_str[:200] + "..."
                                    parts.append(f"[toolCall] {name}: {args_str}")
                            else:
                                parts.append(f"[toolCall] {name}")
                        elif item.get("type") == "text":
                            text_val = item.get("text", "")
                            if text_val:
                                parts.append(text_val)

                if parts:
                    combined = "\n".join(parts)
                    header_obj: Dict = {"type": "assistant", "datetime": now, "counter": f"#{self.message_counter}"}
                    if show_metadata:
                        for mk in ("api", "provider", "model", "stopReason"):
                            if mk in parsed:
                                header_obj[mk] = parsed[mk]
                        if "usage" in parsed and is_final:
                            header_obj["usage"] = parsed["usage"]
                    if "\n" in combined:
                        return json.dumps(header_obj, ensure_ascii=False) + "\ncontent:\n" + combined
                    header_obj["content"] = combined
                    return json.dumps(header_obj, ensure_ascii=False)

            # Fallback: dump the filtered display object
            return json.dumps(display, ensure_ascii=False)

        return None

    # Event subtypes to suppress in message_update (streaming deltas are noisy)
    _CODEX_HIDDEN_MESSAGE_UPDATE_SUBTYPES = {
        "text_delta", "text_start",
        "thinking_delta", "thinking_start",
        "toolcall_delta", "toolcall_start",
    }

    def _format_pi_codex_event(self, parsed: dict) -> Optional[str]:
        """Format Pi-wrapped events when in Codex prettifier mode.

        Handles Pi event types (message_update, turn_end, message_start, etc.)
        that wrap Codex-style content. Returns formatted string, empty string
        to suppress, or None if this method doesn't handle the event type.
        """
        event_type = parsed.get("type", "")
        if not event_type:
            return None

        now = datetime.now().strftime("%I:%M:%S %p")

        # --- message_update: filter by assistantMessageEvent subtype ---
        if event_type == "message_update":
            ame = parsed.get("assistantMessageEvent", {})
            if isinstance(ame, dict):
                ame_type = ame.get("type", "")

                # Suppress noisy streaming delta/start events
                if ame_type in self._CODEX_HIDDEN_MESSAGE_UPDATE_SUBTYPES:
                    return ""  # suppress

                # text_end: show the complete text content
                if ame_type == "text_end":
                    self.message_counter += 1
                    content_text = ame.get("content", "")
                    header: Dict = {
                        "type": "text_end",
                        "datetime": now,
                        "counter": f"#{self.message_counter}",
                    }
                    if isinstance(content_text, str) and content_text.strip():
                        if "\n" in content_text:
                            return json.dumps(header, ensure_ascii=False) + "\ncontent:\n" + content_text
                        header["content"] = content_text
                    return json.dumps(header, ensure_ascii=False)

                # thinking_end: show the final thinking summary
                if ame_type == "thinking_end":
                    self.message_counter += 1
                    thinking_text = ame.get("content", "")
                    header = {
                        "type": "thinking_end",
                        "datetime": now,
                        "counter": f"#{self.message_counter}",
                    }
                    if isinstance(thinking_text, str) and thinking_text.strip():
                        header["thinking"] = thinking_text
                    return json.dumps(header, ensure_ascii=False)

                # toolcall_end: show tool name and arguments
                if ame_type == "toolcall_end":
                    self.message_counter += 1
                    tool_call = ame.get("toolCall", {})
                    header = {
                        "type": "toolcall_end",
                        "datetime": now,
                        "counter": f"#{self.message_counter}",
                    }
                    if isinstance(tool_call, dict):
                        header["tool"] = tool_call.get("name", "")
                        args = tool_call.get("arguments", {})
                        if isinstance(args, dict):
                            cmd = args.get("command", "")
                            if cmd:
                                header["command"] = cmd
                            else:
                                args_str = json.dumps(args, ensure_ascii=False)
                                if len(args_str) > 200:
                                    args_str = args_str[:200] + "..."
                                header["args"] = args_str if isinstance(args_str, str) else args
                    return json.dumps(header, ensure_ascii=False)

            # Other message_update subtypes: suppress by default
            return ""

        # --- turn_end: metadata only (text already shown by text_end/thinking_end/toolcall_end) ---
        if event_type == "turn_end":
            self.message_counter += 1
            header = {
                "type": "turn_end",
                "datetime": now,
                "counter": f"#{self.message_counter}",
            }
            tool_results = parsed.get("toolResults")
            if isinstance(tool_results, list):
                header["tool_results_count"] = len(tool_results)
            return json.dumps(header, ensure_ascii=False)

        # --- message_start: minimal header (no counter — only *_end events get counters) ---
        if event_type == "message_start":
            message = parsed.get("message", {})
            header = {
                "type": "message_start",
                "datetime": now,
            }
            if isinstance(message, dict):
                role = message.get("role")
                if role:
                    header["role"] = role
            return json.dumps(header, ensure_ascii=False)

        # --- message_end: metadata only (text already shown by text_end/thinking_end/toolcall_end) ---
        if event_type == "message_end":
            self.message_counter += 1
            header = {
                "type": "message_end",
                "datetime": now,
                "counter": f"#{self.message_counter}",
            }
            return json.dumps(header, ensure_ascii=False)

        # --- tool_execution_start (no counter — only *_end events get counters) ---
        if event_type == "tool_execution_start":
            header = {
                "type": "tool_execution_start",
                "datetime": now,
                "tool": parsed.get("toolName", ""),
            }
            args_val = parsed.get("args")
            if isinstance(args_val, dict):
                args_str = json.dumps(args_val, ensure_ascii=False)
                if len(args_str) > 200:
                    header["args"] = args_str[:200] + "..."
                else:
                    header["args"] = args_val
            return json.dumps(header, ensure_ascii=False)

        # --- tool_execution_end ---
        if event_type == "tool_execution_end":
            self.message_counter += 1
            header = {
                "type": "tool_execution_end",
                "datetime": now,
                "counter": f"#{self.message_counter}",
                "tool": parsed.get("toolName", ""),
            }
            is_error = parsed.get("isError", False)
            if is_error:
                header["isError"] = True
            result_val = parsed.get("result")
            if isinstance(result_val, dict):
                # Extract text content from result
                result_content = result_val.get("content")
                if isinstance(result_content, list):
                    for rc_item in result_content:
                        if isinstance(rc_item, dict) and rc_item.get("type") == "text":
                            text = rc_item.get("text", "")
                            truncated = self._truncate_tool_result_text(text)
                            if "\n" in truncated:
                                return json.dumps(header, ensure_ascii=False) + "\nresult:\n" + truncated
                            header["result"] = truncated
                            return json.dumps(header, ensure_ascii=False)
            return json.dumps(header, ensure_ascii=False)

        # --- turn_start: suppress (no user-visible value) ---
        if event_type == "turn_start":
            return ""

        # --- agent_start: simple header (no counter — only *_end events get counters) ---
        if event_type == "agent_start":
            return json.dumps({
                "type": event_type,
                "datetime": now,
            }, ensure_ascii=False)

        # --- agent_end: capture and show summary ---
        if event_type == "agent_end":
            self.message_counter += 1
            header = {
                "type": "agent_end",
                "datetime": now,
                "counter": f"#{self.message_counter}",
            }
            messages = parsed.get("messages")
            if isinstance(messages, list):
                header["message_count"] = len(messages)
            return json.dumps(header, ensure_ascii=False)

        # Not a Pi-wrapped event type we handle
        return None

    def _format_event_pretty_codex(self, payload: dict) -> Optional[str]:
        """Format a Codex-schema JSON event for human-readable output."""
        try:
            msg_type, msg_payload, outer_type = self._normalize_codex_event(payload)
            item_id = self._normalize_item_id(msg_payload, outer_type)

            now = datetime.now().strftime("%I:%M:%S %p")
            self.message_counter += 1
            header_type = (outer_type or msg_type).strip()
            base_type = header_type or msg_type or "message"

            def make_header(type_value: str):
                hdr: Dict = {"type": type_value, "datetime": now, "counter": f"#{self.message_counter}"}
                if item_id:
                    hdr["id"] = item_id
                if outer_type and msg_type and outer_type != msg_type:
                    hdr["item_type"] = msg_type
                return hdr

            header = make_header(base_type)

            if isinstance(msg_payload, dict):
                if item_id and "id" not in msg_payload:
                    msg_payload["id"] = item_id
                if msg_payload.get("command"):
                    header["command"] = msg_payload.get("command")
                if msg_payload.get("status"):
                    header["status"] = msg_payload.get("status")
                if msg_payload.get("state") and not header.get("status"):
                    header["status"] = msg_payload.get("state")

            # agent_reasoning
            if msg_type in {"agent_reasoning", "reasoning"}:
                content = self._extract_reasoning_text(msg_payload)
                header = make_header(header_type or msg_type)
                if "\n" in content:
                    return json.dumps(header, ensure_ascii=False) + "\ntext:\n" + content
                header["text"] = content
                return json.dumps(header, ensure_ascii=False)

            # agent_message / assistant
            if msg_type in {"agent_message", "message", "assistant_message", "assistant"}:
                content = self._extract_message_text_codex(msg_payload)
                header = make_header(header_type or msg_type)
                if "\n" in content:
                    return json.dumps(header, ensure_ascii=False) + "\nmessage:\n" + content
                if content != "":
                    header["message"] = content
                    return json.dumps(header, ensure_ascii=False)
                if header_type:
                    return json.dumps(header, ensure_ascii=False)

            # exec_command_end
            if msg_type == "exec_command_end":
                formatted_output = msg_payload.get("formatted_output", "") if isinstance(msg_payload, dict) else ""
                header = {"type": msg_type, "datetime": now}
                if "\n" in formatted_output:
                    return json.dumps(header, ensure_ascii=False) + "\nformatted_output:\n" + formatted_output
                header["formatted_output"] = formatted_output
                return json.dumps(header, ensure_ascii=False)

            # command_execution
            if msg_type == "command_execution":
                aggregated_output = self._extract_command_output_text(msg_payload)
                if "\n" in aggregated_output:
                    return json.dumps(header, ensure_ascii=False) + "\naggregated_output:\n" + aggregated_output
                if aggregated_output:
                    header["aggregated_output"] = aggregated_output
                    return json.dumps(header, ensure_ascii=False)
                if header_type:
                    return json.dumps(header, ensure_ascii=False)

            return None
        except Exception:
            return None

    # ── Claude prettifier ─────────────────────────────────────────────────

    def _format_event_pretty_claude(self, json_line: str) -> Optional[str]:
        """Format a Claude-schema JSON event for human-readable output."""
        try:
            data = json.loads(json_line) if isinstance(json_line, str) else json_line
            self.message_counter += 1
            now = datetime.now().strftime("%I:%M:%S %p")

            if data.get("type") == "user":
                message = data.get("message", {})
                content_list = message.get("content", [])
                text_content = ""
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text_content = item.get("text", "")
                        break

                if self.user_message_truncate != -1:
                    lines = text_content.split('\n')
                    if len(lines) > self.user_message_truncate:
                        text_content = '\n'.join(lines[:self.user_message_truncate]) + '\n[Truncated...]'

                metadata: Dict = {"type": "user", "datetime": now, "counter": f"#{self.message_counter}"}
                if '\n' in text_content:
                    return json.dumps(metadata, ensure_ascii=False) + "\ncontent:\n" + text_content
                metadata["content"] = text_content
                return json.dumps(metadata, ensure_ascii=False)

            elif data.get("type") == "progress":
                progress_data = data.get("data", {})
                progress_type = progress_data.get("type", "")

                if progress_type == "hook_progress":
                    return None

                if progress_type == "bash_progress":
                    output_text = progress_data.get("output", "")
                    elapsed_time = progress_data.get("elapsedTimeSeconds", 0)
                    total_lines = progress_data.get("totalLines", 0)
                    simplified: Dict = {
                        "type": "progress", "progress_type": "bash_progress",
                        "datetime": now, "counter": f"#{self.message_counter}",
                        "elapsed": f"{elapsed_time}s", "lines": total_lines,
                    }
                    if '\n' in output_text:
                        return json.dumps(simplified, ensure_ascii=False) + "\n[Progress] output:\n" + output_text
                    simplified["output"] = output_text
                    return f"[Progress] {json.dumps(simplified, ensure_ascii=False)}"

                return json.dumps({
                    "type": "progress", "progress_type": progress_type,
                    "datetime": now, "counter": f"#{self.message_counter}",
                    "data": progress_data,
                }, ensure_ascii=False)

            elif data.get("type") == "assistant":
                message = data.get("message", {})
                content_list = message.get("content", [])
                text_content = ""
                tool_use_data = None

                for item in content_list:
                    if isinstance(item, dict):
                        if item.get("type") == "text":
                            text_content = item.get("text", "")
                            break
                        elif item.get("type") == "tool_use":
                            tool_use_data = {"name": item.get("name", ""), "input": item.get("input", {})}
                            break

                metadata = {"type": "assistant", "datetime": now, "counter": f"#{self.message_counter}"}

                if tool_use_data:
                    tool_input = tool_use_data.get("input", {})
                    prompt_field = tool_input.get("prompt", "")
                    if isinstance(prompt_field, str) and '\n' in prompt_field:
                        tool_use_copy = {
                            "name": tool_use_data.get("name", ""),
                            "input": {k: v for k, v in tool_input.items() if k != "prompt"},
                        }
                        metadata["tool_use"] = tool_use_copy
                        return json.dumps(metadata, ensure_ascii=False) + "\nprompt:\n" + prompt_field
                    metadata["tool_use"] = tool_use_data
                    return json.dumps(metadata, ensure_ascii=False)
                else:
                    if '\n' in text_content:
                        return json.dumps(metadata, ensure_ascii=False) + "\ncontent:\n" + text_content
                    metadata["content"] = text_content
                    return json.dumps(metadata, ensure_ascii=False)

            else:
                message = data.get("message", {})
                content_list = message.get("content", [])
                if content_list and isinstance(content_list, list) and len(content_list) > 0:
                    nested_item = content_list[0]
                    if isinstance(nested_item, dict) and nested_item.get("type") in ["tool_result"]:
                        flattened: Dict = {"datetime": now, "counter": f"#{self.message_counter}"}
                        if "tool_use_id" in nested_item:
                            flattened["tool_use_id"] = nested_item["tool_use_id"]
                        flattened["type"] = nested_item["type"]
                        nested_content = nested_item.get("content", "")
                        if isinstance(nested_content, str) and '\n' in nested_content:
                            return json.dumps(flattened, ensure_ascii=False) + "\ncontent:\n" + nested_content
                        flattened["content"] = nested_content
                        return json.dumps(flattened, ensure_ascii=False)

                output: Dict = {"datetime": now, "counter": f"#{self.message_counter}", **data}
                if "result" in output and isinstance(output["result"], str) and '\n' in output["result"]:
                    result_value = output.pop("result")
                    return json.dumps(output, ensure_ascii=False) + "\nresult:\n" + result_value
                return json.dumps(output, ensure_ascii=False)

        except json.JSONDecodeError:
            return json_line if isinstance(json_line, str) else None
        except Exception:
            return json_line if isinstance(json_line, str) else None

    # ── Pi prettifier helpers ─────────────────────────────────────────────

    def _extract_text_from_message(self, message: dict) -> str:
        """Extract human-readable text from a Pi message object."""
        if not isinstance(message, dict):
            return ""

        # Direct text/content fields
        for field in ("text", "content", "message", "response", "output"):
            val = message.get(field)
            if isinstance(val, str) and val.strip():
                return val

        # content array (Claude-style)
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text") or item.get("content")
                    if isinstance(text, str) and text.strip():
                        parts.append(text)
                elif isinstance(item, str) and item.strip():
                    parts.append(item)
            if parts:
                return "\n".join(parts)

        return ""

    def _format_event_pretty(self, payload: dict) -> Optional[str]:
        """
        Format a Pi JSON streaming event for human-readable output.
        Returns formatted string or None to skip the event.
        """
        try:
            event_type = payload.get("type", "")
            now = datetime.now().strftime("%I:%M:%S %p")

            # Counter is only added to *_end events (below, per-branch)
            header: Dict = {
                "type": event_type,
                "datetime": now,
            }

            # --- Session header (no counter) ---
            if event_type == "session":
                header["version"] = payload.get("version")
                header["id"] = payload.get("id")
                return json.dumps(header, ensure_ascii=False)

            # --- turn_start: suppress (no user-visible value) ---
            if event_type == "turn_start":
                return None

            # --- agent_start: simple header (no counter) ---
            if event_type == "agent_start":
                return json.dumps(header, ensure_ascii=False)

            if event_type == "agent_end":
                self.message_counter += 1
                header["counter"] = f"#{self.message_counter}"
                messages = payload.get("messages")
                if isinstance(messages, list):
                    header["message_count"] = len(messages)
                return json.dumps(header, ensure_ascii=False)

            if event_type == "turn_end":
                self.message_counter += 1
                header["counter"] = f"#{self.message_counter}"
                tool_results = payload.get("toolResults")
                if isinstance(tool_results, list):
                    header["tool_results_count"] = len(tool_results)
                # Skip message text - already displayed by text_end/thinking_end/toolcall_end
                return json.dumps(header, ensure_ascii=False)

            # --- Message events (assistant streaming) ---
            if event_type == "message_start":
                message = payload.get("message", {})
                role = message.get("role") if isinstance(message, dict) else None
                if role:
                    header["role"] = role
                return json.dumps(header, ensure_ascii=False)

            if event_type == "message_update":
                # Check for noisy streaming sub-events and suppress them
                ame = payload.get("assistantMessageEvent", {})
                ame_type = ame.get("type", "") if isinstance(ame, dict) else ""
                event_subtype = payload.get("event", ame_type)
                if event_subtype in self._PI_HIDDEN_MESSAGE_UPDATE_EVENTS:
                    return None  # Suppress noisy streaming deltas

                # toolcall_end: show tool name and arguments (*_end → gets counter)
                if isinstance(ame, dict) and ame_type == "toolcall_end":
                    self.message_counter += 1
                    header["counter"] = f"#{self.message_counter}"
                    header["event"] = ame_type
                    tool_call = ame.get("toolCall", {})
                    if isinstance(tool_call, dict):
                        header["tool"] = tool_call.get("name", "")
                        args = tool_call.get("arguments", {})
                        if isinstance(args, dict):
                            cmd = args.get("command", "")
                            if cmd:
                                header["command"] = cmd
                            else:
                                args_str = json.dumps(args, ensure_ascii=False)
                                if len(args_str) > 200:
                                    args_str = args_str[:200] + "..."
                                header["args"] = args_str
                        elif isinstance(args, str) and args.strip():
                            header["args"] = args[:200] + "..." if len(args) > 200 else args
                    return json.dumps(header, ensure_ascii=False)

                # thinking_end: show thinking content (*_end → gets counter)
                if isinstance(ame, dict) and ame_type == "thinking_end":
                    self.message_counter += 1
                    header["counter"] = f"#{self.message_counter}"
                    header["event"] = ame_type
                    thinking_text = ame.get("thinking", "") or ame.get("content", "") or ame.get("text", "")
                    if isinstance(thinking_text, str) and thinking_text.strip():
                        header["thinking"] = thinking_text
                    return json.dumps(header, ensure_ascii=False)

                # Any other *_end subtypes (e.g. text_end) get counter
                if isinstance(ame, dict) and ame_type and ame_type.endswith("_end"):
                    self.message_counter += 1
                    header["counter"] = f"#{self.message_counter}"

                message = payload.get("message", {})
                text = self._extract_text_from_message(message) if isinstance(message, dict) else ""

                # Also check assistantMessageEvent for completion text
                if isinstance(ame, dict):
                    if ame_type:
                        header["event"] = ame_type
                    delta_text = ame.get("text") or ame.get("delta") or ""
                    if isinstance(delta_text, str) and delta_text.strip():
                        if not text:
                            text = delta_text

                if text and "\n" in text:
                    return json.dumps(header, ensure_ascii=False) + "\ncontent:\n" + text
                elif text:
                    header["content"] = text
                return json.dumps(header, ensure_ascii=False)

            if event_type == "message_end":
                self.message_counter += 1
                header["counter"] = f"#{self.message_counter}"
                # Skip message text - already displayed by text_end/thinking_end/toolcall_end
                return json.dumps(header, ensure_ascii=False)

            # --- Tool execution events (start/update: no counter, end: gets counter) ---
            if event_type == "tool_execution_start":
                header["tool"] = payload.get("toolName", "")
                tool_call_id = payload.get("toolCallId")
                if tool_call_id:
                    header["id"] = tool_call_id
                args_val = payload.get("args")
                if isinstance(args_val, dict):
                    # Show abbreviated args inline
                    args_str = json.dumps(args_val, ensure_ascii=False)
                    if len(args_str) > 200:
                        # Truncate for readability
                        header["args"] = args_str[:200] + "..."
                    else:
                        header["args"] = args_val
                elif isinstance(args_val, str) and args_val.strip():
                    if "\n" in args_val:
                        return json.dumps(header, ensure_ascii=False) + "\nargs:\n" + args_val
                    header["args"] = args_val
                return json.dumps(header, ensure_ascii=False)

            if event_type == "tool_execution_update":
                header["tool"] = payload.get("toolName", "")
                tool_call_id = payload.get("toolCallId")
                if tool_call_id:
                    header["id"] = tool_call_id
                partial = payload.get("partialResult")
                if isinstance(partial, str) and partial.strip():
                    if "\n" in partial:
                        return json.dumps(header, ensure_ascii=False) + "\npartialResult:\n" + partial
                    header["partialResult"] = partial
                return json.dumps(header, ensure_ascii=False)

            if event_type == "tool_execution_end":
                self.message_counter += 1
                header["counter"] = f"#{self.message_counter}"
                header["tool"] = payload.get("toolName", "")
                tool_call_id = payload.get("toolCallId")
                if tool_call_id:
                    header["id"] = tool_call_id
                is_error = payload.get("isError", False)
                if is_error:
                    header["isError"] = True
                result_val = payload.get("result")
                if isinstance(result_val, str) and result_val.strip():
                    if "\n" in result_val:
                        return json.dumps(header, ensure_ascii=False) + "\nresult:\n" + result_val
                    header["result"] = result_val
                elif isinstance(result_val, (dict, list)):
                    result_str = json.dumps(result_val, ensure_ascii=False)
                    if "\n" in result_str or len(result_str) > 200:
                        return json.dumps(header, ensure_ascii=False) + "\nresult:\n" + result_str
                    header["result"] = result_val
                return json.dumps(header, ensure_ascii=False)

            # --- Retry/compaction events ---
            if event_type == "auto_retry_start":
                header["attempt"] = payload.get("attempt")
                header["maxAttempts"] = payload.get("maxAttempts")
                header["delayMs"] = payload.get("delayMs")
                error_msg = payload.get("errorMessage", "")
                if error_msg:
                    header["error"] = error_msg
                return json.dumps(header, ensure_ascii=False)

            if event_type == "auto_retry_end":
                self.message_counter += 1
                header["counter"] = f"#{self.message_counter}"
                header["success"] = payload.get("success")
                header["attempt"] = payload.get("attempt")
                final_err = payload.get("finalError")
                if final_err:
                    header["finalError"] = final_err
                return json.dumps(header, ensure_ascii=False)

            # --- Fallback: emit raw with datetime ---
            header.update({k: v for k, v in payload.items() if k not in ("type",)})
            return json.dumps(header, ensure_ascii=False)

        except Exception:
            return json.dumps(payload, ensure_ascii=False)

    # ── Live stream prettifier ─────────────────────────────────────────────

    def _format_event_live(self, parsed: dict) -> Optional[str]:
        """Format Pi events for live streaming mode.

        Returns:
            str ending with \\n: a complete line to print
            str NOT ending with \\n: a delta to append (streaming text)
            "": suppress this event
            None: use raw JSON fallback
        """
        event_type = parsed.get("type", "")
        now = datetime.now().strftime("%I:%M:%S %p")

        if event_type == "message_update":
            ame = parsed.get("assistantMessageEvent", {})
            ame_type = ame.get("type", "") if isinstance(ame, dict) else ""

            # Stream text deltas directly (no JSON, no newline)
            if ame_type == "text_delta":
                delta = ame.get("delta", "")
                if isinstance(delta, str) and delta:
                    return delta  # raw text, no newline
                return ""

            if ame_type == "thinking_delta":
                delta = ame.get("delta", "")
                if isinstance(delta, str) and delta:
                    return delta
                return ""

            # Section start markers (no counter — only *_end events get counters)
            if ame_type == "text_start":
                return json.dumps({"type": "text_start", "datetime": now}) + "\n"

            if ame_type == "thinking_start":
                return json.dumps({"type": "thinking_start", "datetime": now}) + "\n"

            # Section end markers (text was already streamed)
            if ame_type == "text_end":
                self.message_counter += 1
                return "\n" + json.dumps({"type": "text_end", "datetime": now, "counter": f"#{self.message_counter}"}) + "\n"

            if ame_type == "thinking_end":
                self.message_counter += 1
                return "\n" + json.dumps({"type": "thinking_end", "datetime": now, "counter": f"#{self.message_counter}"}) + "\n"

            # Tool call end: show tool info
            if ame_type == "toolcall_end":
                self.message_counter += 1
                tc = ame.get("toolCall", {})
                header = {"type": "toolcall_end", "datetime": now, "counter": f"#{self.message_counter}"}
                if isinstance(tc, dict):
                    header["tool"] = tc.get("name", "")
                    args = tc.get("arguments", {})
                    if isinstance(args, dict):
                        cmd = args.get("command", "")
                        if cmd:
                            header["command"] = cmd
                        else:
                            args_str = json.dumps(args, ensure_ascii=False)
                            header["args"] = args_str[:200] + "..." if len(args_str) > 200 else args
                return json.dumps(header, ensure_ascii=False) + "\n"

            # Suppress all other message_update subtypes (toolcall_start, toolcall_delta, etc.)
            return ""

        # Suppress redundant events
        if event_type in ("message_start", "message_end"):
            return ""

        # tool_execution_start (no counter — only *_end events get counters)
        if event_type == "tool_execution_start":
            header = {
                "type": "tool_execution_start",
                "datetime": now,
                "tool": parsed.get("toolName", ""),
            }
            args_val = parsed.get("args")
            if isinstance(args_val, dict):
                args_str = json.dumps(args_val, ensure_ascii=False)
                if len(args_str) > 200:
                    header["args"] = args_str[:200] + "..."
                else:
                    header["args"] = args_val
            return json.dumps(header, ensure_ascii=False) + "\n"

        # tool_execution_end
        if event_type == "tool_execution_end":
            self.message_counter += 1
            header = {
                "type": "tool_execution_end",
                "datetime": now,
                "counter": f"#{self.message_counter}",
                "tool": parsed.get("toolName", ""),
            }
            is_error = parsed.get("isError", False)
            if is_error:
                header["isError"] = True
            result_val = parsed.get("result")
            if isinstance(result_val, str) and result_val.strip():
                truncated = self._truncate_tool_result_text(result_val)
                if "\n" in truncated:
                    return json.dumps(header, ensure_ascii=False) + "\nresult:\n" + truncated + "\n"
                header["result"] = truncated
            elif isinstance(result_val, dict):
                result_content = result_val.get("content")
                if isinstance(result_content, list):
                    for rc_item in result_content:
                        if isinstance(rc_item, dict) and rc_item.get("type") == "text":
                            text = rc_item.get("text", "")
                            truncated = self._truncate_tool_result_text(text)
                            if "\n" in truncated:
                                return json.dumps(header, ensure_ascii=False) + "\nresult:\n" + truncated + "\n"
                            header["result"] = truncated
                            break
            return json.dumps(header, ensure_ascii=False) + "\n"

        # turn_end: metadata only
        if event_type == "turn_end":
            self.message_counter += 1
            header = {"type": "turn_end", "datetime": now, "counter": f"#{self.message_counter}"}
            tool_results = parsed.get("toolResults")
            if isinstance(tool_results, list):
                header["tool_results_count"] = len(tool_results)
            return json.dumps(header, ensure_ascii=False) + "\n"

        # turn_start: suppress (no user-visible value)
        if event_type == "turn_start":
            return ""

        # agent_start (no counter — only *_end events get counters)
        if event_type == "agent_start":
            return json.dumps({"type": event_type, "datetime": now}) + "\n"

        # agent_end
        if event_type == "agent_end":
            self.message_counter += 1
            header = {"type": "agent_end", "datetime": now, "counter": f"#{self.message_counter}"}
            messages = parsed.get("messages")
            if isinstance(messages, list):
                header["message_count"] = len(messages)
            return json.dumps(header, ensure_ascii=False) + "\n"

        # Fallback: not handled
        return None

    def _build_hide_types(self) -> set:
        """Build the set of event types to suppress from output."""
        hide_types = set(self.DEFAULT_HIDDEN_STREAM_TYPES)
        for env_name in ("PI_HIDE_STREAM_TYPES", "JUNO_CODE_HIDE_STREAM_TYPES"):
            env_val = os.environ.get(env_name, "")
            if env_val:
                parts = [p.strip() for p in env_val.split(",") if p.strip()]
                hide_types.update(parts)
        return hide_types

    @staticmethod
    def _sanitize_sub_agent_response(event: dict) -> dict:
        """Strip bulky fields (messages, type) from sub_agent_response to reduce token usage."""
        return {k: v for k, v in event.items() if k not in ("messages", "type")}

    def _write_capture_file(self, capture_path: Optional[str]) -> None:
        """Write final result event to capture file for shell backend."""
        if not capture_path or not self.last_result_event:
            return
        try:
            Path(capture_path).write_text(
                json.dumps(self.last_result_event, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as e:
            print(f"Warning: Could not write capture file: {e}", file=sys.stderr)

    def run_pi(self, cmd: List[str], args: argparse.Namespace,
               stdin_prompt: Optional[str] = None) -> int:
        """Execute the Pi CLI and stream/format its JSON output.

        Args:
            cmd: Command argument list from build_pi_command.
            args: Parsed argparse namespace.
            stdin_prompt: If set, pipe this text via stdin to the Pi CLI
                          (used for multiline/large prompts).
        """
        verbose = args.verbose
        pretty = args.pretty.lower() != "false"
        capture_path = os.environ.get("JUNO_SUBAGENT_CAPTURE_PATH")
        hide_types = self._build_hide_types()

        if verbose:
            # Truncate prompt in display to avoid confusing multi-line output
            display_cmd = list(cmd)
            if stdin_prompt:
                first_line = stdin_prompt.split("\n")[0][:60]
                display_cmd.append(f'[stdin: "{first_line}..." ({len(stdin_prompt)} chars)]')
            else:
                filtered = []
                skip_next = False
                for i, part in enumerate(cmd):
                    if skip_next:
                        skip_next = False
                        continue
                    if part == "-p" and i + 1 < len(cmd):
                        prompt_val = cmd[i + 1]
                        if len(prompt_val) > 80 or "\n" in prompt_val:
                            first_line = prompt_val.split("\n")[0][:60]
                            filtered.append(f'-p "{first_line}..." ({len(prompt_val)} chars)')
                        else:
                            filtered.append(f"-p {prompt_val}")
                        skip_next = True
                    else:
                        filtered.append(part)
                display_cmd = filtered
            # Only show Executing once: skip when running under juno-code shell backend
            # (shell backend already logs the command in debug mode)
            if not capture_path:
                print(f"Executing: {' '.join(display_cmd)}", file=sys.stderr)
                print("-" * 80, file=sys.stderr)

        try:
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE if stdin_prompt else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True,
                cwd=self.project_path,
            )

            # Pipe the prompt via stdin if using stdin mode (multiline/large prompts).
            # Pi CLI reads stdin when isTTY is false and prepends it to messages.
            if stdin_prompt and process.stdin:
                try:
                    process.stdin.write(stdin_prompt)
                    process.stdin.close()
                except BrokenPipeError:
                    pass  # Process may have exited early

            # Watchdog thread: handles stdout pipe blocking after process exit.
            wait_timeout = int(os.environ.get("PI_WAIT_TIMEOUT", "30"))
            output_done = threading.Event()

            def _stdout_watchdog():
                """Terminate process and close stdout pipe if it hangs after output."""
                while not output_done.is_set():
                    if process.poll() is not None:
                        break
                    output_done.wait(timeout=1)

                if output_done.is_set() and process.poll() is None:
                    try:
                        process.wait(timeout=wait_timeout)
                    except subprocess.TimeoutExpired:
                        print(
                            f"Warning: Pi process did not exit within {wait_timeout}s after output. Terminating.",
                            file=sys.stderr,
                        )
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            print("Warning: Pi process did not respond to SIGTERM. Killing.", file=sys.stderr)
                            process.kill()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                pass

                time.sleep(2)
                try:
                    if process.stdout and not process.stdout.closed:
                        process.stdout.close()
                except Exception:
                    pass

            watchdog = threading.Thread(target=_stdout_watchdog, daemon=True)
            watchdog.start()

            # Stream stderr in a separate thread so Pi diagnostic output is visible
            def _stderr_reader():
                """Read stderr and forward to our stderr for visibility."""
                try:
                    if process.stderr:
                        for stderr_line in process.stderr:
                            print(stderr_line, end="", file=sys.stderr, flush=True)
                except (ValueError, OSError):
                    pass

            stderr_thread = threading.Thread(target=_stderr_reader, daemon=True)
            stderr_thread.start()

            if process.stdout:
                try:
                    for raw_line in process.stdout:
                        line = raw_line.rstrip("\n\r")
                        if not line.strip():
                            continue

                        # Try to parse as JSON
                        try:
                            parsed = json.loads(line)
                        except json.JSONDecodeError:
                            # Non-JSON output — print as-is
                            print(line, flush=True)
                            continue

                        event_type = parsed.get("type", "")

                        # Capture session ID from the session event (sent at stream start)
                        if event_type == "session":
                            self.session_id = parsed.get("id")

                        # Capture result event for shell backend
                        if event_type == "agent_end":
                            # agent_end has a 'messages' array; extract final assistant text
                            messages = parsed.get("messages", [])
                            text = ""
                            if isinstance(messages, list):
                                # Walk messages in reverse to find last assistant message with text
                                for m in reversed(messages):
                                    if isinstance(m, dict) and m.get("role") == "assistant":
                                        text = self._extract_text_from_message(m)
                                        if text:
                                            break
                            if text:
                                self.last_result_event = {
                                    "type": "result",
                                    "subtype": "success",
                                    "is_error": False,
                                    "result": text,
                                    "session_id": self.session_id,
                                    "sub_agent_response": self._sanitize_sub_agent_response(parsed),
                                }
                            else:
                                self.last_result_event = parsed
                        elif event_type == "message":
                            # OpenAI-compatible format: capture last assistant message
                            msg = parsed.get("message", {})
                            if isinstance(msg, dict) and msg.get("role") == "assistant":
                                text = self._extract_text_from_message(msg)
                                if text:
                                    self.last_result_event = {
                                        "type": "result",
                                        "subtype": "success",
                                        "is_error": False,
                                        "result": text,
                                        "session_id": self.session_id,
                                        "sub_agent_response": self._sanitize_sub_agent_response(parsed),
                                    }
                        elif event_type == "turn_end":
                            # turn_end may contain the final assistant message
                            msg = parsed.get("message", {})
                            if isinstance(msg, dict):
                                text = self._extract_text_from_message(msg)
                                if text:
                                    self.last_result_event = {
                                        "type": "result",
                                        "subtype": "success",
                                        "is_error": False,
                                        "result": text,
                                        "session_id": self.session_id,
                                        "sub_agent_response": self._sanitize_sub_agent_response(parsed),
                                    }

                        # Filter hidden stream types (live mode handles its own filtering)
                        if event_type in hide_types and self.prettifier_mode != self.PRETTIFIER_LIVE:
                            continue

                        # Live stream mode: stream deltas in real-time
                        if self.prettifier_mode == self.PRETTIFIER_LIVE:
                            if event_type in hide_types:
                                # In live mode, still suppress session/compaction/retry events
                                # but NOT message_start/message_end (handled by _format_event_live)
                                if event_type not in ("message_start", "message_end"):
                                    continue
                            formatted = self._format_event_live(parsed)
                            if formatted is not None:
                                if formatted == "":
                                    continue
                                sys.stdout.write(formatted)
                                sys.stdout.flush()
                            else:
                                # Fallback: print raw JSON for unhandled event types
                                print(json.dumps(parsed, ensure_ascii=False), flush=True)
                            continue

                        # Format and print using model-appropriate prettifier
                        if pretty:
                            if self.prettifier_mode == self.PRETTIFIER_CODEX:
                                # Try Pi-wrapped Codex format first (role-based messages)
                                if "role" in parsed:
                                    formatted = self._format_pi_codex_message(parsed)
                                else:
                                    # Try Pi event handler (message_update, turn_end, etc.)
                                    formatted = self._format_pi_codex_event(parsed)
                                    if formatted is not None:
                                        # Empty string means "suppress this event"
                                        if formatted == "":
                                            continue
                                    else:
                                        # Try native Codex event handler
                                        formatted = self._format_event_pretty_codex(parsed)
                                if formatted is None:
                                    # Sanitize before raw JSON fallback: strip thinkingSignature,
                                    # encrypted_content, and metadata from nested Codex events.
                                    self._sanitize_codex_event(parsed, strip_metadata=True)
                                    formatted = json.dumps(parsed, ensure_ascii=False)
                            elif self.prettifier_mode == self.PRETTIFIER_CLAUDE:
                                formatted = self._format_event_pretty_claude(parsed)
                            else:
                                formatted = self._format_event_pretty(parsed)
                            if formatted is not None:
                                print(formatted, flush=True)
                        else:
                            print(line, flush=True)

                except ValueError:
                    # Watchdog closed stdout — expected when process exits but pipe stays open.
                    pass

            # Signal watchdog that output loop is done
            output_done.set()

            # Write capture file for shell backend
            self._write_capture_file(capture_path)

            # Wait for process cleanup
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

            # Wait for stderr thread to finish
            stderr_thread.join(timeout=3)

            return process.returncode or 0

        except KeyboardInterrupt:
            print("\nInterrupted by user", file=sys.stderr)
            try:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            except Exception:
                pass
            self._write_capture_file(capture_path)
            return 130

        except Exception as e:
            print(f"Error executing pi: {e}", file=sys.stderr)
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
            except Exception:
                pass
            self._write_capture_file(capture_path)
            return 1

    def run(self) -> int:
        """Main execution flow."""
        args = self.parse_arguments()

        # Prompt handling
        prompt_value = args.prompt or os.environ.get("JUNO_INSTRUCTION")
        if not prompt_value and not args.prompt_file:
            print("Error: Either -p/--prompt or -pp/--prompt-file is required.", file=sys.stderr)
            print("\nRun 'pi.py --help' for usage information.", file=sys.stderr)
            return 1

        if not self.check_pi_installed():
            print(
                "Error: Pi CLI is not available. Please install it:\n"
                "  npm install -g @mariozechner/pi-coding-agent\n"
                "See: https://pi.dev/",
                file=sys.stderr,
            )
            return 1

        self.project_path = os.path.abspath(args.cd)
        if not os.path.isdir(self.project_path):
            print(f"Error: Project path does not exist: {self.project_path}", file=sys.stderr)
            return 1

        self.model_name = self.expand_model_shorthand(args.model)
        self.prettifier_mode = self._detect_prettifier_mode(self.model_name)
        self.verbose = args.verbose

        # Verbose mode enables live stream prettifier for real-time output,
        # but only for Pi-native event protocol.  Codex models use a different
        # event format that the LIVE prettifier doesn't handle — keep codex mode.
        if args.verbose and self.prettifier_mode != self.PRETTIFIER_CODEX:
            self.prettifier_mode = self.PRETTIFIER_LIVE

        if self.verbose:
            print(f"Prettifier mode: {self.prettifier_mode} (model: {self.model_name})", file=sys.stderr)

        if args.prompt_file:
            self.prompt = self.read_prompt_file(args.prompt_file)
        else:
            self.prompt = prompt_value

        cmd, stdin_prompt = self.build_pi_command(args)
        return self.run_pi(cmd, args, stdin_prompt=stdin_prompt)


def main():
    service = PiService()
    sys.exit(service.run())


if __name__ == "__main__":
    main()
