#!/usr/bin/env python3
"""
GitHub Integration for juno-code - Bidirectional workflow between GitHub Issues and Kanban.

This script provides a unified interface for syncing GitHub Issues with the juno-code
kanban system. It uses tag-based identification (tag_id) for reliable task-to-issue mapping.

Features:
- Fetch GitHub issues and create kanban tasks with automatic tagging
- Respond to issues by posting comments when kanban tasks are completed
- Bidirectional sync (fetch + respond) with optional continuous monitoring
- Persistent state tracking (NDJSON-based) to prevent duplicate processing
- Tag-based identification using tag_id for O(1) lookups (no fuzzy matching)
- Environment-based configuration with secure token management
- File attachment downloading (saves to .juno_task/attachments/github/)

Usage:
    python github.py fetch --repo owner/repo
    python github.py fetch --repo owner/repo --download-attachments
    python github.py respond --tag github-input
    python github.py sync --repo owner/repo --once

Environment Variables:
    GITHUB_TOKEN                GitHub personal access token (required)
    GITHUB_REPO                 Default repository (format: owner/repo)
    JUNO_DOWNLOAD_ATTACHMENTS   Enable/disable file downloads (default: true)
    JUNO_MAX_ATTACHMENT_SIZE    Max file size in bytes (default: 50MB)

Version: 1.0.0
Package: juno-code@1.x.x
Auto-installed by: ScriptInstaller
"""

import argparse
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple

__version__ = "1.0.0"

# Try importing required dependencies
try:
    import requests
    from dotenv import load_dotenv
except ImportError as e:
    print(f"Error: Missing required dependencies: {e}")
    print("Please run: pip install requests python-dotenv")
    sys.exit(1)

# Global shutdown flag
shutdown_requested = False

# Configure logging
logger = logging.getLogger(__name__)

# Import attachment downloader for file handling
script_dir = Path(__file__).parent
sys.path.insert(0, str(script_dir))

try:
    from attachment_downloader import (
        AttachmentDownloader,
        format_attachments_section,
        is_attachments_enabled
    )
    ATTACHMENTS_AVAILABLE = True
except ImportError:
    ATTACHMENTS_AVAILABLE = False
    # Define stub functions if attachment_downloader not available
    def is_attachments_enabled():
        return False
    def format_attachments_section(paths):
        return ""


# =============================================================================
# GitHub Attachment URL Patterns
# =============================================================================

# Regex patterns to extract attachment URLs from issue body and comments
GITHUB_ATTACHMENT_PATTERNS = [
    # GitHub user-attachments/files (file uploads with numeric ID)
    r'https://github\.com/user-attachments/files/\d+/[^\s\)\"\'\]]+',
    # GitHub user-attachments/assets (new format with UUID)
    r'https://github\.com/user-attachments/assets/[a-f0-9-]+/[^\s\)\"\'\]]+',
    # User images (screenshots, drag-drop uploads)
    r'https://user-images\.githubusercontent\.com/\d+/[^\s\)\"\'\]]+',
    # Private user images
    r'https://private-user-images\.githubusercontent\.com/\d+/[^\s\)\"\'\]]+',
    # Repository assets
    r'https://github\.com/[^/]+/[^/]+/assets/\d+/[^\s\)\"\'\]]+',
    # Objects storage
    r'https://objects\.githubusercontent\.com/[^\s\)\"\'\]]+',
]


# =============================================================================
# State Management Classes
# =============================================================================

