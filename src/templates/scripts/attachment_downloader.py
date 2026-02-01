#!/usr/bin/env python3
"""
Shared attachment downloading utility for Slack and GitHub integrations.

This module provides a unified interface for downloading and storing attachments
from various sources (Slack file uploads, GitHub issue attachments).

Features:
- Domain allowlist security (only trusted sources)
- File type filtering (skip dangerous extensions)
- Collision-safe filename generation
- SHA256 checksums for integrity verification
- Metadata tracking for each download
- Retry logic with exponential backoff
- Size limits to prevent abuse

Usage:
    from attachment_downloader import AttachmentDownloader

    downloader = AttachmentDownloader('.juno_task/attachments')
    path, error = downloader.download_file(
        url='https://files.slack.com/...',
        target_dir=Path('.juno_task/attachments/slack/C123'),
        filename_prefix='1706789012_345678',
        original_filename='report.pdf',
        headers={'Authorization': 'Bearer xoxb-...'},
        metadata={'source': 'slack', 'channel_id': 'C123'}
    )

Version: 1.0.0
Package: juno-code@1.x.x
Auto-installed by: ScriptInstaller
"""

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    print("Error: Missing required dependency: requests")
    print("Please run: pip install requests")
    import sys
    sys.exit(1)

__version__ = "1.0.0"

logger = logging.getLogger(__name__)


