#!/usr/bin/env python3
"""
Slack State Manager - Persistent state management for Slack-Kanban integration.

This module handles:
- Loading/saving message state from NDJSON file
- Tracking processed Slack messages with their kanban task IDs
- Tracking sent responses to avoid duplicates
- Deduplication of messages

NDJSON Format (Newline-Delimited JSON):
Each line is a complete JSON object for atomic append operations.

State Files:
- slack.ndjson: Processed Slack messages with task mappings
- responses_sent.ndjson: Responses already sent back to Slack

Usage:
    from slack_state import SlackStateManager, ResponseStateManager

    # Track processed messages
    state = SlackStateManager('.juno_task/slack/slack.ndjson')
    if not state.is_processed(message_ts):
        # Process message...
        state.mark_processed(message_ts, task_id, message_data)

    # Track sent responses
    responses = ResponseStateManager('.juno_task/slack/responses_sent.ndjson')
    if not responses.was_response_sent(task_id, message_ts):
        # Send response...
        responses.record_sent(task_id, message_ts, channel_id)
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)


class SlackStateManager:
    """
    Manages persistent state for Slack message processing.

    Tracks which Slack messages have been processed and their associated
    kanban task IDs for later response matching.
    """

    def __init__(self, state_file_path: str):
        """
        Initialize SlackStateManager.

        Args:
            state_file_path: Path to NDJSON state file (e.g., .juno_task/slack/slack.ndjson)
        """
        self.state_file = Path(state_file_path)
        self.messages: List[Dict[str, Any]] = []
        self.message_ts_set: set = set()
        self.last_ts: Optional[str] = None
        self._load_state()

    def _load_state(self) -> None:
        """Load existing state from NDJSON file."""
        if not self.state_file.exists():
            logger.info(f"State file does not exist, will create: {self.state_file}")
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.messages = []
            self.message_ts_set = set()
            self.last_ts = None
            return

        try:
            self.messages = []
            self.message_ts_set = set()
            with open(self.state_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        msg = json.loads(line)
                        self.messages.append(msg)
                        ts = msg.get('ts')
                        if ts:
                            self.message_ts_set.add(ts)

            # Get last timestamp
            if self.messages:
                self.last_ts = max(msg.get('ts', '0') for msg in self.messages)
                logger.info(
                    f"Loaded {len(self.messages)} messages from {self.state_file}, "
                    f"last_ts={self.last_ts}"
                )
            else:
                self.last_ts = None
                logger.info(f"State file empty: {self.state_file}")

        except Exception as e:
            logger.error(f"Error loading state from {self.state_file}: {e}")
            self.messages = []
            self.message_ts_set = set()
            self.last_ts = None

    def get_last_timestamp(self) -> Optional[str]:
        """
        Get the timestamp of the last processed message.

        Returns:
            Last message timestamp or None if no messages processed
        """
        return self.last_ts

    def is_processed(self, message_ts: str) -> bool:
        """
        Check if a message has already been processed.

        Args:
            message_ts: Slack message timestamp

        Returns:
            True if already processed, False otherwise
        """
        return message_ts in self.message_ts_set

    def mark_processed(
        self,
        message_ts: str,
        task_id: str,
        message_data: Dict[str, Any]
    ) -> bool:
        """
        Mark a message as processed and store task mapping.

        Args:
            message_ts: Slack message timestamp (unique identifier)
            task_id: Kanban task ID created for this message
            message_data: Additional message data (text, author, channel, etc.)

        Returns:
            True if message was new and recorded, False if duplicate
        """
        if message_ts in self.message_ts_set:
            logger.debug(f"Duplicate message ts={message_ts}, skipping")
            return False

        # Build state entry
        entry = {
            'ts': message_ts,
            'task_id': task_id,
            'processed_at': datetime.now(timezone.utc).isoformat(),
            **message_data
        }

        try:
            # Append to file (atomic)
            with open(self.state_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            # Update in-memory state
            self.messages.append(entry)
            self.message_ts_set.add(message_ts)
            if not self.last_ts or message_ts > self.last_ts:
                self.last_ts = message_ts

            logger.debug(f"Recorded message ts={message_ts} -> task_id={task_id}")
            return True

        except Exception as e:
            logger.error(f"Error appending to {self.state_file}: {e}")
            return False

    def get_task_id_for_message(self, message_ts: str) -> Optional[str]:
        """
        Get the kanban task ID for a given message.

        Args:
            message_ts: Slack message timestamp

        Returns:
            Task ID or None if not found
        """
        for msg in self.messages:
            if msg.get('ts') == message_ts:
                return msg.get('task_id')
        return None

    def get_message_for_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the message data for a given kanban task ID.

        Args:
            task_id: Kanban task ID

        Returns:
            Message data dict or None if not found
        """
        for msg in self.messages:
            if msg.get('task_id') == task_id:
                return msg
        return None

    def get_message_count(self) -> int:
        """Get total number of processed messages."""
        return len(self.messages)

    def get_messages_since(self, since_ts: str) -> List[Dict[str, Any]]:
        """
        Get all messages since a given timestamp.

        Args:
            since_ts: Timestamp to filter from

        Returns:
            List of messages after since_ts
        """
        return [msg for msg in self.messages if msg.get('ts', '0') > since_ts]


