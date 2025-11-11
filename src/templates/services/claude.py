#!/usr/bin/env python3
"""
Claude Service Script for juno-code
This script provides a wrapper around Anthropic Claude CLI with configurable options.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, List, Dict, Any


class ClaudeService:
    """Service wrapper for Anthropic Claude CLI"""

    # Default configuration
    DEFAULT_MODEL = "claude-sonnet-4-20250514"
    DEFAULT_AUTO_INSTRUCTION = """You are Claude Code, an AI coding assistant. Follow the instructions provided and generate high-quality code."""

    def __init__(self):
        self.model_name = self.DEFAULT_MODEL
        self.auto_instruction = self.DEFAULT_AUTO_INSTRUCTION
        self.project_path = os.getcwd()
        self.prompt = ""
        self.additional_args: List[str] = []

    def check_claude_installed(self) -> bool:
        """Check if claude CLI is installed and available"""
        try:
            result = subprocess.run(
                ["which", "claude"],
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
            description="Claude Service - Wrapper for Anthropic Claude CLI",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
Examples:
  %(prog)s -p "Write a hello world function"
  %(prog)s -pp prompt.txt --cd /path/to/project
  %(prog)s -p "Add tests" -m claude-opus-4-20250514 --tool "Bash Edit"
            """
        )

        # Core arguments
        prompt_group = parser.add_mutually_exclusive_group(required=False)
        prompt_group.add_argument(
            "-p", "--prompt",
            type=str,
            help="Prompt text to send to claude"
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
            help=f"Model name (e.g. 'sonnet', 'opus', or full name). Default: {self.DEFAULT_MODEL}"
        )

        parser.add_argument(
            "--auto-instruction",
            type=str,
            default=self.DEFAULT_AUTO_INSTRUCTION,
            help="Auto instruction to prepend to prompt"
        )

        parser.add_argument(
            "--tool",
            action="append",
            dest="allowed_tools",
            help="Allowed tools (can be used multiple times, e.g. 'Bash' 'Edit')"
        )

        parser.add_argument(
            "--permission-mode",
            type=str,
            choices=["acceptEdits", "bypassPermissions", "default", "plan"],
            default="bypassPermissions",
            help="Permission mode for the session. Default: bypassPermissions"
        )

        parser.add_argument(
            "--json",
            action="store_true",
            help="Output in JSON format"
        )

        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Enable verbose output"
        )

        parser.add_argument(
            "-c", "--continue",
            action="store_true",
            dest="continue_conversation",
            help="Continue the most recent conversation"
        )

        parser.add_argument(
            "--additional-args",
            type=str,
            help="Additional claude arguments as a space-separated string"
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

    def build_claude_command(self, args: argparse.Namespace) -> List[str]:
        """Build the claude command with all arguments"""
        # Start with base command
        cmd = [
            "claude",
            "--print",  # Non-interactive mode
            "--model", self.model_name,
            "--permission-mode", args.permission_mode,
        ]

        # Add allowed tools if specified
        if args.allowed_tools:
            cmd.append("--allowed-tools")
            cmd.extend(args.allowed_tools)
        else:
            # Default allowed tools similar to claude_code.py
            default_tools = [
                "Read", "Write", "Edit", "MultiEdit",
                "Bash", "Glob", "Grep", "WebFetch",
                "WebSearch", "TodoWrite"
            ]
            cmd.append("--allowed-tools")
            cmd.extend(default_tools)

        # Add continue flag if specified
        if args.continue_conversation:
            cmd.append("--continue")

        # Add output format if JSON requested
        if args.json:
            cmd.extend(["--output-format", "json"])

        # Add any additional arguments
        if args.additional_args:
            additional = args.additional_args.split()
            cmd.extend(additional)

        # Build the full prompt (auto_instruction + user prompt)
        full_prompt = f"{self.auto_instruction}\n\n{self.prompt}"

        # Add the prompt as the final argument
        cmd.append(full_prompt)

        return cmd

    def run_claude(self, cmd: List[str], verbose: bool = False) -> int:
        """Execute the claude command and stream output"""
        if verbose:
            print(f"Executing: {' '.join(cmd)}", file=sys.stderr)
            print("-" * 80, file=sys.stderr)

        try:
            # Change to project directory before running
            original_cwd = os.getcwd()
            os.chdir(self.project_path)

            # Run the command and stream output
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )

            # Stream stdout
            if process.stdout:
                for line in process.stdout:
                    print(line, end='')

            # Wait for process to complete
            process.wait()

            # Print stderr if there were errors
            if process.stderr and process.returncode != 0:
                stderr_output = process.stderr.read()
                if stderr_output:
                    print(stderr_output, file=sys.stderr)

            # Restore original working directory
            os.chdir(original_cwd)

            return process.returncode

        except KeyboardInterrupt:
            print("\nInterrupted by user", file=sys.stderr)
            if process:
                process.terminate()
                process.wait()
            # Restore original working directory
            if 'original_cwd' in locals():
                os.chdir(original_cwd)
            return 130
        except Exception as e:
            print(f"Error executing claude: {e}", file=sys.stderr)
            # Restore original working directory
            if 'original_cwd' in locals():
                os.chdir(original_cwd)
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
            print("\nRun 'claude.py --help' for usage information.", file=sys.stderr)
            return 1

        # Check if claude is installed
        if not self.check_claude_installed():
            print(
                "Error: Claude CLI is not available. Please install it.",
                file=sys.stderr
            )
            print(
                "Visit: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code for installation instructions",
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
        cmd = self.build_claude_command(args)
        return self.run_claude(cmd, verbose=args.verbose)


def main():
    """Entry point"""
    service = ClaudeService()
    sys.exit(service.run())


if __name__ == "__main__":
    main()
