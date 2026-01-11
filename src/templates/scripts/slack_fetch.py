#!/usr/bin/env python3
"""
Slack Fetch - Fetch messages from Slack and create kanban tasks.

This script monitors a Slack channel for new messages and creates
kanban tasks from them. It uses persistent state tracking to avoid
processing the same message twice.

Features:
- Channel monitoring with configurable intervals
- Default --once mode for cron/scheduled jobs
- Persistent state tracking (no duplicate processing)
- Automatic kanban task creation with slack-input tag
- Graceful shutdown on SIGINT/SIGTERM

Usage:
    python slack_fetch.py --channel bug-reports --once
    python slack_fetch.py --channel feature-requests --continuous
    python slack_fetch.py --channel general --dry-run --verbose

Environment Variables:
    SLACK_BOT_TOKEN         Slack bot token (required, starts with xoxb-)
    SLACK_CHANNEL           Default channel to monitor
    CHECK_INTERVAL_SECONDS  Polling interval in seconds (default: 60)
    LOG_LEVEL               DEBUG, INFO, WARNING, ERROR (default: INFO)
"""

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

try:
    from dotenv import load_dotenv
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
except ImportError as e:
    print(f"Error: Missing required dependencies: {e}")
    print("Please run: pip install slack_sdk python-dotenv")
    sys.exit(1)

# Import local state manager
try:
    from slack_state import SlackStateManager
except ImportError:
    # Fallback: try importing from same directory
    script_dir = Path(__file__).parent
    sys.path.insert(0, str(script_dir))
    from slack_state import SlackStateManager


# Global shutdown flag
shutdown_requested = False

# Configure logging
logger = logging.getLogger(__name__)


def setup_logging(verbose: bool = False, log_file: Optional[str] = None) -> None:
    """Configure logging for the application."""
    log_level = logging.DEBUG if verbose else logging.INFO

    env_log_level = os.getenv('LOG_LEVEL', '').upper()
    if env_log_level in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
        log_level = getattr(logging, env_log_level)

    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_path)
        file_handler.setLevel(log_level)
        file_handler.setFormatter(
            logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
        )
        logging.getLogger().addHandler(file_handler)


def signal_handler(signum: int, frame) -> None:
    """Handle shutdown signals gracefully."""
    global shutdown_requested
    signal_name = signal.Signals(signum).name
    logger.info(f"Received {signal_name}, initiating graceful shutdown...")
    shutdown_requested = True


def get_channel_id(client: WebClient, channel_name: str) -> Optional[str]:
    """
    Resolve channel name to channel ID.

    Args:
        client: Slack WebClient instance
        channel_name: Channel name (with or without #) or channel ID

    Returns:
        Channel ID or None if not found
    """
    # If already looks like a channel ID, return as-is
    if channel_name.startswith('C') and len(channel_name) >= 9:
        logger.debug(f"Channel '{channel_name}' appears to be a channel ID")
        return channel_name

    # Strip # prefix if present
    channel_name = channel_name.lstrip('#')
    logger.info(f"Resolving channel name '{channel_name}' to ID...")

    try:
        # Try public channels
        result = client.conversations_list(types="public_channel")
        for channel in result.get('channels', []):
            if channel.get('name') == channel_name:
                channel_id = channel.get('id')
                logger.info(f"Found channel '{channel_name}' with ID: {channel_id}")
                return channel_id

        # Try private channels
        result = client.conversations_list(types="private_channel")
        for channel in result.get('channels', []):
            if channel.get('name') == channel_name:
                channel_id = channel.get('id')
                logger.info(f"Found private channel '{channel_name}' with ID: {channel_id}")
                return channel_id

        logger.error(f"Channel '{channel_name}' not found")
        return None

    except SlackApiError as e:
        logger.error(f"Error resolving channel name: {e.response['error']}")
        return None


def get_user_info(client: WebClient, user_id: str) -> str:
    """Get user display name from user ID."""
    try:
        result = client.users_info(user=user_id)
        user = result.get('user', {})
        profile = user.get('profile', {})
        display_name = (
            profile.get('display_name') or
            profile.get('real_name') or
            user.get('name') or
            user_id
        )
        return display_name
    except SlackApiError as e:
        logger.warning(f"Could not fetch user info for {user_id}: {e.response['error']}")
        return user_id


