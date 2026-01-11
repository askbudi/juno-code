"""
Unit tests for slack_respond.py - Slack response sender module.

Tests cover:
- Kanban task fetching
- Message matching (by task_id and text)
- Slack response sending
- Environment validation
- Error handling
- Duplicate prevention

Uses mocking to avoid external dependencies (Slack API, subprocess calls).
Note: These tests require slack_sdk and python-dotenv to be installed.
Requires Python 3.9+ due to type hints in the source module.
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch, Mock

import pytest

# Skip all tests if slack_sdk is not installed
slack_sdk = pytest.importorskip("slack_sdk", reason="slack_sdk required for these tests")

# Add the scripts directory to path to import slack_respond
scripts_dir = Path(__file__).parent.parent.parent / '.juno_task' / 'scripts'
if str(scripts_dir) not in sys.path:
    sys.path.insert(0, str(scripts_dir))

from slack_respond import (
    get_kanban_tasks,
    find_matching_message,
    send_slack_response,
    find_kanban_script,
    validate_slack_environment,
)
from slack_state import SlackStateManager
from slack_sdk.errors import SlackApiError


class TestGetKanbanTasks:
    """Tests for get_kanban_tasks function."""

    @patch('subprocess.run')
    def test_fetches_tasks_successfully(self, mock_run):
        """Should fetch and parse kanban tasks."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps([
                {'id': 'task_1', 'body': 'Bug 1', 'agent_response': 'Fixed'},
                {'id': 'task_2', 'body': 'Bug 2', 'agent_response': 'Done'},
            ])
        )

        result = get_kanban_tasks('/path/to/kanban.sh')

        assert len(result) == 2
        assert result[0]['id'] == 'task_1'
        assert result[1]['agent_response'] == 'Done'

    @patch('subprocess.run')
    def test_filters_by_tag(self, mock_run):
        """Should pass tag filter to kanban command."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[]'
        )

        get_kanban_tasks('/path/to/kanban.sh', tag='slack-input')

        call_args = mock_run.call_args[0][0]
        assert '--tag' in call_args
        assert 'slack-input' in call_args

    @patch('subprocess.run')
    def test_filters_by_status(self, mock_run):
        """Should pass status filter to kanban command."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[]'
        )

        get_kanban_tasks('/path/to/kanban.sh', status='done')

        call_args = mock_run.call_args[0][0]
        assert '--status' in call_args
        assert 'done' in call_args

    @patch('subprocess.run')
    def test_handles_subprocess_failure(self, mock_run):
        """Should return empty list on subprocess failure."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stderr='Error'
        )

        result = get_kanban_tasks('/path/to/kanban.sh')

        assert result == []

    @patch('subprocess.run')
    def test_handles_invalid_json(self, mock_run):
        """Should return empty list on invalid JSON output."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='not valid json'
        )

        result = get_kanban_tasks('/path/to/kanban.sh')

        assert result == []

    @patch('subprocess.run')
    def test_handles_timeout(self, mock_run):
        """Should return empty list on timeout."""
        mock_run.side_effect = subprocess.TimeoutExpired('kanban', 30)

        result = get_kanban_tasks('/path/to/kanban.sh')

        assert result == []