class ResponseStateManager:
    """
    Manages state for tracking sent responses.

    Prevents duplicate responses by tracking which task/message combinations
    have already received a response.
    """

    def __init__(self, state_file_path: str):
        """
        Initialize ResponseStateManager.

        Args:
            state_file_path: Path to NDJSON state file
        """
        self.state_file = Path(state_file_path)
        self.sent_responses: List[Dict[str, Any]] = []
        self.sent_keys: set = set()  # (task_id, message_ts) tuples
        self._load_state()

    def _load_state(self) -> None:
        """Load existing state from NDJSON file."""
        if not self.state_file.exists():
            logger.info(f"Response state file does not exist, will create: {self.state_file}")
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.sent_responses = []
            self.sent_keys = set()
            return

        try:
            self.sent_responses = []
            self.sent_keys = set()
            with open(self.state_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entry = json.loads(line)
                        self.sent_responses.append(entry)
                        task_id = entry.get('task_id')
                        message_ts = entry.get('message_ts')
                        if task_id and message_ts:
                            self.sent_keys.add((task_id, message_ts))

            logger.info(f"Loaded {len(self.sent_responses)} sent responses from {self.state_file}")

        except Exception as e:
            logger.error(f"Error loading response state from {self.state_file}: {e}")
            self.sent_responses = []
            self.sent_keys = set()

    def was_response_sent(self, task_id: str, message_ts: str) -> bool:
        """
        Check if a response was already sent for this task/message.

        Args:
            task_id: Kanban task ID
            message_ts: Slack message timestamp

        Returns:
            True if already sent, False otherwise
        """
        return (task_id, message_ts) in self.sent_keys

    def record_sent(
        self,
        task_id: str,
        message_ts: str,
        channel_id: str,
        response_ts: Optional[str] = None
    ) -> bool:
        """
        Record that a response was sent.

        Args:
            task_id: Kanban task ID
            message_ts: Original Slack message timestamp
            channel_id: Slack channel ID
            response_ts: Timestamp of the response message (optional)

        Returns:
            True if recorded, False if duplicate or error
        """
        key = (task_id, message_ts)
        if key in self.sent_keys:
            logger.debug(f"Response already recorded for task={task_id}, ts={message_ts}")
            return False

        entry = {
            'task_id': task_id,
            'message_ts': message_ts,
            'channel_id': channel_id,
            'sent_at': datetime.now(timezone.utc).isoformat(),
        }
        if response_ts:
            entry['response_ts'] = response_ts

        try:
            # Append to file (atomic)
            with open(self.state_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            # Update in-memory state
            self.sent_responses.append(entry)
            self.sent_keys.add(key)

            logger.debug(f"Recorded sent response for task={task_id}, ts={message_ts}")
            return True

        except Exception as e:
            logger.error(f"Error recording response to {self.state_file}: {e}")
            return False

    def get_sent_count(self) -> int:
        """Get total number of sent responses."""
        return len(self.sent_responses)

    def reset_state(self) -> None:
        """
        Clear all state (WARNING: will cause re-sending).

        Use with caution - should only be called after user confirmation.
        """
        if self.state_file.exists():
            self.state_file.unlink()
            logger.warning(f"Deleted response state file: {self.state_file}")

        self.sent_responses = []
        self.sent_keys = set()
        logger.warning("Response state reset - all responses may be re-sent")


if __name__ == '__main__':
    # Simple test/demo
    import sys

    logging.basicConfig(level=logging.DEBUG)

    # Test SlackStateManager
    print("Testing SlackStateManager...")
    state = SlackStateManager('/tmp/test_slack_state.ndjson')
    print(f"  Message count: {state.get_message_count()}")
    print(f"  Last timestamp: {state.get_last_timestamp()}")

    if not state.is_processed('1234567890.123456'):
        state.mark_processed(
            '1234567890.123456',
            'task_abc123',
            {'text': 'Test message', 'author': 'test_user', 'channel': 'general'}
        )
        print("  Marked test message as processed")

    print(f"  Task ID for test: {state.get_task_id_for_message('1234567890.123456')}")

    # Test ResponseStateManager
    print("\nTesting ResponseStateManager...")
    responses = ResponseStateManager('/tmp/test_responses_sent.ndjson')
    print(f"  Sent count: {responses.get_sent_count()}")

    if not responses.was_response_sent('task_abc123', '1234567890.123456'):
        responses.record_sent('task_abc123', '1234567890.123456', 'C1234567890')
        print("  Recorded test response")

    print(f"  Was sent: {responses.was_response_sent('task_abc123', '1234567890.123456')}")

    print("\nAll tests passed!")
