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
    DEFAULT_MODEL = "gpt-4"
    DEFAULT_AUTO_INSTRUCTION = """You are an AI coding assistant. Follow the instructions provided and generate high-quality code."""

    def __init__(self):
        self.model_name = self.DEFAULT_MODEL
        self.auto_instruction = self.DEFAULT_AUTO_INSTRUCTION
        self.project_path = os.getcwd()
        self.prompt = ""
        self.additional_args: List[str] = []
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

            # Stream stdout line by line
            # Codex outputs text format by default (not JSON), so we just pass it through
            if process.stdout:
                for line in process.stdout:
                    # Output text as-is with immediate flush for real-time streaming
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
        self.verbose = args.verbose
        return self.run_codex(cmd, verbose=args.verbose)


def main():
    """Entry point"""
    service = CodexService()
    sys.exit(service.run())


if __name__ == "__main__":
    main()