class TestFindMatchingMessage:
    """Tests for find_matching_message function."""

    def test_finds_by_task_id(self):
        """Should find message by task_id lookup."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            state_mgr = SlackStateManager(state_file)
            state_mgr.mark_processed('ts1', 'task_1', {
                'text': 'Bug report',
                'author': 'user1',
                'channel_id': 'C123'
            })

            task = {'id': 'task_1', 'body': 'Bug report'}

            result = find_matching_message(task, state_mgr)

            assert result is not None
            assert result['ts'] == 'ts1'
            assert result['task_id'] == 'task_1'
        finally:
            os.unlink(state_file)

    def test_finds_by_text_match_exact(self):
        """Should find message by exact text match as fallback."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            state_mgr = SlackStateManager(state_file)
            state_mgr.mark_processed('ts1', 'different_task', {
                'text': 'Bug report',
                'channel_id': 'C123'
            })

            # Task with different ID but matching body
            task = {'id': 'unknown_task', 'body': 'Bug report'}

            result = find_matching_message(task, state_mgr)

            assert result is not None
            assert result['ts'] == 'ts1'
        finally:
            os.unlink(state_file)

    def test_finds_by_text_prefix_match(self):
        """Should find message by text prefix match."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            state_mgr = SlackStateManager(state_file)
            state_mgr.mark_processed('ts1', 'some_task', {
                'text': 'Bug report: something is broken',
                'channel_id': 'C123'
            })

            # Task body starts with message text
            task = {'id': 'unknown', 'body': 'Bug report: something is broken and more details here'}

            result = find_matching_message(task, state_mgr)

            assert result is not None
            assert result['ts'] == 'ts1'
        finally:
            os.unlink(state_file)

    def test_returns_none_if_no_match(self):
        """Should return None if no matching message found."""
        with tempfile.NamedTemporaryFile(suffix='.ndjson', delete=False) as f:
            state_file = f.name

        try:
            state_mgr = SlackStateManager(state_file)
            state_mgr.mark_processed('ts1', 'task_1', {
                'text': 'First message',
                'channel_id': 'C123'
            })

            task = {'id': 'task_999', 'body': 'Completely different text'}

            result = find_matching_message(task, state_mgr)

            assert result is None
        finally:
            os.unlink(state_file)


class TestSendSlackResponse:
    """Tests for send_slack_response function."""

    def test_dry_run_returns_ts(self):
        """Dry run should return placeholder timestamp without API call."""
        client = MagicMock()

        result = send_slack_response(
            client,
            'C123456',
            'ts1',
            'task_1',
            'This is the response',
            dry_run=True
        )

        assert result == 'dry-run-ts'
        client.chat_postMessage.assert_not_called()

    def test_sends_threaded_response(self):
        """Should send response as threaded reply."""
        client = MagicMock()
        client.chat_postMessage.return_value = {
            'ok': True,
            'ts': 'response_ts_123'
        }

        result = send_slack_response(
            client,
            'C123456',
            'ts1',
            'task_1',
            'This is the response',
            dry_run=False
        )

        assert result == 'response_ts_123'
        client.chat_postMessage.assert_called_once()

        call_kwargs = client.chat_postMessage.call_args[1]
        assert call_kwargs['channel'] == 'C123456'
        assert call_kwargs['thread_ts'] == 'ts1'
        assert 'task_1' in call_kwargs['text']
        assert 'This is the response' in call_kwargs['text']

    def test_handles_api_error(self):
        """Should return None on API error."""
        client = MagicMock()
        client.chat_postMessage.side_effect = SlackApiError(
            message="channel_not_found",
            response={'error': 'channel_not_found'}
        )

        result = send_slack_response(
            client,
            'C123456',
            'ts1',
            'task_1',
            'Response',
            dry_run=False
        )

        assert result is None

    def test_handles_rate_limit(self):
        """Should return None on rate limit."""
        client = MagicMock()
        error_response = MagicMock()
        error_response.headers = {'Retry-After': '60'}
        error_response.get.return_value = 'ratelimited'
        client.chat_postMessage.side_effect = SlackApiError(
            message="ratelimited",
            response=error_response
        )

        result = send_slack_response(
            client,
            'C123456',
            'ts1',
            'task_1',
            'Response',
            dry_run=False
        )

        assert result is None


class TestFindKanbanScript:
    """Tests for find_kanban_script function."""

    def test_finds_script_in_juno_task(self):
        """Should find kanban.sh in .juno_task/scripts."""
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)
            scripts_dir = project_dir / '.juno_task' / 'scripts'
            scripts_dir.mkdir(parents=True)
            kanban_script = scripts_dir / 'kanban.sh'
            kanban_script.touch()

            result = find_kanban_script(project_dir)

            assert result == str(kanban_script)

    def test_returns_none_if_not_found(self):
        """Should return None if script not found."""
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = Path(tmpdir)

            result = find_kanban_script(project_dir)

            assert result is None


class TestValidateSlackEnvironment:
    """Tests for validate_slack_environment function."""

    def test_valid_token(self):
        """Should pass with valid bot token."""
        with patch.dict(os.environ, {'SLACK_BOT_TOKEN': 'xoxb-valid-token'}, clear=False):
            token, errors = validate_slack_environment()

            assert token == 'xoxb-valid-token'
            assert errors == []

    def test_missing_token(self):
        """Should error if token missing."""
        orig_token = os.environ.pop('SLACK_BOT_TOKEN', None)
        try:
            token, errors = validate_slack_environment()

            assert token is None
            assert len(errors) > 0
            assert 'SLACK_BOT_TOKEN not found' in errors[0]
        finally:
            if orig_token:
                os.environ['SLACK_BOT_TOKEN'] = orig_token

    def test_invalid_token_format(self):
        """Should error if token doesn't start with xoxb-."""
        with patch.dict(os.environ, {'SLACK_BOT_TOKEN': 'invalid-token'}, clear=False):
            token, errors = validate_slack_environment()

            assert len(errors) > 0
            assert 'xoxb-' in errors[0]


