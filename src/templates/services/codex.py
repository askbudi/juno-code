#!/usr/bin/env python3
"""
Codex Service Script for juno-code
This script provides a wrapper around OpenAI Codex CLI with configurable options.
"""

import argparse
import os
import subprocess
import sys
import json
from datetime import datetime
from typing import List, Optional


class CodexService:
    """Service wrapper for OpenAI Codex CLI"""

    # Default configuration
    DEFAULT_MODEL = "codex-5.1-max"
    DEFAULT_AUTO_INSTRUCTION = """You are an AI coding assistant. Follow the instructions provided and generate high-quality code."""

    # Model shorthand mappings (colon-prefixed names expand to full model IDs)
    MODEL_SHORTHANDS = {
        ":codex": "codex-5.1-codex-max",
        ":gpt-5": "gpt-5",
        ":mini": "gpt-5-codex-mini",
    }

    def __init__(self):
        self.model_name = self.DEFAULT_MODEL
        self.auto_instruction = self.DEFAULT_AUTO_INSTRUCTION
        self.project_path = os.getcwd()
        self.prompt = ""
        self.additional_args: List[str] = []
        self.verbose = False

    def expand_model_shorthand(self, model: str) -> str:
        """
        Expand model shorthand names to full model IDs.

        If the model starts with ':', look it up in MODEL_SHORTHANDS.
        Otherwise, return the model name as-is.
        """
        if model.startswith(":"):
            return self.MODEL_SHORTHANDS.get(model, model)
        return model

    def check_codex_installed(self) -> bool:
        """Check if codex CLI is installed and available"""
        try:
            result = subprocess.run(
                ["which", "codex"],
                capture_output=True,
                text=True,
                check=False
            )
            return result.returncode == 0
        except Exception:
            return False

    def parse_arguments(self) -> argparse.Namespace:
        """Parse command line arguments"""
        parser = argparse.ArgumentParser(
            description="Codex Service - Wrapper for OpenAI Codex CLI",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
Examples:
  %(prog)s -p "Write a hello world function"
  %(prog)s -pp prompt.txt --cd /path/to/project
  %(prog)s -p "Add tests" -m gpt-4 -c custom_arg=value
  %(prog)s -p "Optimize code" -m :codex  # uses codex-5.1-codex-max

Environment Variables:
  CODEX_MODEL                Model name (supports shorthand, default: codex-5.1-max)
  CODEX_HIDE_STREAM_TYPES    Comma-separated list of streaming msg types to hide
                             Default: turn_diff,token_count,exec_command_output_delta
  JUNO_CODE_HIDE_STREAM_TYPES Same as CODEX_HIDE_STREAM_TYPES (alias)
            """
        )

        # Core arguments
        prompt_group = parser.add_mutually_exclusive_group(required=False)
        prompt_group.add_argument(
            "-p", "--prompt",
            type=str,
            help="Prompt text to send to codex"
        )
        prompt_group.add_argument(
            "-pp", "--prompt-file",
            type=str,
            help="Path to file containing the prompt"
        )

        parser.add_argument(
            "--cd",
            type=str,
            default=os.getcwd(),
            help="Project path (absolute path). Default: current directory"
        )

        parser.add_argument(
            "-m", "--model",
            type=str,
            default=os.environ.get("CODEX_MODEL", self.DEFAULT_MODEL),
            help=f"Model name. Supports shorthand (e.g., ':codex', ':gpt-5', ':mini') or full model ID. Default: {self.DEFAULT_MODEL} (env: CODEX_MODEL)"
        )

        parser.add_argument(
            "--auto-instruction",
            type=str,
            default=self.DEFAULT_AUTO_INSTRUCTION,
            help="Auto instruction to prepend to prompt"
        )

        parser.add_argument(
            "-c", "--config",
            action="append",
            dest="configs",
            help="Additional codex config arguments (can be used multiple times)"
        )

        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Enable verbose output"
        )

        return parser.parse_args()

    def _first_nonempty_str(self, *values: Optional[str]) -> str:
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

    def _extract_message_text(self, payload: dict) -> str:
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

    def read_prompt_file(self, file_path: str) -> str:
        """Read prompt from a file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except FileNotFoundError:
            print(f"Error: Prompt file not found: {file_path}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error reading prompt file: {e}", file=sys.stderr)
            sys.exit(1)

    def build_codex_command(self, args: argparse.Namespace) -> List[str]:
        """Build the codex command with all arguments"""
        # Start with base command
        cmd = [
            "codex",
            "--cd", self.project_path,
            "-m", self.model_name,
        ]

        # Add default config arguments
        default_configs = [
            "include_apply_patch_tool=true",
            "use_experimental_streamable_shell_tool=true",
            "sandbox_mode=danger-full-access"
        ]

        # Track which configs are already set
        config_keys = set()
        user_configs = []

        # Process user-provided configs
        if args.configs:
            for config in args.configs:
                key = config.split('=')[0] if '=' in config else config
                config_keys.add(key)
                user_configs.append(config)

        # Add default configs that weren't overridden
        for config in default_configs:
            key = config.split('=')[0]
            if key not in config_keys:
                cmd.extend(["-c", config])

        # Add user configs (these will override defaults if keys match)
        for config in user_configs:
            cmd.extend(["-c", config])

        # Build the full prompt (auto_instruction + user prompt)
        full_prompt = f"{self.auto_instruction}\n\n{self.prompt}"

        # Add exec command with prompt
        cmd.extend(["exec", full_prompt])

        # Add --json flag for streaming support
        # This is CRITICAL for codex to output streaming responses
        # Without this flag, codex will not stream progress updates
        cmd.append("--json")

        return cmd

    def _format_msg_pretty(
        self,
        msg_type: str,
        payload: dict,
        outer_type: str = "",
    ) -> Optional[str]:
        """
        Pretty format for specific msg types to be human readable while
        preserving a compact JSON header line that includes the msg.type.

        - agent_message: render 'message' field as multi-line text
        - agent_reasoning: render 'text' field as multi-line text
        - exec_command_end: only output 'formatted_output' (suppress other fields)
        - token_count: fully suppressed (no final summary emission)

        Returns a string to print, or None to fall back to raw printing.
        """
        try:
            now = datetime.now().strftime("%I:%M:%S %p")
            msg_type = (msg_type or "").strip()
            header_type = (outer_type or msg_type).strip()
            header = {"type": header_type or msg_type or "message", "datetime": now}

            if outer_type and msg_type and outer_type != msg_type:
                header["item_type"] = msg_type

            if isinstance(payload, dict):
                if payload.get("command"):
                    header["command"] = payload.get("command")
                if payload.get("status"):
                    header["status"] = payload.get("status")
                if payload.get("state") and not header.get("status"):
                    header["status"] = payload.get("state")

            # agent_message → show 'message' human-readable
            if msg_type == "agent_message":
                content = payload.get("message", "") if isinstance(payload, dict) else ""
                header = {"type": msg_type, "datetime": now}
                if "\n" in content:
                    return json.dumps(header, ensure_ascii=False) + "\nmessage:\n" + content
                header["message"] = content
                return json.dumps(header, ensure_ascii=False)

            # agent_reasoning → show 'text' human-readable
            if msg_type in {"agent_reasoning", "reasoning"}:
                content = self._extract_reasoning_text(payload)
                header = {"type": header_type or msg_type, "datetime": now}
                if outer_type and msg_type and outer_type != msg_type:
                    header["item_type"] = msg_type
                if "\n" in content:
                    return json.dumps(header, ensure_ascii=False) + "\ntext:\n" + content
                header["text"] = content
                return json.dumps(header, ensure_ascii=False)

            if msg_type in {"message", "assistant_message", "assistant"}:
                content = self._extract_message_text(payload)
                header = {"type": header_type or msg_type, "datetime": now}
                if outer_type and msg_type and outer_type != msg_type:
                    header["item_type"] = msg_type
                if "\n" in content:
                    return json.dumps(header, ensure_ascii=False) + "\nmessage:\n" + content
                if content != "":
                    header["message"] = content
                    return json.dumps(header, ensure_ascii=False)
                if header_type:
                    return json.dumps(header, ensure_ascii=False)

            # exec_command_end → only show 'formatted_output'
            if msg_type == "exec_command_end":
                formatted_output = payload.get("formatted_output", "") if isinstance(payload, dict) else ""
                header = {"type": msg_type, "datetime": now}
                if "\n" in formatted_output:
                    return json.dumps(header, ensure_ascii=False) + "\nformatted_output:\n" + formatted_output
                header["formatted_output"] = formatted_output
                return json.dumps(header, ensure_ascii=False)

            # item.* schema → command_execution blocks
            if msg_type == "command_execution":
                aggregated_output = self._extract_command_output_text(payload)
                if "\n" in aggregated_output:
                    return json.dumps(header, ensure_ascii=False) + "\naggregated_output:\n" + aggregated_output
                if aggregated_output:
                    header["aggregated_output"] = aggregated_output
                    return json.dumps(header, ensure_ascii=False)
                # No output (likely item.started) – still show header if it carries context
                if header_type:
                    return json.dumps(header, ensure_ascii=False)

            return None
        except Exception:
            return None

    def _normalize_event(self, obj_dict: dict):
        """
        Normalize legacy (msg-based) and new item.* schemas into a common tuple.
        Returns (msg_type, payload_dict, outer_type).
        """
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

    def run_codex(self, cmd: List[str], verbose: bool = False) -> int:
        """Execute the codex command and stream output with filtering and pretty-printing

        Robustness improvements:
        - Attempts to parse JSON even if the line has extra prefix/suffix noise
        - Falls back to string suppression for known noisy types if JSON parsing fails
        - Never emits token_count or exec_command_output_delta even on malformed lines
        """
        if verbose:
            print(f"Executing: {' '.join(cmd)}", file=sys.stderr)
            print("-" * 80, file=sys.stderr)

        # Resolve hidden stream types (ENV configurable)
        default_hidden = {"turn_diff", "token_count", "exec_command_output_delta"}
        env_hide_1 = os.environ.get("CODEX_HIDE_STREAM_TYPES", "")
        env_hide_2 = os.environ.get("JUNO_CODE_HIDE_STREAM_TYPES", "")
        hide_types = set(default_hidden)
        for env_val in (env_hide_1, env_hide_2):
            if env_val:
                parts = [p.strip() for p in env_val.split(",") if p.strip()]
                hide_types.update(parts)

        # We fully suppress all token_count events (do not emit even at end)
        last_token_count = None

        try:
            # Run the command and stream output
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )

            def split_json_stream(text: str):
                objs = []
                buf: List[str] = []
                depth = 0
                in_str = False
                esc = False
                started = False
                for ch in text:
                    if in_str:
                        buf.append(ch)
                        if esc:
                            esc = False
                        elif ch == '\\':
                            esc = True
                        elif ch == '"':
                            in_str = False
                        continue
                    if ch == '"':
                        in_str = True
                        buf.append(ch)
                        continue
                    if ch == '{':
                        depth += 1
                        started = True
                        buf.append(ch)
                        continue
                    if ch == '}':
                        depth -= 1
                        buf.append(ch)
                        if started and depth == 0:
                            candidate = ''.join(buf).strip().strip("'\"")
                            if candidate:
                                objs.append(candidate)
                            buf = []
                            started = False
                        continue
                    if started:
                        buf.append(ch)
                remainder = ''.join(buf) if buf else ""
                return objs, remainder

            def handle_obj(obj_dict: dict):
                nonlocal last_token_count
                msg_type_inner, payload_inner, outer_type_inner = self._normalize_event(obj_dict)

                if msg_type_inner == "token_count":
                    last_token_count = obj_dict
                    return  # suppress

                if msg_type_inner and msg_type_inner in hide_types:
                    return  # suppress

                pretty_line_inner = self._format_msg_pretty(msg_type_inner, payload_inner, outer_type_inner)
                if pretty_line_inner is not None:
                    print(pretty_line_inner, flush=True)
                else:
                    # print normalized JSON
                    print(json.dumps(obj_dict, ensure_ascii=False), flush=True)

            pending = ""

            if process.stdout:
                for raw_line in process.stdout:
                    combined = pending + raw_line
                    if not combined.strip():
                        pending = ""
                        continue

                    # If no braces present at all, treat as plain text (with suppression)
                    if "{" not in combined and "}" not in combined:
                        lower = combined.lower()
                        if (
                            '"token_count"' in lower
                            or '"exec_command_output_delta"' in lower
                            or '"turn_diff"' in lower
                        ):
                            pending = ""
                            continue
                        print(combined, end="" if combined.endswith("\n") else "\n", flush=True)
                        pending = ""
                        continue

                    # Preserve and emit any prefix before the first brace
                    first_brace = combined.find("{")
                    if first_brace > 0:
                        prefix = combined[:first_brace]
                        lower_prefix = prefix.lower()
                        if (
                            '"token_count"' not in lower_prefix
                            and '"exec_command_output_delta"' not in lower_prefix
                            and '"turn_diff"' not in lower_prefix
                            and prefix.strip()
                        ):
                            print(prefix, end="" if prefix.endswith("\n") else "\n", flush=True)
                        combined = combined[first_brace:]

                    parts, pending = split_json_stream(combined)

                    if parts:
                        for part in parts:
                            try:
                                sub = json.loads(part)
                                if isinstance(sub, dict):
                                    handle_obj(sub)
                                else:
                                    low = part.lower()
                                    if (
                                        '"token_count"' in low
                                        or '"exec_command_output_delta"' in low
                                        or '"turn_diff"' in low
                                    ):
                                        continue
                                    print(part, flush=True)
                            except Exception:
                                low = part.lower()
                                if (
                                    '"token_count"' in low
                                    or '"exec_command_output_delta"' in low
                                    or '"turn_diff"' in low
                                ):
                                    continue
                                print(part, flush=True)
                        continue

                    # No complete object found yet; keep buffering if likely in the middle of one
                    if pending:
                        continue

                    # Fallback for malformed/non-JSON lines that still contain braces
                    lower = combined.lower()
                    if (
                        '"token_count"' in lower
                        or '"exec_command_output_delta"' in lower
                        or '"turn_diff"' in lower
                    ):
                        continue
                    print(combined, end="" if combined.endswith("\n") else "\n", flush=True)

            # Flush any pending buffered content after the stream ends
            if pending.strip():
                try:
                    tail_obj = json.loads(pending)
                    if isinstance(tail_obj, dict):
                        handle_obj(tail_obj)
                    else:
                        print(pending, flush=True)
                except Exception:
                    low_tail = pending.lower()
                    if (
                        '"token_count"' not in low_tail
                        and '"exec_command_output_delta"' not in low_tail
                        and '"turn_diff"' not in low_tail
                    ):
                        print(pending, flush=True)

            # Wait for process completion
            process.wait()

            # Do not emit token_count summary; fully suppressed per user feedback

            # Print stderr if there were errors
            if process.stderr and process.returncode != 0:
                stderr_output = process.stderr.read()
                if stderr_output:
                    print(stderr_output, file=sys.stderr)

            return process.returncode

        except KeyboardInterrupt:
            print("\nInterrupted by user", file=sys.stderr)
            try:
                process.terminate()
                process.wait()
            except Exception:
                pass
            return 130
        except Exception as e:
            print(f"Error executing codex: {e}", file=sys.stderr)
            return 1

    def run(self) -> int:
        """Main execution flow"""
        # Parse arguments first to handle --help
        args = self.parse_arguments()

        # Check if prompt is provided
        if not args.prompt and not args.prompt_file:
            print(
                "Error: Either -p/--prompt or -pp/--prompt-file is required.",
                file=sys.stderr
            )
            print("\nRun 'codex.py --help' for usage information.", file=sys.stderr)
            return 1

        # Check if codex is installed
        if not self.check_codex_installed():
            print(
                "Error: OpenAI Codex is not available. Please install it.",
                file=sys.stderr
            )
            print(
                "Visit: https://openai.com/blog/openai-codex for installation instructions",
                file=sys.stderr
            )
            return 1

        # Set configuration from arguments
        self.project_path = os.path.abspath(args.cd)
        # Expand model shorthand
        self.model_name = self.expand_model_shorthand(args.model)
        self.auto_instruction = args.auto_instruction

        # Get prompt from file or argument
        if args.prompt_file:
            self.prompt = self.read_prompt_file(args.prompt_file)
        else:
            self.prompt = args.prompt

        # Validate project path
        if not os.path.isdir(self.project_path):
            print(
                f"Error: Project path does not exist: {self.project_path}",
                file=sys.stderr
            )
            return 1

        # Build and execute command
        cmd = self.build_codex_command(args)
        self.verbose = args.verbose
        return self.run_codex(cmd, verbose=args.verbose)


def main():
    """Entry point"""
    service = CodexService()
    sys.exit(service.run())


if __name__ == "__main__":
    main()