class AttachmentDownloader:
    """Handles downloading and storing attachments from various sources."""

    # Configuration defaults
    DEFAULT_MAX_SIZE = 50 * 1024 * 1024  # 50MB
    DEFAULT_TIMEOUT = 60  # seconds
    DEFAULT_RETRIES = 3

    # Security: Only allow downloads from trusted domains
    ALLOWED_DOMAINS = [
        'files.slack.com',
        'slack-files.com',
        'files-pri',  # Slack private files pattern
        'github.com',
        'githubusercontent.com',
        'user-images.githubusercontent.com',
        'private-user-images.githubusercontent.com',
        'objects.githubusercontent.com',
    ]

    # File types to skip (security risk or too large)
    SKIP_EXTENSIONS = {'.exe', '.dmg', '.iso', '.msi', '.app', '.deb', '.rpm'}

    # Default allowed file types (can be overridden via env)
    DEFAULT_ALLOWED_TYPES = {
        '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
        '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml',
        '.log', '.html', '.htm', '.css', '.js', '.ts', '.py',
        '.sh', '.bash', '.zsh', '.toml', '.ini', '.conf',
        '.zip', '.tar', '.gz', '.bz2',
    }

    def __init__(
        self,
        base_dir: str = '.juno_task/attachments',
        max_size: Optional[int] = None,
        timeout: int = DEFAULT_TIMEOUT
    ):
        """
        Initialize AttachmentDownloader.

        Args:
            base_dir: Base directory for storing attachments
            max_size: Maximum file size in bytes (default: 50MB)
            timeout: Download timeout in seconds
        """
        self.base_dir = Path(base_dir)
        self.max_size = max_size or int(os.getenv('JUNO_MAX_ATTACHMENT_SIZE', self.DEFAULT_MAX_SIZE))
        self.timeout = timeout

        # Parse allowed/skip types from environment
        self._allowed_types = self._parse_env_types('JUNO_ALLOWED_FILE_TYPES', self.DEFAULT_ALLOWED_TYPES)
        self._skip_types = self._parse_env_types('JUNO_SKIP_FILE_TYPES', self.SKIP_EXTENSIONS)

        # Additional allowed domains from environment
        extra_domains = os.getenv('JUNO_ALLOWED_DOMAINS', '')
        if extra_domains:
            self.ALLOWED_DOMAINS = list(self.ALLOWED_DOMAINS) + [d.strip() for d in extra_domains.split(',')]

        self._ensure_directories()

    def _parse_env_types(self, env_var: str, default: set) -> set:
        """Parse file types from environment variable."""
        env_value = os.getenv(env_var, '')
        if not env_value:
            return default
        if env_value.lower() == 'all':
            return set()  # Empty set means allow all
        types = {t.strip().lower() for t in env_value.split(',')}
        # Ensure extensions start with dot
        return {t if t.startswith('.') else f'.{t}' for t in types if t}

    def _ensure_directories(self) -> None:
        """Create directory structure."""
        (self.base_dir / 'slack').mkdir(parents=True, exist_ok=True)
        (self.base_dir / 'github').mkdir(parents=True, exist_ok=True)

    def download_file(
        self,
        url: str,
        target_dir: Path,
        filename_prefix: str,
        original_filename: str,
        headers: Optional[Dict[str, str]] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Download a file and save with metadata.

        Args:
            url: URL to download from
            target_dir: Directory to save the file
            filename_prefix: Prefix for the filename (e.g., timestamp or ID)
            original_filename: Original filename for extension preservation
            headers: HTTP headers for authentication
            metadata: Additional metadata to store with the file

        Returns:
            Tuple of (local_path, error_message)
            - On success: (path_string, None)
            - On failure: (None, error_message)
        """
        # Validate URL domain
        if not self._is_allowed_domain(url):
            domain = urlparse(url).netloc
            logger.warning(f"Domain not allowed: {domain}")
            return None, f"Domain not allowed: {domain}"

        # Validate file type
        ext = Path(original_filename).suffix.lower()
        if ext in self._skip_types:
            logger.warning(f"File type not allowed: {ext}")
            return None, f"File type not allowed: {ext}"

        # Check allowed types (if set is non-empty, only those types are allowed)
        if self._allowed_types and ext and ext not in self._allowed_types:
            logger.warning(f"File type not in allowlist: {ext}")
            return None, f"File type not in allowlist: {ext}"

        # Generate safe filename
        safe_filename = self._generate_safe_filename(original_filename, filename_prefix)
        target_path = target_dir / safe_filename

        # Handle collision
        target_path = self._handle_collision(target_path)

        # Download with retries
        for attempt in range(self.DEFAULT_RETRIES):
            try:
                response = requests.get(
                    url,
                    headers=headers or {},
                    timeout=self.timeout,
                    stream=True,
                    allow_redirects=True
                )
                response.raise_for_status()

                # Check content length if available
                content_length = int(response.headers.get('content-length', 0))
                if content_length > self.max_size:
                    return None, f"File too large: {content_length:,} bytes (max: {self.max_size:,})"

                # Ensure target directory exists
                target_dir.mkdir(parents=True, exist_ok=True)

                # Download in chunks
                sha256_hash = hashlib.sha256()
                total_bytes = 0

                with open(target_path, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            # Check size during download (for when content-length not provided)
                            total_bytes += len(chunk)
                            if total_bytes > self.max_size:
                                f.close()
                                target_path.unlink()
                                return None, f"File exceeded max size during download ({total_bytes:,} bytes)"
                            f.write(chunk)
                            sha256_hash.update(chunk)

                # Create metadata file
                full_metadata = {
                    'original_filename': original_filename,
                    'downloaded_at': datetime.now(timezone.utc).isoformat(),
                    'file_size': total_bytes,
                    'checksum_sha256': sha256_hash.hexdigest(),
                    'download_url': url
                }
                if metadata:
                    full_metadata.update(metadata)

                self._write_metadata(target_path, full_metadata)

                logger.info(f"Downloaded: {original_filename} -> {target_path} ({total_bytes:,} bytes)")
                return str(target_path), None

            except requests.exceptions.Timeout:
                logger.warning(f"Timeout downloading {url} (attempt {attempt + 1}/{self.DEFAULT_RETRIES})")
                if attempt < self.DEFAULT_RETRIES - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff
            except requests.exceptions.HTTPError as e:
                status = e.response.status_code if e.response is not None else 'unknown'
                logger.error(f"HTTP error downloading {url}: {status}")
                return None, f"HTTP error: {status}"
            except requests.exceptions.RequestException as e:
                logger.error(f"Request error downloading {url}: {e}")
                return None, f"Request error: {str(e)}"
            except IOError as e:
                logger.error(f"IO error saving file: {e}")
                return None, f"IO error: {str(e)}"
            except Exception as e:
                logger.error(f"Unexpected error downloading {url}: {e}")
                return None, f"Download error: {str(e)}"

        return None, f"Max retries exceeded ({self.DEFAULT_RETRIES})"

    def _generate_safe_filename(self, original_name: str, prefix: str) -> str:
        """
        Generate safe filename with prefix.

        Args:
            original_name: Original filename
            prefix: Prefix to add (e.g., message timestamp)

        Returns:
            Sanitized filename: {prefix}_{sanitized_stem}{extension}
        """
        path = Path(original_name)
        ext = path.suffix.lower()
        stem = path.stem

        # Sanitize stem: replace unsafe characters with underscores
        stem = re.sub(r'[^\w\-.]', '_', stem)
        stem = re.sub(r'_+', '_', stem)  # Collapse multiple underscores
        stem = stem.strip('_')

        # Ensure stem is not empty
        if not stem:
            stem = 'file'

        # Truncate if needed (preserve reasonable length)
        max_stem_len = 100
        if len(stem) > max_stem_len:
            stem = stem[:max_stem_len]

        # Sanitize prefix
        safe_prefix = re.sub(r'[^\w\-]', '_', prefix)
        safe_prefix = re.sub(r'_+', '_', safe_prefix).strip('_')

        return f"{safe_prefix}_{stem}{ext}"

    def _handle_collision(self, target_path: Path) -> Path:
        """
        Handle filename collision by appending counter.

        Args:
            target_path: Intended file path

        Returns:
            Path that doesn't exist (original or with counter suffix)
        """
        if not target_path.exists():
            return target_path

        counter = 1
        stem = target_path.stem
        suffix = target_path.suffix
        parent = target_path.parent

        while True:
            new_path = parent / f"{stem}_{counter}{suffix}"
            if not new_path.exists():
                logger.debug(f"Collision detected, using: {new_path}")
                return new_path
            counter += 1
            if counter > 1000:  # Safety limit
                # Use timestamp as fallback
                ts = int(time.time() * 1000)
                return parent / f"{stem}_{ts}{suffix}"

    def _is_allowed_domain(self, url: str) -> bool:
        """
        Check if URL domain is in allowlist.

        Args:
            url: URL to check

        Returns:
            True if domain is allowed, False otherwise
        """
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower()
            # Check if any allowed domain is a suffix of or matches the URL domain
            for allowed in self.ALLOWED_DOMAINS:
                allowed_lower = allowed.lower()
                if domain == allowed_lower or domain.endswith('.' + allowed_lower):
                    return True
                # Also check if the allowed pattern is contained (for patterns like 'files-pri')
                if allowed_lower in domain:
                    return True
            return False
        except Exception as e:
            logger.error(f"Error parsing URL {url}: {e}")
            return False

    def _write_metadata(self, filepath: Path, metadata: Dict[str, Any]) -> None:
        """
        Write metadata JSON file alongside downloaded file.

        Args:
            filepath: Path to the downloaded file
            metadata: Metadata dictionary to save
        """
        meta_path = Path(str(filepath) + '.meta.json')
        try:
            with open(meta_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)
            logger.debug(f"Wrote metadata: {meta_path}")
        except Exception as e:
            logger.warning(f"Failed to write metadata to {meta_path}: {e}")


def format_attachments_section(file_paths: List[str]) -> str:
    """
    Format file paths as attachment section for kanban task.

    Args:
        file_paths: List of local file paths

    Returns:
        Formatted string with [attached files] section, or empty string if no files
    """
    if not file_paths:
        return ""

    lines = ["\n\n[attached files]"]
    for path in file_paths:
        lines.append(f"- {path}")

    return '\n'.join(lines)


def is_attachments_enabled() -> bool:
    """
    Check if attachment downloading is enabled.

    Returns:
        True if enabled (default), False if explicitly disabled
    """
    return os.getenv('JUNO_DOWNLOAD_ATTACHMENTS', 'true').lower() in ('true', '1', 'yes')


# Convenience functions for direct script usage
def create_downloader(base_dir: str = '.juno_task/attachments') -> AttachmentDownloader:
    """
    Factory function to create an AttachmentDownloader with default settings.

    Args:
        base_dir: Base directory for attachments

    Returns:
        Configured AttachmentDownloader instance
    """
    return AttachmentDownloader(base_dir=base_dir)
