#!/usr/bin/env python3
"""
Codex Service Script for juno-code
This script provides a wrapper around OpenAI Codex CLI with configurable options.
"""

import argparse
import os
import subprocess
import sys
from typing import List


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

    def run_codex(self, cmd: List[str], verbose: bool = False) -> int:
        """Execute the codex command and stream output with filtering"""
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

            if process.stdout:
                for raw_line in process.stdout:
                    line = raw_line.rstrip("\n")
                    if not line:
                        continue
                    # Try to parse NDJSON and filter by msg.type
                    try:
                        obj = None
                        # Some CLIs may print extra spaces; be robust
                        s = line.strip()
                        if s.startswith("{") and s.endswith("}"):
                            obj = __import__("json").loads(s)
                        if isinstance(obj, dict):
                            msg = obj.get("msg") or {}
                            msg_type = (msg.get("type") or "").strip()
                            if msg_type == "token_count":
                                # Buffer latest token_count; do not print now
                                last_token_count = obj
                                continue
                            if msg_type and msg_type in hide_types:
                                # Suppressed type
                                continue
                            # Print the JSON line as-is
                            print(s, flush=True)
                        else:
                            # Not JSON; pass through
                            print(raw_line, end="", flush=True)
                    except Exception:
                        # On parsing error, pass through raw line
                        print(raw_line, end="", flush=True)

            # Wait for process completion
            process.wait()

            # After completion, emit the last token_count if available
            if last_token_count is not None:
                try:
                    print(__import__("json").dumps(last_token_count), flush=True)
                except Exception:
                    # Ignore if serialization fails
                    pass

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
