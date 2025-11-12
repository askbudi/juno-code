#!/usr/bin/env python3
"""
Codex Service Script for juno-code
This script provides a wrapper around OpenAI Codex CLI with configurable options.
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any


class CodexService:
    """Service wrapper for OpenAI Codex CLI"""

    # Default configuration
    DEFAULT_MODEL = "gpt-4"
    DEFAULT_AUTO_INSTRUCTION = """You are an AI coding assistant. Follow the instructions provided and generate high-quality code."""

    def __init__(self):
        self.model_name = self.DEFAULT_MODEL
        self.auto_instruction = self.DEFAULT_AUTO_INSTRUCTION
        self.project_path = os.getcwd()
        self.prompt = ""
        self.additional_args: List[str] = []
        self.message_counter = 0
        self.verbose = False

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
            default=self.DEFAULT_MODEL,
            help=f"Model name. Default: {self.DEFAULT_MODEL}"
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
            "--json",
            action="store_true",
            default=True,
            help="Output in JSON format (default: True)"
        )

        parser.add_argument(
            "--pretty",
            type=str,
            default=os.environ.get("CODEX_PRETTY", "true").lower(),
            choices=["true", "false"],
            help="Pretty print JSON output (default: true, env: CODEX_PRETTY)"
        )

        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Enable verbose output"
        )

        return parser.parse_args()

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

        # Add JSON flag if requested (enables streaming JSON output)
        if args.json:
            cmd.append("--json")

        return cmd

    def pretty_format_json(self, json_line: str) -> Optional[str]:
        """
        Format JSON line for pretty output.
        For type=assistant: show datetime, message content, and counter
        For other types: show full message with datetime and counter
        Returns None if line should be skipped

        IMPORTANT: Always preserve the 'type' field so shell backend can parse events
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
                # KEEP the 'type' field for shell backend compatibility
                simplified = {
                    "type": "assistant",
                    "datetime": now,
                    "counter": f"#{self.message_counter}"
                }

                # Add either content or tool_use data
                if tool_use_data:
                    simplified["tool_use"] = tool_use_data
                else:
                    simplified["content"] = text_content

                return json.dumps(simplified)
            else:
                # For other message types, show full message with datetime and counter
                # Type field is already present in data, so it's preserved
                output = {
                    "datetime": now,
                    "counter": f"#{self.message_counter}",
                    **data
                }
                return json.dumps(output)

        except json.JSONDecodeError:
            # If not valid JSON, return as-is
            return json_line
        except Exception as e:
            # On any error, return original line
            print(f"Warning: Error formatting JSON: {e}", file=sys.stderr)
            return json_line

    def run_codex(self, cmd: List[str], verbose: bool = False, pretty: bool = True) -> int:
        """Execute the codex command and stream output"""
        if verbose:
            print(f"Executing: {' '.join(cmd)}", file=sys.stderr)
            print("-" * 80, file=sys.stderr)

        try:
            # Run the command and stream output
            # Use line buffering (bufsize=1) to ensure each JSON line is output immediately
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # Line buffering for immediate output
                universal_newlines=True
            )

            # Stream stdout line by line (each line is a JSON object when using --json)
            # This allows users to pipe to jq and see output as it streams
            if process.stdout:
                for line in process.stdout:
                    # Apply pretty formatting if enabled
                    if pretty:
                        formatted_line = self.pretty_format_json(line.strip())
                        if formatted_line:
                            print(formatted_line, flush=True)
                    else:
                        # Raw output without formatting
                        print(line, end='', flush=True)

            # Wait for process to complete
            process.wait()

            # Print stderr if there were errors
            if process.stderr and process.returncode != 0:
                stderr_output = process.stderr.read()
                if stderr_output:
                    print(stderr_output, file=sys.stderr)

            return process.returncode

        except KeyboardInterrupt:
            print("\nInterrupted by user", file=sys.stderr)
            if process:
                process.terminate()
                process.wait()
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
        self.model_name = args.model
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
        pretty = args.pretty == "true"
        self.verbose = args.verbose
        return self.run_codex(cmd, verbose=args.verbose, pretty=pretty)


def main():
    """Entry point"""
    service = CodexService()
    sys.exit(service.run())


if __name__ == "__main__":
    main()
