"""
Unit tests for slack_state.py - Slack State Manager module.

Tests cover:
- SlackStateManager: Loading/saving message state, deduplication, task mapping
- ResponseStateManager: Tracking sent responses, preventing duplicates, state reset

These tests use temporary files to avoid any persistent state pollution.
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Add the scripts directory to path to import slack_state
scripts_dir = Path(__file__).parent.parent.parent / '.juno_task' / 'scripts'
if str(scripts_dir) not in sys.path:
    sys.path.insert(0, str(scripts_dir))

from slack_state import SlackStateManager, ResponseStateManager


class TestSlackStateManager:
    """Tests for SlackStateManager class."""

    def test_init_creates_directory_if_missing(self):
        """StateManager should create parent directory if it doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = os.path.join(tmpdir, 'subdir', 'nested', 'state.ndjson')
            mgr = SlackStateManager(state_file)

            assert os.path.isdir(os.path.dirname(state_file))
            assert mgr.get_message_count() == 0
            assert mgr.get_last_timestamp() is None

    def test_init_empty_state_file(self):
        """StateManager with non-existent file should have empty state."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=True) as f:
            state_file = f.name

        # File doesn't exist yet
        mgr = SlackStateManager(state_file)

        assert mgr.get_message_count() == 0
        assert mgr.get_last_timestamp() is None
        assert mgr.is_processed('any_ts') is False

    def test_mark_processed_adds_message(self):
        """mark_processed should add message to state."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            result = mgr.mark_processed(
                '1234567890.123456',
                'task_abc',
                {'text': 'Hello', 'author': 'user123', 'channel': 'general'}
            )

            assert result is True
            assert mgr.get_message_count() == 1
            assert mgr.is_processed('1234567890.123456') is True
            assert mgr.get_last_timestamp() == '1234567890.123456'
        finally:
            os.unlink(state_file)

    def test_mark_processed_prevents_duplicates(self):
        """mark_processed should return False for duplicate messages."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            # First call succeeds
            result1 = mgr.mark_processed(
                '1234567890.123456',
                'task_abc',
                {'text': 'Hello'}
            )
            assert result1 is True

            # Second call with same ts returns False
            result2 = mgr.mark_processed(
                '1234567890.123456',
                'task_def',
                {'text': 'World'}
            )
            assert result2 is False
            assert mgr.get_message_count() == 1  # Still only one message
        finally:
            os.unlink(state_file)

    def test_get_task_id_for_message(self):
        """get_task_id_for_message should return correct task ID."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            mgr.mark_processed('ts1', 'task_1', {'text': 'First'})
            mgr.mark_processed('ts2', 'task_2', {'text': 'Second'})

            assert mgr.get_task_id_for_message('ts1') == 'task_1'
            assert mgr.get_task_id_for_message('ts2') == 'task_2'
            assert mgr.get_task_id_for_message('ts3') is None
        finally:
            os.unlink(state_file)

    def test_get_message_for_task(self):
        """get_message_for_task should return correct message data."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            mgr.mark_processed('ts1', 'task_1', {'text': 'First', 'author': 'alice'})
            mgr.mark_processed('ts2', 'task_2', {'text': 'Second', 'author': 'bob'})

            msg = mgr.get_message_for_task('task_1')
            assert msg is not None
            assert msg['text'] == 'First'
            assert msg['author'] == 'alice'
            assert msg['task_id'] == 'task_1'

            msg2 = mgr.get_message_for_task('task_999')
            assert msg2 is None
        finally:
            os.unlink(state_file)

    def test_get_messages_since(self):
        """get_messages_since should filter messages by timestamp."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            mgr.mark_processed('1000.000', 'task_1', {'text': 'Old'})
            mgr.mark_processed('2000.000', 'task_2', {'text': 'Middle'})
            mgr.mark_processed('3000.000', 'task_3', {'text': 'New'})

            # Get messages since 1500.000
            messages = mgr.get_messages_since('1500.000')

            assert len(messages) == 2
            assert all(m['ts'] > '1500.000' for m in messages)
        finally:
            os.unlink(state_file)

    def test_last_timestamp_tracks_max(self):
        """last_timestamp should track the maximum timestamp."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)

            mgr.mark_processed('2000.000', 'task_2', {'text': 'Middle'})
            assert mgr.get_last_timestamp() == '2000.000'

            mgr.mark_processed('1000.000', 'task_1', {'text': 'Old'})
            assert mgr.get_last_timestamp() == '2000.000'  # Still 2000

            mgr.mark_processed('3000.000', 'task_3', {'text': 'New'})
            assert mgr.get_last_timestamp() == '3000.000'
        finally:
            os.unlink(state_file)

    def test_persistence_across_instances(self):
        """State should persist across StateManager instances."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            # First instance writes
            mgr1 = SlackStateManager(state_file)
            mgr1.mark_processed('ts1', 'task_1', {'text': 'Hello'})
            mgr1.mark_processed('ts2', 'task_2', {'text': 'World'})

            # Second instance should read persisted state
            mgr2 = SlackStateManager(state_file)

            assert mgr2.get_message_count() == 2
            assert mgr2.is_processed('ts1') is True
            assert mgr2.is_processed('ts2') is True
            assert mgr2.get_task_id_for_message('ts1') == 'task_1'
        finally:
            os.unlink(state_file)

    def test_ndjson_format_valid(self):
        """State file should be valid NDJSON format."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = SlackStateManager(state_file)
            mgr.mark_processed('ts1', 'task_1', {'text': 'Line1'})
            mgr.mark_processed('ts2', 'task_2', {'text': 'Line2'})

            # Read raw file and verify NDJSON format
            with open(state_file, 'r') as f:
                lines = f.readlines()

            assert len(lines) == 2

            # Each line should be valid JSON
            for line in lines:
                data = json.loads(line)
                assert 'ts' in data
                assert 'task_id' in data
                assert 'processed_at' in data
        finally:
            os.unlink(state_file)

    def test_handles_corrupted_file_gracefully(self):
        """StateManager should handle corrupted files gracefully."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', mode='w', delete=False) as f:
            # Write some valid lines and one invalid
            f.write('{"ts": "ts1", "task_id": "task1"}\n')
            f.write('not valid json\n')
            f.write('{"ts": "ts2", "task_id": "task2"}\n')
            state_file = f.name

        try:
            # Should not crash, but state will be empty due to error
            mgr = SlackStateManager(state_file)
            # After encountering error, state is reset
            # The current implementation loads what it can before error
            # In practice, corruption handling resets state
            assert mgr is not None
        finally:
            os.unlink(state_file)