def fetch_channel_messages(
    client: WebClient,
    channel_id: str,
    oldest_ts: Optional[str] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Fetch messages from a Slack channel.

    Args:
        client: Slack WebClient instance
        channel_id: Slack channel ID
        oldest_ts: Optional timestamp to fetch messages after
        limit: Maximum number of messages to fetch

    Returns:
        List of message dicts
    """
    logger.debug(f"Fetching messages from channel {channel_id} (oldest_ts={oldest_ts})")

    try:
        kwargs = {'channel': channel_id, 'limit': limit}
        if oldest_ts:
            kwargs['oldest'] = oldest_ts

        result = client.conversations_history(**kwargs)
        messages = result.get('messages', [])

        # Filter to only user messages (exclude bot messages, system messages)
        messages = [
            m for m in messages
            if m.get('type') == 'message' and not m.get('subtype')
        ]

        logger.debug(f"Fetched {len(messages)} messages")
        return messages

    except SlackApiError as e:
        error_msg = e.response.get('error', 'unknown_error')
        logger.error(f"Error fetching messages: {error_msg}")

        if error_msg == 'ratelimited':
            retry_after = int(e.response.headers.get('Retry-After', 60))
            logger.warning(f"Rate limited, should retry after {retry_after} seconds")

        return []


def create_kanban_task(
    message_text: str,
    author_name: str,
    tags: List[str],
    kanban_script: str,
    dry_run: bool = False
) -> Optional[str]:
    """
    Create a kanban task from a Slack message.

    Args:
        message_text: The message content
        author_name: The author's display name
        tags: List of tags to apply
        kanban_script: Path to kanban.sh script
        dry_run: If True, don't actually create the task

    Returns:
        Task ID if created, None if failed or dry run
    """
    # Build the kanban command
    # Escape single quotes in message text
    escaped_text = message_text.replace("'", "'\\''")

    # Build tags argument
    tags_arg = ','.join(tags) if tags else 'slack-input'

    if dry_run:
        logger.info(f"[DRY RUN] Would create task: {message_text[:100]}...")
        logger.debug(f"[DRY RUN] Tags: {tags_arg}")
        return "dry-run-task-id"

    try:
        # Run kanban create command
        cmd = [kanban_script, 'create', message_text, '--tags', tags_arg]
        logger.debug(f"Running: {' '.join(cmd[:3])}...")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0:
            # Parse output to get task ID
            try:
                output = json.loads(result.stdout)
                if isinstance(output, list) and len(output) > 0:
                    task_id = output[0].get('id')
                    logger.info(f"Created kanban task: {task_id}")
                    return task_id
            except json.JSONDecodeError:
                logger.warning(f"Could not parse kanban output: {result.stdout[:200]}")
                # Still return success if command succeeded
                return "unknown-task-id"
        else:
            logger.error(f"Failed to create kanban task: {result.stderr}")
            return None

    except subprocess.TimeoutExpired:
        logger.error("Kanban command timed out")
        return None
    except Exception as e:
        logger.error(f"Error creating kanban task: {e}")
        return None


def process_messages(
    messages: List[Dict[str, Any]],
    channel_name: str,
    channel_id: str,
    client: WebClient,
    state_mgr: SlackStateManager,
    kanban_script: str,
    dry_run: bool = False
) -> int:
    """
    Process new messages: create kanban tasks and update state.

    Args:
        messages: List of message dicts
        channel_name: Channel name for logging
        channel_id: Channel ID
        client: Slack WebClient for user lookups
        state_mgr: SlackStateManager instance
        kanban_script: Path to kanban.sh script
        dry_run: If True, don't create tasks

    Returns:
        Number of messages processed
    """
    if not messages:
        return 0

    logger.info(f"Processing {len(messages)} new messages from #{channel_name}")
    processed = 0

    # Sort messages oldest first
    messages.sort(key=lambda m: m.get('ts', '0'))

    for msg in messages:
        ts = msg.get('ts')
        user_id = msg.get('user', 'unknown')
        text = msg.get('text', '')

        # Skip empty messages
        if not text.strip():
            logger.debug(f"Skipping empty message ts={ts}")
            continue

        # Skip already processed
        if state_mgr.is_processed(ts):
            logger.debug(f"Skipping already processed message ts={ts}")
            continue

        # Get user info
        author_name = get_user_info(client, user_id)

        # Convert timestamp to ISO date
        try:
            date_str = datetime.fromtimestamp(float(ts)).isoformat()
        except (ValueError, TypeError):
            date_str = ts

        logger.info(f"New message from {author_name}: {text[:50]}{'...' if len(text) > 50 else ''}")

        # Create kanban task
        tags = ['slack-input', f'author:{author_name.replace(" ", "_")}']
        task_id = create_kanban_task(text, author_name, tags, kanban_script, dry_run)

        if task_id:
            # Record in state
            message_data = {
                'text': text,
                'author': user_id,
                'author_name': author_name,
                'date': date_str,
                'channel': channel_name,
                'channel_id': channel_id,
                'thread_ts': msg.get('thread_ts', ts)
            }

            if not dry_run:
                state_mgr.mark_processed(ts, task_id, message_data)

            processed += 1
        else:
            logger.warning(f"Failed to create task for message ts={ts}")

    return processed


def find_kanban_script(project_dir: Path) -> Optional[str]:
    """Find the kanban.sh script in the project."""
    candidates = [
        project_dir / '.juno_task' / 'scripts' / 'kanban.sh',
        project_dir / 'scripts' / 'kanban.sh',
    ]

    for path in candidates:
        if path.exists():
            return str(path)

    logger.error("Could not find kanban.sh script")
    return None


def main_loop(args: argparse.Namespace) -> int:
    """Main monitoring loop."""
    # Load environment variables
    load_dotenv()

    # Setup logging
    setup_logging(verbose=args.verbose)

    logger.info("=" * 70)
    logger.info("Slack Fetch - Creating kanban tasks from Slack messages")
    logger.info("=" * 70)

    # Validate environment
    bot_token = os.getenv('SLACK_BOT_TOKEN')
    if not bot_token:
        logger.error(
            "SLACK_BOT_TOKEN not found in environment. "
            "Please set it in .env file or environment."
        )
        return 1

    # Get channel from args or env
    channel = args.channel or os.getenv('SLACK_CHANNEL')
    if not channel:
        logger.error("No channel specified. Use --channel or set SLACK_CHANNEL")
        return 1

    # Find project root and kanban script
    project_dir = Path.cwd()
    kanban_script = find_kanban_script(project_dir)
    if not kanban_script:
        logger.error("Cannot find kanban.sh script. Is the project initialized?")
        return 1

    # Initialize Slack client
    logger.info("Initializing Slack client...")
    client = WebClient(token=bot_token)

    # Test connection
    try:
        auth_response = client.auth_test()
        team_name = auth_response.get('team')
        logger.info(f"Connected to Slack workspace: {team_name}")
    except SlackApiError as e:
        logger.error(f"Failed to connect to Slack: {e.response['error']}")
        return 1

    # Resolve channel
    channel_id = get_channel_id(client, channel)
    if not channel_id:
        logger.error(f"Could not find channel '{channel}'. Make sure the bot is invited.")
        return 1

    # Initialize state manager
    state_dir = project_dir / '.juno_task' / 'slack'
    state_file = state_dir / 'slack.ndjson'
    logger.info(f"Initializing state manager: {state_file}")
    state_mgr = SlackStateManager(str(state_file))

    # Get check interval
    check_interval = int(os.getenv('CHECK_INTERVAL_SECONDS', 60))

    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    if args.dry_run:
        logger.info("Running in DRY RUN mode - no tasks will be created")

    logger.info(f"Monitoring channel #{channel} (ID: {channel_id})")
    logger.info(f"Check interval: {check_interval} seconds")
    logger.info(f"Mode: {'once' if args.once else 'continuous'}")
    logger.info("-" * 70)

    # Main loop
    iteration = 0
    total_processed = 0

    while not shutdown_requested:
        iteration += 1
        logger.debug(f"Starting iteration {iteration}")

        try:
            # Get last timestamp
            last_ts = state_mgr.get_last_timestamp()

            # Fetch new messages
            messages = fetch_channel_messages(client, channel_id, oldest_ts=last_ts)

            # Filter out already processed
            new_messages = [m for m in messages if not state_mgr.is_processed(m.get('ts', ''))]

            if new_messages:
                processed = process_messages(
                    new_messages,
                    channel,
                    channel_id,
                    client,
                    state_mgr,
                    kanban_script,
                    dry_run=args.dry_run
                )
                total_processed += processed
                logger.info(f"Processed {processed} messages (total: {total_processed})")
            else:
                logger.debug("No new messages")

            # Exit if --once mode
            if args.once:
                logger.info("--once mode: exiting after single check")
                break

            # Sleep
            if not shutdown_requested:
                logger.debug(f"Sleeping for {check_interval} seconds...")
                time.sleep(check_interval)

        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received")
            break
        except Exception as e:
            logger.error(f"Error in main loop: {e}", exc_info=True)
            if args.once:
                return 1
            time.sleep(check_interval)

    # Shutdown
    logger.info("-" * 70)
    logger.info(f"Shutting down. Created {total_processed} kanban tasks.")
    logger.info(f"Total processed messages: {state_mgr.get_message_count()}")

    return 0


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Fetch Slack messages and create kanban tasks',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --channel bug-reports                # Run once (default)
  %(prog)s --channel feature-requests --continuous  # Continuous monitoring
  %(prog)s --channel general --dry-run --verbose    # Test mode

Environment Variables:
  SLACK_BOT_TOKEN          Slack bot token (required)
  SLACK_CHANNEL            Default channel to monitor
  CHECK_INTERVAL_SECONDS   Polling interval (default: 60)
  LOG_LEVEL               DEBUG, INFO, WARNING, ERROR (default: INFO)

Notes:
  - Messages are tagged with 'slack-input' and 'author:{name}'
  - State is persisted to .juno_task/slack/slack.ndjson
  - Use Ctrl+C for graceful shutdown
        """
    )

    parser.add_argument(
        '--channel',
        help='Slack channel name to monitor (with or without #)'
    )

    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        '--once',
        dest='once',
        action='store_true',
        default=True,
        help='Run once and exit (DEFAULT)'
    )
    mode_group.add_argument(
        '--continuous',
        dest='once',
        action='store_false',
        help='Run continuously with polling'
    )

    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be done without creating tasks'
    )

    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Enable DEBUG level logging'
    )

    args = parser.parse_args()

    try:
        return main_loop(args)
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