class TestSlackRespondIntegration:
    """Integration tests simulating respond workflow."""

    def test_full_respond_workflow(self):
        """Test full workflow: match task -> send response -> track sent."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from slack_state import ResponseStateManager

            # Setup state files
            state_dir = Path(tmpdir) / '.juno_task' / 'slack'
            state_dir.mkdir(parents=True)

            slack_state = SlackStateManager(str(state_dir / 'slack.ndjson'))
            response_state = ResponseStateManager(str(state_dir / 'responses.ndjson'))

            # Add some messages
            slack_state.mark_processed('ts1', 'task_1', {
                'text': 'Bug #1',
                'channel_id': 'C123456',
                'thread_ts': 'ts1'
            })
            slack_state.mark_processed('ts2', 'task_2', {
                'text': 'Bug #2',
                'channel_id': 'C123456',
                'thread_ts': 'ts2'
            })

            # Simulate tasks with responses
            tasks = [
                {'id': 'task_1', 'body': 'Bug #1', 'agent_response': 'Fixed bug #1'},
                {'id': 'task_2', 'body': 'Bug #2', 'agent_response': 'Fixed bug #2'},
            ]

            # Mock client
            client = MagicMock()
            client.chat_postMessage.return_value = {
                'ok': True,
                'ts': 'response_ts'
            }

            # Process tasks
            sent_count = 0
            for task in tasks:
                msg = find_matching_message(task, slack_state)
                if msg and not response_state.was_response_sent(task['id'], msg['ts']):
                    result = send_slack_response(
                        client,
                        msg['channel_id'],
                        msg.get('thread_ts', msg['ts']),
                        task['id'],
                        task['agent_response'],
                        dry_run=False
                    )
                    if result:
                        response_state.record_sent(
                            task['id'],
                            msg['ts'],
                            msg['channel_id'],
                            result
                        )
                        sent_count += 1

            assert sent_count == 2
            assert response_state.get_sent_count() == 2

            # Running again should not re-send
            sent_again = 0
            for task in tasks:
                msg = find_matching_message(task, slack_state)
                if msg and not response_state.was_response_sent(task['id'], msg['ts']):
                    sent_again += 1

            assert sent_again == 0

    def test_workflow_with_no_response(self):
        """Tasks without agent_response should be skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from slack_state import ResponseStateManager

            state_dir = Path(tmpdir) / '.juno_task' / 'slack'
            state_dir.mkdir(parents=True)

            slack_state = SlackStateManager(str(state_dir / 'slack.ndjson'))
            response_state = ResponseStateManager(str(state_dir / 'responses.ndjson'))

            slack_state.mark_processed('ts1', 'task_1', {
                'text': 'Bug #1',
                'channel_id': 'C123456'
            })

            # Task with no response
            tasks = [
                {'id': 'task_1', 'body': 'Bug #1', 'agent_response': ''},
                {'id': 'task_2', 'body': 'Bug #2', 'agent_response': 'null'},
            ]

            processed = 0
            for task in tasks:
                if not task['agent_response'] or task['agent_response'] == 'null':
                    continue
                msg = find_matching_message(task, slack_state)
                if msg:
                    processed += 1

            assert processed == 0


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