class GitHubStateManager:
    """
    Manages persistent state for GitHub issue processing.

    Tracks which GitHub issues have been processed and their associated
    kanban task IDs using tag_id for fast O(1) lookup.
    """

    def __init__(self, state_file_path: str):
        """
        Initialize GitHubStateManager.

        Args:
            state_file_path: Path to NDJSON state file (e.g., .juno_task/github/state.ndjson)
        """
        self.state_file = Path(state_file_path)
        self.issues: Dict[str, Dict[str, Any]] = {}  # Keyed by tag_id
        self._load_state()

    def _load_state(self) -> None:
        """Load existing state from NDJSON file."""
        if not self.state_file.exists():
            logger.info(f"State file does not exist, will create: {self.state_file}")
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.issues = {}
            return

        try:
            self.issues = {}
            with open(self.state_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        issue = json.loads(line)
                        tag_id = issue.get('tag_id')
                        if tag_id:
                            self.issues[tag_id] = issue

            logger.info(f"Loaded {len(self.issues)} issues from {self.state_file}")

        except Exception as e:
            logger.error(f"Error loading state from {self.state_file}: {e}")
            self.issues = {}

    def is_processed(self, issue_number: int, repo: str) -> bool:
        """
        Check if issue already processed.

        Args:
            issue_number: GitHub issue number
            repo: Repository in format "owner/repo"

        Returns:
            True if already processed, False otherwise
        """
        tag_id = self._make_tag_id(issue_number, repo)
        return tag_id in self.issues

    def mark_processed(self, issue_data: Dict[str, Any], task_id: str) -> bool:
        """
        Mark issue as processed, store task mapping.

        Args:
            issue_data: Issue data dict with keys: issue_number, repo, title, body, etc.
            task_id: Kanban task ID created for this issue

        Returns:
            True if recorded successfully, False otherwise
        """
        tag_id = self._make_tag_id(issue_data['issue_number'], issue_data['repo'])

        entry = {
            **issue_data,
            'task_id': task_id,
            'tag_id': tag_id,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }

        try:
            # Append to file (atomic)
            with open(self.state_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            # Update in-memory state
            self.issues[tag_id] = entry
            logger.debug(f"Recorded issue #{issue_data['issue_number']} -> task_id={task_id}, tag_id={tag_id}")
            return True

        except Exception as e:
            logger.error(f"Error appending to {self.state_file}: {e}")
            return False

    def get_issue_for_task(self, tag_id: str) -> Optional[Dict[str, Any]]:
        """
        Get issue data by tag_id (O(1) lookup).

        Args:
            tag_id: Tag identifier (e.g., "github_issue_owner_repo_123")

        Returns:
            Issue data dict or None if not found
        """
        return self.issues.get(tag_id)

    def get_last_update_timestamp(self, repo: str) -> Optional[str]:
        """
        Get the most recent updated_at for incremental sync.

        Args:
            repo: Repository in format "owner/repo"

        Returns:
            ISO 8601 timestamp or None if no issues for this repo
        """
        repo_issues = [i for i in self.issues.values() if i['repo'] == repo]
        if not repo_issues:
            return None
        return max(i['updated_at'] for i in repo_issues)

    def get_issue_count(self) -> int:
        """Get total number of processed issues."""
        return len(self.issues)

    @staticmethod
    def _make_tag_id(issue_number: int, repo: str) -> str:
        """
        Generate tag_id: github_issue_owner_repo_123

        Args:
            issue_number: GitHub issue number
            repo: Repository in format "owner/repo"

        Returns:
            Tag ID string
        """
        owner, repo_name = repo.split('/')
        # Sanitize owner and repo name (replace hyphens/special chars with underscores)
        owner = re.sub(r'[^a-zA-Z0-9_]', '_', owner)
        repo_name = re.sub(r'[^a-zA-Z0-9_]', '_', repo_name)
        return f"github_issue_{owner}_{repo_name}_{issue_number}"


class ResponseStateManager:
    """
    Manages state for tracking sent responses.

    Prevents duplicate responses by tracking which task/issue combinations
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
        self.sent_keys: set = set()  # (task_id, tag_id) tuples
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
                        tag_id = entry.get('tag_id')
                        if task_id and tag_id:
                            self.sent_keys.add((task_id, tag_id))

            logger.info(f"Loaded {len(self.sent_responses)} sent responses from {self.state_file}")

        except Exception as e:
            logger.error(f"Error loading response state from {self.state_file}: {e}")
            self.sent_responses = []
            self.sent_keys = set()

    def was_response_sent(self, task_id: str, tag_id: str) -> bool:
        """
        Check if a response was already sent for this task/issue.

        Args:
            task_id: Kanban task ID
            tag_id: GitHub issue tag identifier

        Returns:
            True if already sent, False otherwise
        """
        return (task_id, tag_id) in self.sent_keys

    def record_sent(
        self,
        task_id: str,
        tag_id: str,
        issue_number: int,
        repo: str,
        comment_id: int,
        comment_url: str
    ) -> bool:
        """
        Record that a response was sent.

        Args:
            task_id: Kanban task ID
            tag_id: GitHub issue tag identifier
            issue_number: GitHub issue number
            repo: Repository in format "owner/repo"
            comment_id: ID of the posted comment
            comment_url: URL to the posted comment

        Returns:
            True if recorded, False if duplicate or error
        """
        key = (task_id, tag_id)
        if key in self.sent_keys:
            logger.debug(f"Response already recorded for task={task_id}, tag_id={tag_id}")
            return False

        entry = {
            'task_id': task_id,
            'tag_id': tag_id,
            'issue_number': issue_number,
            'repo': repo,
            'comment_id': comment_id,
            'comment_url': comment_url,
            'sent_at': datetime.now(timezone.utc).isoformat()
        }

        try:
            # Append to file (atomic)
            with open(self.state_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            # Update in-memory state
            self.sent_responses.append(entry)
            self.sent_keys.add(key)

            logger.debug(f"Recorded sent response for task={task_id}, tag_id={tag_id}")
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


class CommentStateManager:
    """
    Manages state for tracking processed comments (user replies).

    Prevents duplicate processing by tracking which comments have been
    converted to kanban tasks.
    """

    def __init__(self, state_file_path: str):
        """
        Initialize CommentStateManager.

        Args:
            state_file_path: Path to NDJSON state file
        """
        self.state_file = Path(state_file_path)
        self.processed_comments: Dict[int, Dict[str, Any]] = {}  # Keyed by comment_id
        self._load_state()

    def _load_state(self) -> None:
        """Load existing state from NDJSON file."""
        if not self.state_file.exists():
            logger.info(f"Comment state file does not exist, will create: {self.state_file}")
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.processed_comments = {}
            return

        try:
            self.processed_comments = {}
            with open(self.state_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entry = json.loads(line)
                        comment_id = entry.get('comment_id')
                        if comment_id:
                            self.processed_comments[comment_id] = entry

            logger.info(f"Loaded {len(self.processed_comments)} processed comments from {self.state_file}")

        except Exception as e:
            logger.error(f"Error loading comment state from {self.state_file}: {e}")
            self.processed_comments = {}

    def is_comment_processed(self, comment_id: int) -> bool:
        """
        Check if a comment has already been processed.

        Args:
            comment_id: GitHub comment ID

        Returns:
            True if already processed, False otherwise
        """
        return comment_id in self.processed_comments

    def mark_comment_processed(
        self,
        comment_id: int,
        issue_number: int,
        repo: str,
        task_id: str,
        related_task_ids: List[str]
    ) -> bool:
        """
        Mark a comment as processed.

        Args:
            comment_id: GitHub comment ID
            issue_number: GitHub issue number
            repo: Repository in format "owner/repo"
            task_id: Kanban task ID created for this comment
            related_task_ids: List of previous task IDs found in the thread

        Returns:
            True if recorded, False if duplicate or error
        """
        if comment_id in self.processed_comments:
            logger.debug(f"Comment {comment_id} already recorded")
            return False

        entry = {
            'comment_id': comment_id,
            'issue_number': issue_number,
            'repo': repo,
            'task_id': task_id,
            'related_task_ids': related_task_ids,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }

        try:
            # Append to file (atomic)
            with open(self.state_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')

            # Update in-memory state
            self.processed_comments[comment_id] = entry

            logger.debug(f"Recorded processed comment {comment_id} -> task_id={task_id}")
            return True

        except Exception as e:
            logger.error(f"Error recording comment to {self.state_file}: {e}")
            return False

    def get_processed_count(self) -> int:
        """Get total number of processed comments."""
        return len(self.processed_comments)


# =============================================================================
# GitHub API Client
# =============================================================================

class GitHubClient:
    """GitHub API client with authentication and error handling."""

    def __init__(self, token: str, api_url: str = "https://api.github.com"):
        """
        Initialize GitHub API client.

        Args:
            token: GitHub personal access token
            api_url: GitHub API base URL (for GitHub Enterprise)
        """
        self.token = token
        self.api_url = api_url.rstrip('/')
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        })

    def test_connection(self) -> Dict[str, Any]:
        """
        Test GitHub API connection.

        Returns:
            User info dict

        Raises:
            requests.exceptions.HTTPError: If authentication fails
        """
        url = f"{self.api_url}/user"
        response = self.session.get(url, timeout=10)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def list_issues(
        self,
        owner: str,
        repo: str,
        state: str = 'open',
        labels: Optional[List[str]] = None,
        assignee: Optional[str] = None,
        since: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch issues from repository with filters.

        Args:
            owner: Repository owner
            repo: Repository name
            state: Issue state (open, closed, all)
            labels: Filter by labels
            assignee: Filter by assignee
            since: Only issues updated after this timestamp (ISO 8601)

        Returns:
            List of issue dicts
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues"
        params = {'state': state, 'per_page': 100}

        if labels:
            params['labels'] = ','.join(labels)
        if assignee:
            params['assignee'] = assignee
        if since:
            params['since'] = since

        issues = []
        page = 1

        while True:
            params['page'] = page
            logger.debug(f"Fetching issues page {page}...")

            try:
                response = self.session.get(url, params=params, timeout=30)
                self._check_rate_limit(response)
                response.raise_for_status()

                page_issues = response.json()
                if not page_issues:
                    break

                # Filter out pull requests (GitHub API returns both issues and PRs)
                page_issues = [i for i in page_issues if 'pull_request' not in i]

                issues.extend(page_issues)
                page += 1

                # Check if there are more pages
                link_header = response.headers.get('Link', '')
                if 'rel="next"' not in link_header:
                    break

            except requests.exceptions.Timeout:
                logger.error(f"Timeout fetching issues from {owner}/{repo}")
                break
            except requests.exceptions.HTTPError as e:
                logger.error(f"HTTP error fetching issues: {e}")
                break

        logger.debug(f"Fetched {len(issues)} issues from {owner}/{repo}")
        return issues

    def get_issue(self, owner: str, repo: str, issue_number: int) -> Dict[str, Any]:
        """
        Get a specific issue.

        Args:
            owner: Repository owner
            repo: Repository name
            issue_number: Issue number

        Returns:
            Issue dict

        Raises:
            requests.exceptions.HTTPError: If issue not found
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues/{issue_number}"
        response = self.session.get(url, timeout=10)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def post_comment(self, owner: str, repo: str, issue_number: int, body: str) -> Dict[str, Any]:
        """
        Post a comment on an issue.

        Args:
            owner: Repository owner
            repo: Repository name
            issue_number: Issue number
            body: Comment body (markdown)

        Returns:
            Comment dict with id, url, etc.

        Raises:
            requests.exceptions.HTTPError: If comment fails to post
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues/{issue_number}/comments"
        response = self.session.post(url, json={'body': body}, timeout=30)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def close_issue(self, owner: str, repo: str, issue_number: int) -> Dict[str, Any]:
        """
        Close an issue.

        Args:
            owner: Repository owner
            repo: Repository name
            issue_number: Issue number

        Returns:
            Updated issue dict

        Raises:
            requests.exceptions.HTTPError: If close fails
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues/{issue_number}"
        response = self.session.patch(url, json={'state': 'closed'}, timeout=30)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def create_issue(self, owner: str, repo: str, title: str, body: str, labels: Optional[List[str]] = None) -> Dict[str, Any]:
        """
        Create a new issue.

        Args:
            owner: Repository owner
            repo: Repository name
            title: Issue title
            body: Issue body (markdown)
            labels: Optional list of label names

        Returns:
            Created issue dict with number, url, etc.

        Raises:
            requests.exceptions.HTTPError: If issue creation fails
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues"
        payload = {'title': title, 'body': body}

        if labels:
            payload['labels'] = labels

        response = self.session.post(url, json=payload, timeout=30)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def list_issue_comments(
        self,
        owner: str,
        repo: str,
        issue_number: int,
        since: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch all comments on an issue.

        Args:
            owner: Repository owner
            repo: Repository name
            issue_number: Issue number
            since: Only comments updated after this timestamp (ISO 8601)

        Returns:
            List of comment dicts
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues/{issue_number}/comments"
        params = {'per_page': 100}

        if since:
            params['since'] = since

        comments = []
        page = 1

        while True:
            params['page'] = page
            logger.debug(f"Fetching comments page {page} for issue #{issue_number}...")

            try:
                response = self.session.get(url, params=params, timeout=30)
                self._check_rate_limit(response)
                response.raise_for_status()

                page_comments = response.json()
                if not page_comments:
                    break

                comments.extend(page_comments)
                page += 1

                # Check if there are more pages
                link_header = response.headers.get('Link', '')
                if 'rel="next"' not in link_header:
                    break

            except requests.exceptions.Timeout:
                logger.error(f"Timeout fetching comments for issue #{issue_number}")
                break
            except requests.exceptions.HTTPError as e:
                logger.error(f"HTTP error fetching comments: {e}")
                break

        logger.debug(f"Fetched {len(comments)} comments for issue #{issue_number}")
        return comments

    def reopen_issue(self, owner: str, repo: str, issue_number: int) -> Dict[str, Any]:
        """
        Reopen a closed issue.

        Args:
            owner: Repository owner
            repo: Repository name
            issue_number: Issue number

        Returns:
            Updated issue dict

        Raises:
            requests.exceptions.HTTPError: If reopen fails
        """
        url = f"{self.api_url}/repos/{owner}/{repo}/issues/{issue_number}"
        response = self.session.patch(url, json={'state': 'open'}, timeout=30)
        self._check_rate_limit(response)
        response.raise_for_status()
        return response.json()

    def _check_rate_limit(self, response):
        """Check and log rate limit status."""
        remaining = response.headers.get('X-RateLimit-Remaining')
        reset = response.headers.get('X-RateLimit-Reset')

        if remaining:
            remaining = int(remaining)
            if remaining < 100:
                logger.warning(f"GitHub API rate limit low: {remaining} remaining")
                if reset:
                    reset_time = datetime.fromtimestamp(int(reset))
                    logger.warning(f"Rate limit resets at: {reset_time}")


# =============================================================================
# Utility Functions
# =============================================================================

def setup_logging(verbose: bool = False) -> None:
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


def signal_handler(signum: int, frame) -> None:
    """Handle shutdown signals gracefully."""
    global shutdown_requested
    signal_name = signal.Signals(signum).name
    logger.info(f"Received {signal_name}, initiating graceful shutdown...")
    shutdown_requested = True


def sanitize_tag(tag: str) -> str:
    """
    Sanitize a tag to be compatible with kanban validation.

    Kanban tags only allow: letters, numbers, underscores (_), and hyphens (-).

    Args:
        tag: The raw tag string

    Returns:
        Sanitized tag compatible with kanban system
    """
    # Replace spaces and colons with underscores
    tag = tag.replace(' ', '_').replace(':', '_')
    # Remove any remaining invalid characters
    tag = re.sub(r'[^a-zA-Z0-9_-]', '_', tag)
    # Collapse multiple underscores
    tag = re.sub(r'_+', '_', tag)
    # Remove leading/trailing underscores
    tag = tag.strip('_')
    return tag


def extract_github_tag(tags: List[str]) -> Optional[str]:
    """
    Extract github_issue_* tag from task tags.

    Args:
        tags: List of task tags

    Returns:
        Tag ID string or None if not found
    """
    if tags is None:
        return None
    for tag in tags:
        if tag.startswith('github_issue_'):
            return tag
    return None


def extract_parent_github_tag(tags: List[str]) -> Optional[str]:
    """
    Extract parent_github_issue_* tag from reply task tags.

    Reply tasks (created from GitHub issue comments) have parent_github_issue_* tags
    pointing to the original issue they should reply to.

    Args:
        tags: List of task tags

    Returns:
        Parent tag ID string (without 'parent_' prefix) or None if not found

    Example:
        tags = ['github-reply', 'parent_github_issue_owner_repo_123']
        returns: 'github_issue_owner_repo_123'
    """
    if tags is None:
        return None
    for tag in tags:
        if tag.startswith('parent_github_issue_'):
            # Remove 'parent_' prefix to get the actual github_issue_* tag
            return 'github_issue_' + tag[len('parent_github_issue_'):]
    return None


def is_reply_task(tags: List[str]) -> bool:
    """
    Check if a task is a reply task (created from a GitHub issue comment).

    Args:
        tags: List of task tags

    Returns:
        True if task has 'github-reply' tag, False otherwise
    """
    if tags is None:
        return False
    return 'github-reply' in tags


def parse_tag_id(tag_id: str) -> Optional[Dict[str, Any]]:
    """
    Parse tag_id into components.

    Args:
        tag_id: Tag ID (e.g., "github_issue_owner_repo_123")

    Returns:
        Dict with keys: owner, repo, issue_number, full_repo
        Or None if invalid format
    """
    if not tag_id.startswith('github_issue_'):
        return None

    parts = tag_id[len('github_issue_'):].split('_')
    if len(parts) < 3:
        return None

    # Last part is issue number
    try:
        issue_number = int(parts[-1])
    except ValueError:
        return None

    # Everything before last part is repo
    repo_parts = parts[:-1]

    # First part is owner, rest is repo name
    owner = repo_parts[0]
    repo_name = '_'.join(repo_parts[1:])

    return {
        'owner': owner,
        'repo': repo_name,
        'issue_number': issue_number,
        'full_repo': f"{owner}/{repo_name}"
    }


def validate_repo_format(repo: str) -> bool:
    """
    Validate repository format: owner/repo

    Args:
        repo: Repository string

    Returns:
        True if valid, False otherwise
    """
    if '/' not in repo:
        logger.error(f"Invalid repo format: {repo}. Expected: owner/repo")
        return False

    owner, repo_name = repo.split('/', 1)
    if not owner or not repo_name:
        logger.error(f"Invalid repo format: {repo}. Expected: owner/repo")
        return False

    return True


# =============================================================================
# Attachment Extraction and Download Functions
# =============================================================================

def extract_attachment_urls(body: str, comments: Optional[List[Dict[str, Any]]] = None) -> List[str]:
    """
    Extract attachment URLs from issue body and comments.

    GitHub doesn't have a dedicated attachment API - files are embedded as URLs
    in the issue body or comments when users drag-drop or paste images.

    Args:
        body: Issue body text
        comments: Optional list of comment dicts

    Returns:
        Deduplicated list of attachment URLs
    """
    urls = set()

    def extract_from_text(text: str) -> None:
        if not text:
            return
        for pattern in GITHUB_ATTACHMENT_PATTERNS:
            matches = re.findall(pattern, text, re.IGNORECASE)
            urls.update(matches)

    # Extract from body
    extract_from_text(body)

    # Extract from comments
    if comments:
        for comment in comments:
            extract_from_text(comment.get('body', ''))

    return list(urls)


def download_github_attachments(
    urls: List[str],
    token: str,
    repo: str,
    issue_number: int,
    downloader: 'AttachmentDownloader'
) -> List[str]:
    """
    Download GitHub attachment files.

    Args:
        urls: List of attachment URLs
        token: GitHub token for authentication
        repo: Repository in owner/repo format
        issue_number: Issue number
        downloader: AttachmentDownloader instance

    Returns:
        List of local file paths
    """
    if not urls:
        return []

    downloaded_paths = []
    headers = {
        'Authorization': f'token {token}',
        'Accept': 'application/octet-stream'
    }

    # Sanitize repo for directory name
    repo_dir = repo.replace('/', '_')
    target_dir = downloader.base_dir / 'github' / repo_dir

    for url in urls:
        # Extract filename from URL
        try:
            from urllib.parse import urlparse, unquote
            parsed = urlparse(url)
            path_parts = parsed.path.split('/')
            filename = unquote(path_parts[-1]) if path_parts else None

            # Handle URLs without clear filename
            if not filename or filename in ['/', '']:
                # Use hash of URL as filename
                import hashlib
                url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
                # Try to extract extension from URL path
                ext = ''
                for part in reversed(path_parts):
                    if '.' in part:
                        ext = '.' + part.split('.')[-1]
                        break
                filename = f"attachment_{url_hash}{ext}"

        except Exception as e:
            logger.warning(f"Error parsing URL {url}: {e}")
            continue

        metadata = {
            'source': 'github',
            'repo': repo,
            'issue_number': issue_number,
        }

        path, error = downloader.download_file(
            url=url,
            target_dir=target_dir,
            filename_prefix=f"issue_{issue_number}",
            original_filename=filename,
            headers=headers,
            metadata=metadata
        )

        if path:
            downloaded_paths.append(path)
            logger.info(f"Downloaded GitHub attachment: {filename}")
        else:
            logger.warning(f"Failed to download {url}: {error}")

    return downloaded_paths


def extract_task_ids_from_text(text: str) -> List[str]:
    """
    Extract task IDs from text using [task_id]...[/task_id] format.

    Args:
        text: Text to search for task IDs

    Returns:
        List of task IDs found (comma-separated values are split)
    """
    task_ids = []

    # Pattern: [task_id]...[/task_id] (can contain comma-separated IDs)
    pattern = r'\[task_id\]([^[]+)\[/task_id\]'
    matches = re.findall(pattern, text, re.IGNORECASE)

    for match in matches:
        # Split by comma and strip whitespace
        ids = [tid.strip() for tid in match.split(',') if tid.strip()]
        task_ids.extend(ids)

    return task_ids


def is_agent_comment(comment_body: str) -> bool:
    """
    Detect if a comment was posted by our agent (not a user reply).

    Agent comments contain [task_id]...[/task_id] at the beginning,
    formatted as **[task_id]...[/task_id]**.

    Args:
        comment_body: Comment body text

    Returns:
        True if this is an agent-posted comment, False otherwise
    """
    # Agent comments start with **[task_id]...[/task_id]**
    # User replies won't have this specific format at the start
    agent_pattern = r'^\s*\*\*\[task_id\][^\[]+\[/task_id\]\*\*'

    return bool(re.match(agent_pattern, comment_body.strip()))


def collect_task_ids_from_thread(
    issue_body: str,
    comments: List[Dict[str, Any]]
) -> List[str]:
    """
    Collect all task IDs from an issue thread (body + comments).

    Args:
        issue_body: The issue body text
        comments: List of comment dicts

    Returns:
        Deduplicated list of task IDs found in the thread
    """
    all_task_ids = []

    # Extract from issue body
    all_task_ids.extend(extract_task_ids_from_text(issue_body or ''))

    # Extract from all comments (both agent responses and user replies)
    for comment in comments:
        body = comment.get('body', '')
        all_task_ids.extend(extract_task_ids_from_text(body))

    # Deduplicate while preserving order
    seen = set()
    unique_ids = []
    for tid in all_task_ids:
        if tid not in seen:
            seen.add(tid)
            unique_ids.append(tid)

    return unique_ids


GITHUB_TOKEN_DOCS_URL = "https://github.com/settings/tokens"


def validate_github_environment() -> Tuple[Optional[str], Optional[str], List[str]]:
    """
    Validate GitHub environment variables are properly configured.

    Returns:
        Tuple of (token, repo, errors)
        - token: GitHub token if found, None otherwise
        - repo: Repository if found, None otherwise
        - errors: List of error messages if validation failed
    """
    errors = []

    # Check for token
    token = os.getenv('GITHUB_TOKEN')
    if not token:
        errors.append(
            "GITHUB_TOKEN not found.\n"
            "  Generate a token at: https://github.com/settings/tokens\n"
            "  Required scopes: 'repo' (private) or 'public_repo' (public)\n"
            "  Set via environment variable or .env file:\n"
            "    export GITHUB_TOKEN=ghp_your_token_here\n"
            "  Or add to .env file:\n"
            "    GITHUB_TOKEN=ghp_your_token_here"
        )
    elif not (token.startswith('ghp_') or token.startswith('gho_') or token.startswith('ghs_')):
        errors.append(
            f"GITHUB_TOKEN appears invalid.\n"
            f"  Personal access tokens start with: ghp_, gho_, or ghs_\n"
            f"  Current value starts with: {token[:10]}...\n"
            f"  Generate a valid token at: {GITHUB_TOKEN_DOCS_URL}"
        )

    # Check for repo (optional but warn)
    repo = os.getenv('GITHUB_REPO')

    return token, repo, errors


def print_env_help() -> None:
    """Print help message about configuring GitHub environment variables."""
    print("\n" + "=" * 70)
    print("GitHub Integration - Environment Configuration")
    print("=" * 70)
    print(f"""
Required Environment Variables:
  GITHUB_TOKEN          Your GitHub personal access token (ghp_*, gho_*, ghs_*)

Optional Environment Variables:
  GITHUB_REPO           Default repository (format: owner/repo)
  GITHUB_API_URL        GitHub API URL (default: https://api.github.com)
                        For GitHub Enterprise: https://github.company.com/api/v3
  CHECK_INTERVAL_SECONDS  Polling interval in seconds (default: 300)
  LOG_LEVEL             DEBUG, INFO, WARNING, ERROR (default: INFO)

Configuration Methods:
  1. Environment variables:
     export GITHUB_TOKEN=ghp_your_token_here
     export GITHUB_REPO=owner/repo

  2. .env file (in project root):
     GITHUB_TOKEN=ghp_your_token_here
     GITHUB_REPO=owner/repo

Generating a GitHub Personal Access Token:
  1. Go to {GITHUB_TOKEN_DOCS_URL}
  2. Click "Generate new token" (classic or fine-grained)
  3. Select scopes:
     - For private repos: 'repo' (full control of private repositories)
     - For public repos: 'public_repo' (access public repositories)
  4. Generate token and copy it (starts with ghp_, gho_, or ghs_)
  5. Set GITHUB_TOKEN environment variable or add to .env file

Example .env file:
  GITHUB_TOKEN=ghp_YOUR_PERSONAL_ACCESS_TOKEN_HERE
  GITHUB_REPO=myorg/myrepo
  CHECK_INTERVAL_SECONDS=600
  LOG_LEVEL=INFO
""")
    print("=" * 70 + "\n")


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


# =============================================================================
# Kanban Integration
# =============================================================================

def create_kanban_task_from_issue(
    issue: Dict[str, Any],
    repo: str,
    kanban_script: str,
    dry_run: bool = False,
    attachment_paths: Optional[List[str]] = None
) -> Optional[str]:
    """
    Create kanban task from GitHub issue.

    Args:
        issue: GitHub issue dict
        repo: Repository in format "owner/repo"
        kanban_script: Path to kanban.sh script
        dry_run: If True, don't actually create the task
        attachment_paths: Optional list of downloaded attachment file paths

    Returns:
        Task ID if created, None if failed
    """
    owner, repo_name = repo.split('/')
    issue_number = issue['number']

    # Generate tag_id
    tag_id = GitHubStateManager._make_tag_id(issue_number, repo)

    # Build task body - optimized for token efficiency
    # Start with just title and description
    task_body = f"# {issue['title']}\n\n"
    task_body += issue['body'] or "(No description)"

    # Append attachment paths if any
    if attachment_paths:
        task_body += format_attachments_section(attachment_paths)

    # Build tags - all metadata goes here for token efficiency
    tags = [
        'github-input',
        f'repo_{sanitize_tag(owner)}_{sanitize_tag(repo_name)}',
        f"author_{sanitize_tag(issue['user']['login'])}",
        f"issue_{issue_number}",
        f"state_{issue['state']}"
    ]

    for label in issue.get('labels', []):
        tags.append(f"label_{sanitize_tag(label['name'])}")

    for assignee in issue.get('assignees', []):
        tags.append(f"assignee_{sanitize_tag(assignee['login'])}")

    # Add tag_id as a tag
    tags.append(tag_id)

    # Add has-attachments tag if files were downloaded
    if attachment_paths:
        tags.append('has-attachments')

    if dry_run:
        logger.info(f"[DRY RUN] Would create task with tag_id: {tag_id}")
        logger.debug(f"[DRY RUN] Body: {task_body[:200]}...")
        logger.debug(f"[DRY RUN] Tags: {', '.join(tags)}")
        if attachment_paths:
            logger.debug(f"[DRY RUN] Attachments: {len(attachment_paths)} files")
        return "dry-run-task-id"

    try:
        # Execute kanban create command
        cmd = [kanban_script, 'create', task_body, '--tags', ','.join(tags)]
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
                    logger.info(f"Created kanban task: {task_id} (tag_id: {tag_id})")
                    return task_id
            except json.JSONDecodeError:
                logger.warning(f"Could not parse kanban output: {result.stdout[:200]}")
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


def get_completed_tasks_with_responses(
    kanban_script: str,
    tag_filter: Optional[str] = None,
    limit: int = 10000
) -> List[Dict[str, Any]]:
    """
    Get kanban tasks with agent responses.

    Args:
        kanban_script: Path to kanban.sh script
        tag_filter: Optional tag to filter by
        limit: Maximum number of tasks to retrieve

    Returns:
        List of task dicts with non-empty agent_response
    """
    cmd = [kanban_script, 'list', '--limit', str(limit)]

    if tag_filter:
        cmd.extend(['--tag', tag_filter])

    logger.debug(f"Running: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            logger.error(f"Kanban command failed: {result.stderr}")
            return []

        try:
            tasks = json.loads(result.stdout)
            if isinstance(tasks, list):
                # Filter to tasks with non-empty agent_response
                return [t for t in tasks if t.get('agent_response') and t['agent_response'] != 'null']
            logger.warning(f"Unexpected kanban output format: {type(tasks)}")
            return []
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse kanban output: {e}")
            return []

    except subprocess.TimeoutExpired:
        logger.error("Kanban command timed out")
        return []
    except Exception as e:
        logger.error(f"Error running kanban command: {e}")
        return []


def get_all_kanban_tasks(
    kanban_script: str,
    tag_filter: Optional[str] = None,
    status_filter: Optional[List[str]] = None,
    limit: int = 10000
) -> List[Dict[str, Any]]:
    """
    Get all kanban tasks.

    Args:
        kanban_script: Path to kanban.sh script
        tag_filter: Optional tag to filter by
        status_filter: Optional list of statuses to filter by
        limit: Maximum number of tasks to retrieve

    Returns:
        List of task dicts
    """
    cmd = [kanban_script, 'list', '--limit', str(limit)]

    if tag_filter:
        cmd.extend(['--tag', tag_filter])

    if status_filter:
        cmd.extend(['--status'] + status_filter)

    logger.debug(f"Running: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            logger.error(f"Kanban command failed: {result.stderr}")
            return []

        try:
            tasks = json.loads(result.stdout)
            if isinstance(tasks, list):
                return tasks
            logger.warning(f"Unexpected kanban output format: {type(tasks)}")
            return []
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse kanban output: {e}")
            return []

    except subprocess.TimeoutExpired:
        logger.error("Kanban command timed out")
        return []
    except Exception as e:
        logger.error(f"Error running kanban command: {e}")
        return []


def add_tag_to_kanban_task(kanban_script: str, task_id: str, tag: str) -> bool:
    """
    Add a tag to a kanban task.

    Args:
        kanban_script: Path to kanban.sh script
        task_id: Task ID
        tag: Tag to add

    Returns:
        True if successful, False otherwise
    """
    cmd = [kanban_script, 'update', task_id, '--tags', tag]

    logger.debug(f"Running: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode != 0:
            logger.error(f"Failed to tag task {task_id}: {result.stderr}")
            return False

        return True

    except subprocess.TimeoutExpired:
        logger.error(f"Tag command timed out for task {task_id}")
        return False
    except Exception as e:
        logger.error(f"Error tagging task {task_id}: {e}")
        return False


def create_kanban_task_from_comment(
    comment: Dict[str, Any],
    issue: Dict[str, Any],
    repo: str,
    kanban_script: str,
    related_task_ids: List[str],
    dry_run: bool = False
) -> Optional[str]:
    """
    Create kanban task from a GitHub issue comment (user reply).

    Args:
        comment: GitHub comment dict
        issue: GitHub issue dict (parent issue)
        repo: Repository in format "owner/repo"
        kanban_script: Path to kanban.sh script
        related_task_ids: List of previous task IDs from the thread
        dry_run: If True, don't actually create the task

    Returns:
        Task ID if created, None if failed
    """
    owner, repo_name = repo.split('/')
    issue_number = issue['number']
    comment_id = comment['id']

    # Generate tag_id for the comment (different from issue tag_id)
    # Format: ghc_{comment_id} - shortened to stay under 50 char kanban tag limit
    # Comment IDs are globally unique across GitHub, so no need for repo/issue in tag
    comment_tag_id = f"ghc_{comment_id}"

    # Build task body
    # Start with the reply content
    task_body = f"# Reply to Issue #{issue_number}: {issue['title']}\n\n"
    task_body += comment['body'] or "(No content)"

    # Add previous task_id references if any
    if related_task_ids:
        task_body += f"\n\n[task_id]{','.join(related_task_ids)}[/task_id]"

    # Build tags
    tags = [
        'github-input',
        'github-reply',  # Mark as a reply specifically
        f'repo_{sanitize_tag(owner)}_{sanitize_tag(repo_name)}',
        f"author_{sanitize_tag(comment['user']['login'])}",
        f"issue_{issue_number}",
        f"comment_{comment_id}",
    ]

    # Add the issue's tag_id as a related tag (for O(1) lookup)
    issue_tag_id = GitHubStateManager._make_tag_id(issue_number, repo)
    tags.append(f"parent_{issue_tag_id}")

    # Add comment tag_id
    tags.append(comment_tag_id)

    if dry_run:
        logger.info(f"[DRY RUN] Would create task for comment #{comment_id} on issue #{issue_number}")
        logger.debug(f"[DRY RUN] Body: {task_body[:200]}...")
        logger.debug(f"[DRY RUN] Tags: {', '.join(tags)}")
        logger.debug(f"[DRY RUN] Related task IDs: {related_task_ids}")
        return "dry-run-task-id"

    try:
        # Execute kanban create command
        cmd = [kanban_script, 'create', task_body, '--tags', ','.join(tags)]
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
                    logger.info(f"Created kanban task from comment: {task_id} (comment_id: {comment_id})")
                    return task_id
            except json.JSONDecodeError:
                logger.warning(f"Could not parse kanban output: {result.stdout[:200]}")
                return "unknown-task-id"
        else:
            logger.error(f"Failed to create kanban task from comment: {result.stderr}")
            return None

    except subprocess.TimeoutExpired:
        logger.error("Kanban command timed out")
        return None
    except Exception as e:
        logger.error(f"Error creating kanban task from comment: {e}")
        return None


def process_issue_comments(
    client: 'GitHubClient',
    issue: Dict[str, Any],
    repo: str,
    kanban_script: str,
    comment_state_mgr: 'CommentStateManager',
    dry_run: bool = False
) -> Tuple[int, int]:
    """
    Process comments on an issue, creating kanban tasks for user replies.

    This detects:
    1. Agent comments (identified by **[task_id]...[/task_id]** format)
    2. User replies (any comment that is NOT an agent comment)

    For user replies, creates a kanban task with references to previous task_ids.

    Args:
        client: GitHub API client
        issue: GitHub issue dict
        repo: Repository in format "owner/repo"
        kanban_script: Path to kanban.sh script
        comment_state_mgr: CommentStateManager for tracking processed comments
        dry_run: If True, don't actually create tasks

    Returns:
        Tuple of (processed_count, created_count)
    """
    owner, repo_name = repo.split('/')
    issue_number = issue['number']

    # Fetch all comments for this issue
    comments = client.list_issue_comments(owner, repo_name, issue_number)

    if not comments:
        logger.debug(f"Issue #{issue_number}: No comments")
        return 0, 0

    logger.debug(f"Issue #{issue_number}: Found {len(comments)} comments")

    processed = 0
    created = 0

    # Collect all task_ids from the thread for context
    all_task_ids = collect_task_ids_from_thread(issue.get('body', ''), comments)

    for comment in comments:
        comment_id = comment['id']
        comment_body = comment.get('body', '')
        comment_author = comment['user']['login']

        # Skip already processed comments
        if comment_state_mgr.is_comment_processed(comment_id):
            logger.debug(f"  Comment #{comment_id}: Already processed, skipping")
            continue

        # Skip agent comments (our own responses)
        if is_agent_comment(comment_body):
            logger.debug(f"  Comment #{comment_id}: Agent comment, skipping")
            # Still mark as processed to avoid re-checking
            if not dry_run:
                comment_state_mgr.mark_comment_processed(
                    comment_id, issue_number, repo, "agent-comment", []
                )
            continue

        # This is a user reply - create a kanban task
        logger.info(f"  Comment #{comment_id} (@{comment_author}): User reply detected")
        processed += 1

        task_id = create_kanban_task_from_comment(
            comment, issue, repo, kanban_script, all_task_ids, dry_run
        )

        if task_id:
            if not dry_run:
                comment_state_mgr.mark_comment_processed(
                    comment_id, issue_number, repo, task_id, all_task_ids
                )
            logger.info(f"    ✓ Created kanban task: {task_id}")
            if all_task_ids:
                logger.info(f"    ✓ Linked to previous task(s): {', '.join(all_task_ids)}")
            created += 1
        else:
            logger.warning(f"    ✗ Failed to create task for comment #{comment_id}")

    return processed, created


# =============================================================================
# Command Handlers
# =============================================================================

def handle_fetch(args: argparse.Namespace) -> int:
    """Handle 'fetch' subcommand."""
    logger.info("=" * 70)
    logger.info("GitHub Fetch - Creating kanban tasks from GitHub issues")
    logger.info("=" * 70)

    # Validate environment
    token, default_repo, errors = validate_github_environment()
    if errors:
        for error in errors:
            logger.error(error)
        print_env_help()
        return 1

    repo = args.repo or default_repo
    if not repo:
        logger.error("No repository specified. Use --repo or set GITHUB_REPO")
        return 1

    if not validate_repo_format(repo):
        return 1

    owner, repo_name = repo.split('/')

    # Find project root and kanban script
    project_dir = Path.cwd()
    kanban_script = find_kanban_script(project_dir)
    if not kanban_script:
        logger.error("Cannot find kanban.sh script. Is the project initialized?")
        return 1

    # Initialize GitHub client
    logger.info("Initializing GitHub client...")
    api_url = os.getenv('GITHUB_API_URL', 'https://api.github.com')
    client = GitHubClient(token, api_url)

    # Test connection
    try:
        user_info = client.test_connection()
        logger.info(f"Connected to GitHub API (user: {user_info['login']})")
    except requests.exceptions.HTTPError as e:
        error_msg = f"Failed to connect to GitHub: {e}"
        logger.error(error_msg)
        print(f"\n❌ ERROR: {error_msg}", file=sys.stderr)
        if hasattr(e, 'response') and e.response is not None:
            try:
                error_detail = e.response.json()
                print(f"   Details: {error_detail.get('message', 'No details available')}", file=sys.stderr)
            except:
                print(f"   HTTP Status: {e.response.status_code}", file=sys.stderr)
        print("   Check your GITHUB_TOKEN permissions and validity", file=sys.stderr)
        return 1

    # Initialize state manager
    state_dir = project_dir / '.juno_task' / 'github'
    state_file = state_dir / 'state.ndjson'
    logger.info(f"Initializing state manager: {state_file}")
    state_mgr = GitHubStateManager(str(state_file))

    # Initialize comment state manager for tracking processed comments/replies
    comment_state_file = state_dir / 'comments.ndjson'
    logger.info(f"Initializing comment state manager: {comment_state_file}")
    comment_state_mgr = CommentStateManager(str(comment_state_file))

    # Determine --since for incremental fetch
    since = args.since or state_mgr.get_last_update_timestamp(repo)

    # Check if we should include comments
    include_comments = getattr(args, 'include_comments', True)  # Default to True

    # Initialize attachment downloader if enabled
    downloader = None
    download_attachments = getattr(args, 'download_attachments', True) and is_attachments_enabled()
    if download_attachments and ATTACHMENTS_AVAILABLE:
        attachments_dir = project_dir / '.juno_task' / 'attachments'
        downloader = AttachmentDownloader(base_dir=str(attachments_dir))
        logger.info(f"Attachment downloads enabled: {attachments_dir}")
    elif download_attachments and not ATTACHMENTS_AVAILABLE:
        logger.warning("Attachment downloads requested but attachment_downloader module not available")
        download_attachments = False

    if args.dry_run:
        logger.info("Running in DRY RUN mode - no tasks will be created")

    logger.info(f"Monitoring repository: {repo}")
    logger.info(f"Filters: labels={args.labels or 'None'} assignee={args.assignee or 'None'} state={args.state}")
    logger.info(f"Include comments/replies: {include_comments}")
    logger.info(f"Download attachments: {download_attachments}")
    logger.info(f"Mode: {'once' if args.once else 'continuous'}")
    if since:
        logger.info(f"Incremental sync since: {since}")
    logger.info("-" * 70)

    # Get check interval
    check_interval = args.interval or int(os.getenv('CHECK_INTERVAL_SECONDS', 300))

    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Main loop
    iteration = 0
    total_processed = 0
    total_comments_processed = 0
    total_replies_created = 0

    while not shutdown_requested:
        iteration += 1
        logger.debug(f"Starting iteration {iteration}")

        try:
            # Fetch issues
            labels = args.labels.split(',') if args.labels else None
            issues = client.list_issues(
                owner,
                repo_name,
                state=args.state,
                labels=labels,
                assignee=args.assignee,
                since=since
            )

            # Filter already processed issues (but we still need to check their comments)
            new_issues = [i for i in issues if not state_mgr.is_processed(i['number'], repo)]

            if new_issues:
                logger.info(f"Processing {len(new_issues)} new issues...")

                for issue in new_issues:
                    logger.info(f"  Issue #{issue['number']} (@{issue['user']['login']}): {issue['title']}")

                    # Handle attachments if enabled
                    attachment_paths = []
                    if download_attachments and downloader:
                        attachment_urls = extract_attachment_urls(issue.get('body', ''))
                        if attachment_urls:
                            logger.info(f"    Found {len(attachment_urls)} attachment(s) in issue body")
                            if not args.dry_run:
                                attachment_paths = download_github_attachments(
                                    urls=attachment_urls,
                                    token=token,
                                    repo=repo,
                                    issue_number=issue['number'],
                                    downloader=downloader
                                )
                                if attachment_paths:
                                    logger.info(f"    Downloaded {len(attachment_paths)} attachment(s)")
                            else:
                                logger.info(f"    [DRY RUN] Would download {len(attachment_urls)} attachment(s)")

                    task_id = create_kanban_task_from_issue(
                        issue, repo, kanban_script, args.dry_run,
                        attachment_paths=attachment_paths
                    )

                    if task_id:
                        if not args.dry_run:
                            state_mgr.mark_processed({
                                'issue_number': issue['number'],
                                'repo': repo,
                                'title': issue['title'],
                                'body': issue['body'],
                                'author': issue['user']['login'],
                                'author_id': issue['user']['id'],
                                'labels': [l['name'] for l in issue.get('labels', [])],
                                'assignees': [a['login'] for a in issue.get('assignees', [])],
                                'state': issue['state'],
                                'created_at': issue['created_at'],
                                'updated_at': issue['updated_at'],
                                'issue_url': issue['url'],
                                'issue_html_url': issue['html_url'],
                                'attachment_count': len(attachment_paths),
                                'attachment_paths': attachment_paths
                            }, task_id)

                        logger.info(f"  ✓ Created kanban task: {task_id}")
                        total_processed += 1
                    else:
                        logger.warning(f"  ✗ Failed to create task for issue #{issue['number']}")
            else:
                logger.debug("No new issues")

            # Process comments/replies on all issues (including already processed ones)
            # This handles the case where a user replies to a closed issue and reopens it
            if include_comments:
                logger.info("Checking for new comments/replies on issues...")

                # Fetch ALL issues to check for new comments (state='all' for reopened issues)
                all_issues = client.list_issues(
                    owner,
                    repo_name,
                    state='all',  # Include closed and reopened issues
                    labels=labels,
                    assignee=args.assignee,
                    since=since
                )

                for issue in all_issues:
                    # Process comments on this issue
                    comments_processed, replies_created = process_issue_comments(
                        client,
                        issue,
                        repo,
                        kanban_script,
                        comment_state_mgr,
                        args.dry_run
                    )

                    if replies_created > 0:
                        logger.info(f"Issue #{issue['number']}: Created {replies_created} task(s) from user replies")

                    total_comments_processed += comments_processed
                    total_replies_created += replies_created

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
    logger.info("Summary:")
    logger.info(f"  New issues processed: {total_processed}")
    logger.info(f"  User replies processed: {total_comments_processed}")
    logger.info(f"  Reply tasks created: {total_replies_created}")
    logger.info(f"  Total tracked issues: {state_mgr.get_issue_count()}")
    logger.info(f"  Total tracked comments: {comment_state_mgr.get_processed_count()}")

    return 0


def handle_respond(args: argparse.Namespace) -> int:
    """Handle 'respond' subcommand."""
    logger.info("=" * 70)
    logger.info("GitHub Respond - Posting agent responses to GitHub issues")
    logger.info("=" * 70)

    # Validate environment
    token, default_repo, errors = validate_github_environment()
    if errors:
        for error in errors:
            logger.error(error)
        print_env_help()
        return 1

    # Find project root and kanban script
    project_dir = Path.cwd()
    kanban_script = find_kanban_script(project_dir)
    if not kanban_script:
        logger.error("Cannot find kanban.sh script. Is the project initialized?")
        return 1

    # Initialize GitHub client
    logger.info("Initializing GitHub client...")
    api_url = os.getenv('GITHUB_API_URL', 'https://api.github.com')
    client = GitHubClient(token, api_url)

    # Test connection
    try:
        user_info = client.test_connection()
        logger.info(f"Connected to GitHub API (user: {user_info['login']})")
    except requests.exceptions.HTTPError as e:
        error_msg = f"Failed to connect to GitHub: {e}"
        logger.error(error_msg)
        print(f"\n❌ ERROR: {error_msg}", file=sys.stderr)
        if hasattr(e, 'response') and e.response is not None:
            try:
                error_detail = e.response.json()
                print(f"   Details: {error_detail.get('message', 'No details available')}", file=sys.stderr)
            except:
                print(f"   HTTP Status: {e.response.status_code}", file=sys.stderr)
        print("   Check your GITHUB_TOKEN permissions and validity", file=sys.stderr)
        return 1

    # Initialize state managers
    state_dir = project_dir / '.juno_task' / 'github'
    state_file = state_dir / 'state.ndjson'
    response_state_file = state_dir / 'responses.ndjson'

    logger.info(f"Loading GitHub issue state: {state_file}")
    state_mgr = GitHubStateManager(str(state_file))

    logger.info(f"Loading response state: {response_state_file}")
    response_mgr = ResponseStateManager(str(response_state_file))

    if args.reset_tracker:
        confirm = input("WARNING: This will reset the response tracker. Type 'yes' to confirm: ")
        if confirm.lower() == 'yes':
            response_mgr.reset_state()
            logger.info("Response tracker reset")
        else:
            logger.info("Reset cancelled")
        return 0

    if args.dry_run:
        logger.info("Running in DRY RUN mode - no comments will be posted")

    logger.info(f"Loaded {state_mgr.get_issue_count()} processed issues")
    logger.info(f"Loaded {response_mgr.get_sent_count()} responses already sent")
    logger.info("-" * 70)

    # Get kanban tasks
    tasks = get_completed_tasks_with_responses(kanban_script, tag_filter=args.tag)
    logger.info(f"Found {len(tasks)} kanban tasks with responses")

    # Process tasks
    total_tasks = 0
    matched_tasks = 0
    sent_responses = 0
    already_sent = 0
    errors_count = 0

    for task in tasks:
        task_id = task.get('id')
        agent_response = task.get('agent_response', '')
        commit_hash = task.get('commit_hash', '')
        feature_tags = task.get('feature_tags', [])

        total_tasks += 1

        # Extract tag_id - handle both regular issues and reply tasks
        tag_id = None
        is_reply = is_reply_task(feature_tags)

        if is_reply:
            # For reply tasks, extract parent issue tag
            tag_id = extract_parent_github_tag(feature_tags)
            if tag_id:
                logger.debug(f"Task {task_id}: Reply task, using parent tag {tag_id}")
        else:
            # For regular issue tasks, extract github_issue_* tag
            tag_id = extract_github_tag(feature_tags)

        if not tag_id:
            logger.debug(f"Task {task_id}: No GitHub tag_id, skipping")
            continue

        # Look up issue
        issue_data = state_mgr.get_issue_for_task(tag_id)
        if not issue_data:
            logger.debug(f"Task {task_id}: No issue found for tag_id {tag_id}")
            continue

        matched_tasks += 1

        issue_number = issue_data['issue_number']
        repo = issue_data['repo']
        author = issue_data.get('author', 'unknown')

        logger.debug(f"Task {task_id}: Found GitHub issue #{issue_number} (@{author})")

        # Check if already sent
        if response_mgr.was_response_sent(task_id, tag_id):
            logger.info(f"Task {task_id}: Already sent response to issue #{issue_number} (skipping)")
            already_sent += 1
            continue

        # Send response
        logger.info(f"Task {task_id}: Sending response to issue #{issue_number}")

        # Format comment body
        comment_body = f"**[task_id]{task_id}[/task_id]**\n\n{agent_response}"

        # Add commit hash if available
        if commit_hash:
            comment_body += f"\n\n**Commit:** {commit_hash}"

        if args.dry_run:
            logger.info(f"  [DRY RUN] Would post comment on issue #{issue_number}")
            logger.info(f"  [DRY RUN] Would close issue #{issue_number}")
            logger.debug(f"  [DRY RUN] Comment: {comment_body[:200]}...")
            sent_responses += 1
            continue

        try:
            owner, repo_name = repo.split('/')

            # Debug output to help troubleshoot
            logger.debug(f"Posting comment to {owner}/{repo_name} issue #{issue_number}")
            logger.debug(f"Comment preview: {comment_body[:100]}...")

            # Post comment
            comment = client.post_comment(owner, repo_name, issue_number, comment_body)
            logger.info(f"  ✓ Posted comment on issue #{issue_number}")

            # Close the issue
            try:
                client.close_issue(owner, repo_name, issue_number)
                logger.info(f"  ✓ Closed issue #{issue_number}")
            except requests.exceptions.HTTPError as e:
                warning_msg = f"  ⚠ Failed to close issue #{issue_number}: {e}"
                logger.warning(warning_msg)
                print(f"\n{warning_msg}", file=sys.stderr)
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_detail = e.response.json()
                        detail_msg = f"     Details: {error_detail.get('message', 'No details available')}"
                        logger.warning(detail_msg)
                        print(detail_msg, file=sys.stderr)
                    except:
                        status_msg = f"     HTTP Status: {e.response.status_code}"
                        logger.warning(status_msg)
                        print(status_msg, file=sys.stderr)
                print("     Note: Comment was posted successfully, but couldn't close the issue", file=sys.stderr)
                print("     Check that GITHUB_TOKEN has 'repo' scope with write permissions", file=sys.stderr)
                # Continue anyway - comment was posted successfully

            # Record response
            response_mgr.record_sent(
                task_id,
                tag_id,
                issue_number,
                repo,
                comment['id'],
                comment['html_url']
            )

            sent_responses += 1

        except requests.exceptions.HTTPError as e:
            errors_count += 1
            error_msg = f"  ✗ Failed to post comment on issue #{issue_number}: {e}"
            logger.error(error_msg)
            print(f"\n{error_msg}", file=sys.stderr)
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_detail = e.response.json()
                    detail_msg = f"     Details: {error_detail.get('message', 'No details available')}"
                    logger.error(detail_msg)
                    print(detail_msg, file=sys.stderr)
                except:
                    status_msg = f"     HTTP Status: {e.response.status_code}"
                    logger.error(status_msg)
                    print(status_msg, file=sys.stderr)
            print("     Common causes:", file=sys.stderr)
            print("     - Missing 'repo' or 'issues' scope in GITHUB_TOKEN", file=sys.stderr)
            print("     - Token doesn't have write access to the repository", file=sys.stderr)
            print("     - Token is expired or revoked", file=sys.stderr)

    # Summary
    logger.info("")
    logger.info("=" * 70)
    logger.info("Summary:")
    logger.info(f"  Total tasks processed: {total_tasks}")
    logger.info(f"  Tasks matched with GitHub issues: {matched_tasks}")
    logger.info(f"  Comments posted: {sent_responses}")
    logger.info(f"  Already sent (skipped): {already_sent}")
    if errors_count > 0:
        logger.error(f"  Errors: {errors_count}")

    if args.dry_run:
        logger.info("(Dry run mode - no comments were actually posted)")

    return 0 if errors_count == 0 else 1


def handle_sync(args: argparse.Namespace) -> int:
    """Handle 'sync' subcommand (fetch + respond)."""
    logger.info("=" * 70)
    logger.info("GitHub Sync - Fetch issues AND respond to completed tasks")
    logger.info("=" * 70)

    # Get check interval
    check_interval = args.interval or int(os.getenv('CHECK_INTERVAL_SECONDS', 600))

    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    iteration = 0

    while not shutdown_requested:
        iteration += 1
        logger.info(f"Starting sync iteration {iteration}...")

        try:
            # Run fetch
            logger.info("Phase 1: Fetching new issues...")
            fetch_result = handle_fetch(args)
            if fetch_result != 0:
                logger.error("Fetch phase failed")
                if args.once:
                    return fetch_result

            # Run respond
            logger.info("Phase 2: Responding to completed tasks...")
            respond_result = handle_respond(args)
            if respond_result != 0:
                logger.error("Respond phase failed")
                if args.once:
                    return respond_result

            logger.info(f"Sync iteration {iteration} completed successfully")

            # Exit if --once mode
            if args.once:
                logger.info("--once mode: exiting after single sync")
                break

            # Sleep
            if not shutdown_requested:
                logger.info(f"Sleeping for {check_interval} seconds before next sync...")
                time.sleep(check_interval)

        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received")
            break
        except Exception as e:
            logger.error(f"Error in sync loop: {e}", exc_info=True)
            if args.once:
                return 1
            time.sleep(check_interval)

    logger.info("Sync completed")
    return 0


def handle_push(args: argparse.Namespace) -> int:
    """Handle 'push' subcommand - create GitHub issues from kanban tasks."""
    logger.info("=" * 70)
    logger.info("GitHub Push - Creating GitHub issues from kanban tasks")
    logger.info("=" * 70)

    # Validate environment
    token, default_repo, errors = validate_github_environment()
    if errors:
        for error in errors:
            logger.error(error)
        print_env_help()
        return 1

    # Determine repository
    repo = args.repo or default_repo
    if not repo:
        logger.error("No repository specified. Use --repo or set GITHUB_REPO environment variable")
        return 1

    # Parse owner/repo
    try:
        owner, repo_name = repo.split('/')
    except ValueError:
        logger.error(f"Invalid repository format: {repo}. Expected: owner/repo")
        return 1

    # Find project root and kanban script
    project_dir = Path.cwd()
    kanban_script = find_kanban_script(project_dir)
    if not kanban_script:
        logger.error("Cannot find kanban.sh script. Is the project initialized?")
        return 1

    # Initialize GitHub client
    logger.info("Initializing GitHub client...")
    api_url = os.getenv('GITHUB_API_URL', 'https://api.github.com')
    client = GitHubClient(token, api_url)

    # Test connection
    try:
        user_info = client.test_connection()
        logger.info(f"Connected to GitHub API (user: {user_info['login']})")
    except requests.exceptions.HTTPError as e:
        error_msg = f"Failed to connect to GitHub: {e}"
        logger.error(error_msg)
        print(f"\n❌ ERROR: {error_msg}", file=sys.stderr)
        if hasattr(e, 'response') and e.response is not None:
            try:
                error_detail = e.response.json()
                print(f"   Details: {error_detail.get('message', 'No details available')}", file=sys.stderr)
            except:
                print(f"   HTTP Status: {e.response.status_code}", file=sys.stderr)
        print("   Check your GITHUB_TOKEN permissions and validity", file=sys.stderr)
        return 1

    # Initialize state manager
    state_dir = project_dir / '.juno_task' / 'github'
    state_file = state_dir / 'state.ndjson'

    logger.info(f"Loading GitHub issue state: {state_file}")
    state_mgr = GitHubStateManager(str(state_file))

    if args.dry_run:
        logger.info("Running in DRY RUN mode - no issues will be created")

    logger.info(f"Loaded {state_mgr.get_issue_count()} tracked issues")
    logger.info("-" * 70)

    # Get kanban tasks
    status_filter = args.status if args.status else None
    tasks = get_all_kanban_tasks(kanban_script, tag_filter=args.tag, status_filter=status_filter)
    logger.info(f"Found {len(tasks)} kanban tasks")

    # Filter tasks that don't have GitHub tags
    tasks_without_github = []
    for task in tasks:
        task_id = task.get('id')
        feature_tags = task.get('feature_tags', [])

        # Check if task already has a GitHub tag
        tag_id = extract_github_tag(feature_tags)
        if not tag_id:
            tasks_without_github.append(task)
        else:
            logger.debug(f"Task {task_id}: Already has GitHub tag {tag_id}, skipping")

    logger.info(f"Found {len(tasks_without_github)} tasks without GitHub issues")

    # Process tasks
    total_tasks = 0
    created_issues = 0
    errors_count = 0

    for task in tasks_without_github:
        task_id = task.get('id')
        task_body = task.get('body', '')
        task_status = task.get('status', 'unknown')

        total_tasks += 1

        # Create issue title: Task ID + first 40 chars of body
        # Remove markdown headers and extra whitespace from body for title
        clean_body = re.sub(r'#\s+', '', task_body).strip()
        clean_body = re.sub(r'\s+', ' ', clean_body)
        title_suffix = clean_body[:40]
        if len(clean_body) > 40:
            title_suffix += "..."

        issue_title = f"[{task_id}] {title_suffix}"

        # Issue body is the complete task body
        issue_body = task_body

        # Add status metadata to issue body
        issue_body += f"\n\n---\n**Kanban Task ID:** `{task_id}`\n**Status:** `{task_status}`"

        logger.info(f"Task {task_id}: Creating GitHub issue")
        logger.debug(f"  Title: {issue_title}")

        if args.dry_run:
            logger.info(f"  [DRY RUN] Would create issue: {issue_title}")
            logger.debug(f"  [DRY RUN] Body preview: {issue_body[:200]}...")
            created_issues += 1
            continue

        try:
            # Create the issue
            labels = args.labels.split(',') if args.labels else None
            issue = client.create_issue(owner, repo_name, issue_title, issue_body, labels)
            issue_number = issue['number']
            issue_url = issue['html_url']

            logger.info(f"  ✓ Created issue #{issue_number}: {issue_url}")

            # Generate tag_id for this issue (use same method as fetch to ensure consistency)
            tag_id = GitHubStateManager._make_tag_id(issue_number, repo)

            # Tag the kanban task
            if add_tag_to_kanban_task(kanban_script, task_id, tag_id):
                logger.info(f"  ✓ Tagged task {task_id} with {tag_id}")
            else:
                logger.warning(f"  ⚠ Failed to tag task {task_id} (issue was created successfully)")

            # Record in state
            state_mgr.mark_processed({
                'issue_number': issue_number,
                'repo': repo,
                'title': issue_title,
                'body': issue_body,
                'author': user_info['login'],
                'author_id': user_info.get('id', 0),
                'labels': labels if labels else [],
                'assignees': [],
                'state': issue.get('state', 'open'),
                'created_at': issue.get('created_at', datetime.now(timezone.utc).isoformat()),
                'updated_at': issue.get('updated_at', datetime.now(timezone.utc).isoformat()),
                'issue_url': issue.get('url', ''),
                'issue_html_url': issue_url
            }, task_id)

            created_issues += 1

        except requests.exceptions.HTTPError as e:
            errors_count += 1
            error_msg = f"  ✗ Failed to create issue for task {task_id}: {e}"
            logger.error(error_msg)
            print(f"\n{error_msg}", file=sys.stderr)
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_detail = e.response.json()
                    detail_msg = f"     Details: {error_detail.get('message', 'No details available')}"
                    logger.error(detail_msg)
                    print(detail_msg, file=sys.stderr)
                except:
                    status_msg = f"     HTTP Status: {e.response.status_code}"
                    logger.error(status_msg)
                    print(status_msg, file=sys.stderr)
            print("     Common causes:", file=sys.stderr)
            print("     - Missing 'repo' or 'issues' scope in GITHUB_TOKEN", file=sys.stderr)
            print("     - Token doesn't have write access to the repository", file=sys.stderr)
            print("     - Token is expired or revoked", file=sys.stderr)

    # Summary
    logger.info("")
    logger.info("=" * 70)
    logger.info("Summary:")
    logger.info(f"  Total tasks processed: {total_tasks}")
    logger.info(f"  Issues created: {created_issues}")
    if errors_count > 0:
        logger.error(f"  Errors: {errors_count}")

    if args.dry_run:
        logger.info("(Dry run mode - no issues were actually created)")

    return 0 if errors_count == 0 else 1


# =============================================================================
# Main CLI
# =============================================================================

def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='GitHub integration for juno-code - Bidirectional sync between GitHub Issues and Kanban',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch issues from repository
  %(prog)s fetch --repo owner/repo

  # Fetch with filters
  %(prog)s fetch --repo owner/repo --labels bug,priority --assignee username

  # Fetch without processing user replies/comments
  %(prog)s fetch --repo owner/repo --no-comments

  # Respond to completed tasks
  %(prog)s respond --tag github-input

  # Push kanban tasks to GitHub (create issues)
  %(prog)s push --repo owner/repo
  %(prog)s push --repo owner/repo --status backlog todo --labels enhancement

  # Full sync (fetch + respond)
  %(prog)s sync --repo owner/repo --once

  # Continuous monitoring
  %(prog)s sync --repo owner/repo --continuous --interval 600

Environment Variables:
  GITHUB_TOKEN              GitHub personal access token (required)
  GITHUB_REPO               Default repository (format: owner/repo)
  GITHUB_API_URL            GitHub API URL (default: https://api.github.com)
  CHECK_INTERVAL_SECONDS    Polling interval in seconds (default: 300 for fetch, 600 for sync)
  LOG_LEVEL                 DEBUG, INFO, WARNING, ERROR (default: INFO)

Notes:
  - Issues are tagged with 'github-input', 'repo_*', 'author_*', 'label_*', and tag_id
  - Tag_id format: github_issue_owner_repo_123 (for O(1) lookup, no fuzzy matching)
  - User replies/comments create tasks tagged with 'github-reply' and 'comment_*'
  - Reply tasks include [task_id]...[/task_id] references to previous tasks in thread
  - Agent comments (matching **[task_id]...[/task_id]**) are automatically detected and skipped
  - State is persisted to .juno_task/github/state.ndjson
  - Responses tracked in .juno_task/github/responses.ndjson
  - Comments tracked in .juno_task/github/comments.ndjson
  - Use Ctrl+C for graceful shutdown
        """
    )

    parser.add_argument(
        '--version',
        action='version',
        version=f'%(prog)s {__version__}'
    )

    subparsers = parser.add_subparsers(dest='subcommand', help='Subcommands')

    # Fetch subcommand
    fetch_parser = subparsers.add_parser('fetch', help='Fetch GitHub issues and create kanban tasks')
    fetch_parser.add_argument('--repo', help='Repository (format: owner/repo)')
    fetch_parser.add_argument('--labels', help='Filter by labels (comma-separated)')
    fetch_parser.add_argument('--assignee', help='Filter by assignee')
    fetch_parser.add_argument('--state', default='open', choices=['open', 'closed', 'all'], help='Issue state (default: open)')
    fetch_parser.add_argument('--since', help='Only issues updated since timestamp (ISO 8601)')

    fetch_mode_group = fetch_parser.add_mutually_exclusive_group()
    fetch_mode_group.add_argument('--once', dest='once', action='store_true', default=True, help='Run once and exit (DEFAULT)')
    fetch_mode_group.add_argument('--continuous', dest='once', action='store_false', help='Run continuously with polling')

    fetch_parser.add_argument('--interval', type=int, help='Polling interval in seconds (default: 300)')
    fetch_parser.add_argument('--dry-run', action='store_true', help='Show what would be done without creating tasks')
    fetch_parser.add_argument('--verbose', '-v', action='store_true', help='Enable DEBUG level logging')
    fetch_parser.add_argument('--include-comments', dest='include_comments', action='store_true', default=True, help='Include user replies/comments (default: True)')
    fetch_parser.add_argument('--no-comments', dest='include_comments', action='store_false', help='Skip processing user replies/comments')
    fetch_parser.add_argument('--download-attachments', dest='download_attachments', action='store_true', default=True, help='Download file attachments (default: True)')
    fetch_parser.add_argument('--no-attachments', dest='download_attachments', action='store_false', help='Skip downloading file attachments')

    # Respond subcommand
    respond_parser = subparsers.add_parser('respond', help='Post comments on GitHub issues for completed tasks')
    respond_parser.add_argument('--repo', help='Filter by repository (format: owner/repo)')
    respond_parser.add_argument('--tag', default='github-input', help='Filter kanban tasks by tag (default: github-input)')
    respond_parser.add_argument('--dry-run', action='store_true', help='Show what would be sent without posting comments')
    respond_parser.add_argument('--verbose', '-v', action='store_true', help='Enable DEBUG level logging')
    respond_parser.add_argument('--reset-tracker', action='store_true', help='Reset response tracker (WARNING: will re-send all responses)')

    # Sync subcommand
    sync_parser = subparsers.add_parser('sync', help='Bidirectional sync (fetch + respond)')
    sync_parser.add_argument('--repo', help='Repository (format: owner/repo)')
    sync_parser.add_argument('--labels', help='Filter by labels (comma-separated)')
    sync_parser.add_argument('--assignee', help='Filter by assignee')
    sync_parser.add_argument('--state', default='open', choices=['open', 'closed', 'all'], help='Issue state (default: open)')
    sync_parser.add_argument('--since', help='Only issues updated since timestamp (ISO 8601)')
    sync_parser.add_argument('--tag', default='github-input', help='Filter kanban tasks by tag (default: github-input)')

    sync_mode_group = sync_parser.add_mutually_exclusive_group()
    sync_mode_group.add_argument('--once', dest='once', action='store_true', default=True, help='Run sync once and exit (DEFAULT)')
    sync_mode_group.add_argument('--continuous', dest='once', action='store_false', help='Run continuously with polling')

    sync_parser.add_argument('--interval', type=int, help='Polling interval in seconds (default: 600)')
    sync_parser.add_argument('--dry-run', action='store_true', help='Show what would be done without making changes')
    sync_parser.add_argument('--verbose', '-v', action='store_true', help='Enable DEBUG level logging')
    sync_parser.add_argument('--reset-tracker', action='store_true', help='Reset response tracker (WARNING: will re-send all responses)')
    sync_parser.add_argument('--include-comments', dest='include_comments', action='store_true', default=True, help='Include user replies/comments (default: True)')
    sync_parser.add_argument('--no-comments', dest='include_comments', action='store_false', help='Skip processing user replies/comments')
    sync_parser.add_argument('--download-attachments', dest='download_attachments', action='store_true', default=True, help='Download file attachments (default: True)')
    sync_parser.add_argument('--no-attachments', dest='download_attachments', action='store_false', help='Skip downloading file attachments')

    # Push subcommand
    push_parser = subparsers.add_parser('push', help='Create GitHub issues from kanban tasks without issues')
    push_parser.add_argument('--repo', required=True, help='Repository (format: owner/repo)')
    push_parser.add_argument('--tag', help='Filter kanban tasks by tag')
    push_parser.add_argument('--status', nargs='+', help='Filter by status (e.g., backlog todo in_progress)')
    push_parser.add_argument('--labels', help='Add labels to created issues (comma-separated)')
    push_parser.add_argument('--dry-run', action='store_true', help='Show what would be created without making changes')
    push_parser.add_argument('--verbose', '-v', action='store_true', help='Enable DEBUG level logging')

    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        return 1

    # Load environment variables from .env files
    load_dotenv()

    # Also try loading from project root .env
    project_root = Path.cwd()
    env_file = project_root / '.env'
    if env_file.exists():
        load_dotenv(env_file)

    # Also check .juno_task/.env
    juno_env_file = project_root / '.juno_task' / '.env'
    if juno_env_file.exists():
        load_dotenv(juno_env_file)

    # Also check .juno_task/github/.env (highest priority)
    github_env_file = project_root / '.juno_task' / 'github' / '.env'
    if github_env_file.exists():
        load_dotenv(github_env_file)

    # Setup logging
    setup_logging(verbose=args.verbose)

    try:
        # Route to subcommand handler
        if args.subcommand == 'fetch':
            return handle_fetch(args)
        elif args.subcommand == 'respond':
            return handle_respond(args)
        elif args.subcommand == 'sync':
            return handle_sync(args)
        elif args.subcommand == 'push':
            return handle_push(args)
        else:
            logger.error(f"Unknown subcommand: {args.subcommand}")
            return 1

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
