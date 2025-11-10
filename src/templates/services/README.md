# Juno-Code Service Scripts

This directory contains service scripts that extend juno-code functionality. These scripts are Python-based utilities that can be customized by users.

## Installation

Service scripts are automatically installed to `~/.juno_code/services/` when you run:

```bash
juno-code init
```

Or you can manually install/manage them:

```bash
# Install services
juno-code services install

# List installed services
juno-code services list

# Check installation status
juno-code services status

# Show services directory path
juno-code services path

# Uninstall services
juno-code services uninstall --yes
```

## Available Services

### codex.py

A wrapper for OpenAI Codex CLI with configurable options.

#### Features

- Automatic codex installation check
- Support for inline prompts or prompt files
- Configurable model selection
- Auto-instruction prepending
- Full argument passthrough and override support
- JSON output support
- Verbose mode for debugging

#### Usage

```bash
# Basic usage with inline prompt
~/.juno_code/services/codex.py -p "Write a hello world function"

# Using a prompt file
~/.juno_code/services/codex.py -pp /path/to/prompt.txt

# Specify project directory
~/.juno_code/services/codex.py -p "Add tests" --cd /path/to/project

# Override default model
~/.juno_code/services/codex.py -p "Refactor code" -m gpt-4-turbo

# Custom auto-instruction
~/.juno_code/services/codex.py -p "Fix bugs" --auto-instruction "You are a debugging expert"

# Add custom codex config
~/.juno_code/services/codex.py -p "Write code" -c custom_option=value

# Enable verbose output
~/.juno_code/services/codex.py -p "Analyze code" --verbose

# JSON output
~/.juno_code/services/codex.py -p "Generate function" --json
```

#### Arguments

- `-p, --prompt <text>`: Prompt text to send to codex (required, mutually exclusive with --prompt-file)
- `-pp, --prompt-file <path>`: Path to file containing the prompt (required, mutually exclusive with --prompt)
- `--cd <path>`: Project path (absolute path). Default: current directory
- `-m, --model <name>`: Model name. Default: gpt-4
- `--auto-instruction <text>`: Auto instruction to prepend to prompt
- `-c, --config <arg>`: Additional codex config arguments (can be used multiple times)
- `--json`: Output in JSON format
- `--verbose`: Enable verbose output

#### Default Configuration

The script comes with these default codex configurations:
- `include_apply_patch_tool=true`
- `use_experimental_streamable_shell_tool=true`
- `sandbox_mode=danger-full-access`

You can override these by providing the same config key with `-c`:

```bash
# Override sandbox mode
~/.juno_code/services/codex.py -p "Safe operation" -c sandbox_mode=safe
```

## Customization

All service scripts installed in `~/.juno_code/services/` can be modified to suit your needs. This directory is designed for user customization.

### Adding Custom Services

You can add your own service scripts to `~/.juno_code/services/`:

1. Create a new Python script (e.g., `my-service.py`)
2. Make it executable: `chmod +x ~/.juno_code/services/my-service.py`
3. Use it from anywhere: `~/.juno_code/services/my-service.py`

### Service Script Template

Here's a basic template for creating your own service:

```python
#!/usr/bin/env python3
"""
My Custom Service
Description of what this service does
"""

import argparse
import subprocess
import sys

def main():
    parser = argparse.ArgumentParser(description="My Custom Service")
    parser.add_argument('-p', '--prompt', required=True, help='Prompt text')
    parser.add_argument('--cd', default='.', help='Working directory')

    args = parser.parse_args()

    # Your service logic here
    print(f"Processing: {args.prompt}")

    return 0

if __name__ == "__main__":
    sys.exit(main())
```

## Future Extensions

These service scripts are part of juno-code's extensibility model. In future versions, you'll be able to:

- Use these scripts as alternative backends for juno-code subagents
- Create custom subagent implementations without MCP server dependency
- Share and install community-created service scripts
- Integrate with other AI coding tools and CLIs

## Requirements

Service scripts require Python 3.6+ to be installed on your system. Individual services may have additional requirements:

- **codex.py**: Requires OpenAI Codex CLI to be installed

## Troubleshooting

### Services not found

If services are not installed, run:

```bash
juno-code services install
```

### Permission denied

Make sure scripts are executable:

```bash
chmod +x ~/.juno_code/services/*.py
```

### Python not found

Ensure Python 3 is installed and available in your PATH:

```bash
python3 --version
```

## Support

For issues or feature requests related to service scripts, please visit:
https://github.com/owner/juno-code/issues