class TestResponseStateManager:
    """Tests for ResponseStateManager class."""

    def test_init_creates_directory_if_missing(self):
        """ResponseStateManager should create parent directory if needed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = os.path.join(tmpdir, 'subdir', 'responses.ndjson')
            mgr = ResponseStateManager(state_file)

            assert os.path.isdir(os.path.dirname(state_file))
            assert mgr.get_sent_count() == 0

    def test_was_response_sent_false_initially(self):
        """was_response_sent should return False for new combinations."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=True) as f:
            state_file = f.name

        mgr = ResponseStateManager(state_file)

        assert mgr.was_response_sent('task_1', 'ts_1') is False
        assert mgr.was_response_sent('task_2', 'ts_2') is False

    def test_record_sent_marks_as_sent(self):
        """record_sent should mark combination as sent."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)

            result = mgr.record_sent('task_1', 'ts_1', 'C123456')

            assert result is True
            assert mgr.was_response_sent('task_1', 'ts_1') is True
            assert mgr.get_sent_count() == 1
        finally:
            os.unlink(state_file)

    def test_record_sent_prevents_duplicates(self):
        """record_sent should return False for duplicate records."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)

            result1 = mgr.record_sent('task_1', 'ts_1', 'C123456')
            assert result1 is True

            result2 = mgr.record_sent('task_1', 'ts_1', 'C123456')
            assert result2 is False

            assert mgr.get_sent_count() == 1
        finally:
            os.unlink(state_file)

    def test_record_sent_with_response_ts(self):
        """record_sent should include response_ts when provided."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)

            mgr.record_sent('task_1', 'ts_1', 'C123456', 'response_ts_123')

            # Read and verify
            with open(state_file, 'r') as f:
                data = json.loads(f.readline())

            assert data['response_ts'] == 'response_ts_123'
        finally:
            os.unlink(state_file)

    def test_different_task_message_combinations(self):
        """Different task/message combinations should be tracked separately."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)

            mgr.record_sent('task_1', 'ts_1', 'C123456')
            mgr.record_sent('task_1', 'ts_2', 'C123456')  # Same task, different message
            mgr.record_sent('task_2', 'ts_1', 'C123456')  # Different task, same message

            assert mgr.get_sent_count() == 3
            assert mgr.was_response_sent('task_1', 'ts_1') is True
            assert mgr.was_response_sent('task_1', 'ts_2') is True
            assert mgr.was_response_sent('task_2', 'ts_1') is True
            assert mgr.was_response_sent('task_2', 'ts_2') is False
        finally:
            os.unlink(state_file)

    def test_reset_state_clears_all(self):
        """reset_state should clear all state and delete file."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)

            mgr.record_sent('task_1', 'ts_1', 'C123456')
            mgr.record_sent('task_2', 'ts_2', 'C789012')

            assert mgr.get_sent_count() == 2

            mgr.reset_state()

            assert mgr.get_sent_count() == 0
            assert mgr.was_response_sent('task_1', 'ts_1') is False
            assert not os.path.exists(state_file)
        except Exception:
            # Cleanup in case of failure
            if os.path.exists(state_file):
                os.unlink(state_file)
            raise

    def test_persistence_across_instances(self):
        """Response state should persist across manager instances."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            # First instance
            mgr1 = ResponseStateManager(state_file)
            mgr1.record_sent('task_1', 'ts_1', 'C123456')
            mgr1.record_sent('task_2', 'ts_2', 'C789012')

            # Second instance should see persisted state
            mgr2 = ResponseStateManager(state_file)

            assert mgr2.get_sent_count() == 2
            assert mgr2.was_response_sent('task_1', 'ts_1') is True
            assert mgr2.was_response_sent('task_2', 'ts_2') is True
        finally:
            os.unlink(state_file)

    def test_ndjson_format_valid(self):
        """Response state file should be valid NDJSON format."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            mgr = ResponseStateManager(state_file)
            mgr.record_sent('task_1', 'ts_1', 'C123456', 'resp_1')
            mgr.record_sent('task_2', 'ts_2', 'C789012')

            with open(state_file, 'r') as f:
                lines = f.readlines()

            assert len(lines) == 2

            for line in lines:
                data = json.loads(line)
                assert 'task_id' in data
                assert 'message_ts' in data
                assert 'channel_id' in data
                assert 'sent_at' in data
        finally:
            os.unlink(state_file)


class TestStateManagerIntegration:
    """Integration tests for SlackStateManager and ResponseStateManager together."""

    def test_workflow_fetch_then_respond(self):
        """Simulate fetch -> process -> respond workflow."""
        with tempfile.TemporaryDirectory() as tmpdir:
            slack_state_file = os.path.join(tmpdir, 'slack.ndjson')
            response_state_file = os.path.join(tmpdir, 'responses.ndjson')

            # Initialize managers
            slack_mgr = SlackStateManager(slack_state_file)
            response_mgr = ResponseStateManager(response_state_file)

            # Simulate fetch: process incoming messages
            messages = [
                {'ts': 'ts_1', 'text': 'Bug report 1', 'author': 'user1', 'channel_id': 'C123'},
                {'ts': 'ts_2', 'text': 'Feature request', 'author': 'user2', 'channel_id': 'C123'},
            ]

            for msg in messages:
                task_id = f"task_{msg['ts']}"
                slack_mgr.mark_processed(
                    msg['ts'],
                    task_id,
                    {
                        'text': msg['text'],
                        'author': msg['author'],
                        'channel_id': msg['channel_id'],
                        'thread_ts': msg['ts']
                    }
                )

            assert slack_mgr.get_message_count() == 2

            # Simulate respond: send responses for completed tasks
            completed_tasks = [
                {'id': 'task_ts_1', 'agent_response': 'Fixed!'},
                {'id': 'task_ts_2', 'agent_response': 'Noted.'},
            ]

            for task in completed_tasks:
                msg = slack_mgr.get_message_for_task(task['id'])
                if msg and not response_mgr.was_response_sent(task['id'], msg['ts']):
                    # Would send to Slack here
                    response_mgr.record_sent(
                        task['id'],
                        msg['ts'],
                        msg['channel_id']
                    )

            assert response_mgr.get_sent_count() == 2

            # Verify idempotency: running again should not re-send
            for task in completed_tasks:
                msg = slack_mgr.get_message_for_task(task['id'])
                assert response_mgr.was_response_sent(task['id'], msg['ts']) is True


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
