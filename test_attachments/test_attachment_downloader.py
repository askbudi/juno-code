#!/usr/bin/env python3
"""
Tests for the AttachmentDownloader module.

These tests verify:
- Filename sanitization and generation
- Collision handling
- Domain allowlist validation
- File type filtering
- Download functionality (mocked)
- Metadata file creation
"""

import json
import os
import pytest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

# Add the scripts directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / 'src' / 'templates' / 'scripts'))

try:
    import responses
    RESPONSES_AVAILABLE = True
except ImportError:
    RESPONSES_AVAILABLE = False

from attachment_downloader import (
    AttachmentDownloader,
    format_attachments_section,
    is_attachments_enabled,
    create_downloader
)


class TestAttachmentDownloader:
    """Tests for AttachmentDownloader class."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def downloader(self, temp_dir):
        """Create a downloader instance with temp directory."""
        return AttachmentDownloader(base_dir=temp_dir)

    # =========================================================================
    # Filename Generation Tests
    # =========================================================================

    def test_generate_safe_filename_basic(self, downloader):
        """Test basic filename generation."""
        result = downloader._generate_safe_filename("report.pdf", "1234567890")
        assert result == "1234567890_report.pdf"

    def test_generate_safe_filename_with_spaces(self, downloader):
        """Test filename with spaces is sanitized."""
        result = downloader._generate_safe_filename("Q4 Report Final.pdf", "123")
        assert result == "123_Q4_Report_Final.pdf"

    def test_generate_safe_filename_with_special_chars(self, downloader):
        """Test filename with special characters is sanitized."""
        result = downloader._generate_safe_filename("report (1) [final].pdf", "ts")
        # Trailing underscore is stripped after sanitization
        assert result == "ts_report_1_final.pdf"

    def test_generate_safe_filename_truncation(self, downloader):
        """Test long filenames are truncated."""
        long_name = "a" * 150 + ".pdf"
        result = downloader._generate_safe_filename(long_name, "123")
        # prefix (3) + underscore (1) + max stem (100) + extension (4) = 108
        assert len(result) <= 115

    def test_generate_safe_filename_empty_stem(self, downloader):
        """Test filename with only special characters."""
        result = downloader._generate_safe_filename("....pdf", "123")
        # The filename "....pdf" has stem "..." which becomes "..." after sanitization
        assert result == "123_....pdf"

    def test_generate_safe_filename_preserves_extension(self, downloader):
        """Test that file extension is preserved and lowercased."""
        result = downloader._generate_safe_filename("Report.PDF", "ts")
        assert result.endswith(".pdf")

    def test_generate_safe_filename_unicode(self, downloader):
        """Test filename with unicode characters."""
        result = downloader._generate_safe_filename("报告.pdf", "123")
        # Unicode should be replaced with underscores
        assert result.startswith("123_")
        assert result.endswith(".pdf")

    # =========================================================================
    # Collision Handling Tests
    # =========================================================================

    def test_handle_collision_no_existing(self, downloader, temp_dir):
        """Test path returned as-is when no collision."""
        target = Path(temp_dir) / "test.txt"
        result = downloader._handle_collision(target)
        assert result == target

    def test_handle_collision_single(self, downloader, temp_dir):
        """Test counter appended when file exists."""
        target = Path(temp_dir) / "test.txt"
        target.touch()

        result = downloader._handle_collision(target)
        assert result == Path(temp_dir) / "test_1.txt"

    def test_handle_collision_multiple(self, downloader, temp_dir):
        """Test multiple collisions handled correctly."""
        target = Path(temp_dir) / "test.txt"
        target.touch()
        (Path(temp_dir) / "test_1.txt").touch()
        (Path(temp_dir) / "test_2.txt").touch()

        result = downloader._handle_collision(target)
        assert result == Path(temp_dir) / "test_3.txt"

    # =========================================================================
    # Domain Validation Tests
    # =========================================================================

    def test_is_allowed_domain_slack_files(self, downloader):
        """Test Slack file domains are allowed."""
        assert downloader._is_allowed_domain("https://files.slack.com/files-pri/T123/F456/image.png")
        assert downloader._is_allowed_domain("https://files.slack.com/files/T123/F456")

    def test_is_allowed_domain_github(self, downloader):
        """Test GitHub domains are allowed."""
        assert downloader._is_allowed_domain("https://github.com/user/repo/assets/123")
        assert downloader._is_allowed_domain("https://user-images.githubusercontent.com/123/abc.png")
        assert downloader._is_allowed_domain("https://private-user-images.githubusercontent.com/123/abc.png")

    def test_is_allowed_domain_invalid(self, downloader):
        """Test non-allowed domains are rejected."""
        assert not downloader._is_allowed_domain("https://malicious.com/file.exe")
        assert not downloader._is_allowed_domain("https://example.com/test.pdf")
        assert not downloader._is_allowed_domain("https://dropbox.com/file.zip")

    def test_is_allowed_domain_subdomain(self, downloader):
        """Test subdomains of allowed domains work."""
        assert downloader._is_allowed_domain("https://api.github.com/download")

    def test_is_allowed_domain_malformed_url(self, downloader):
        """Test malformed URLs are rejected."""
        assert not downloader._is_allowed_domain("")
        assert not downloader._is_allowed_domain("not-a-url")

    # =========================================================================
    # File Type Filtering Tests
    # =========================================================================

    def test_download_rejects_exe(self, downloader, temp_dir):
        """Test .exe files are blocked."""
        path, error = downloader.download_file(
            url="https://github.com/user/repo/releases/app.exe",
            target_dir=Path(temp_dir),
            filename_prefix="123",
            original_filename="malware.exe"
        )
        assert path is None
        assert "File type not allowed" in error

    def test_download_rejects_dmg(self, downloader, temp_dir):
        """Test .dmg files are blocked."""
        path, error = downloader.download_file(
            url="https://github.com/user/repo/releases/app.dmg",
            target_dir=Path(temp_dir),
            filename_prefix="123",
            original_filename="installer.dmg"
        )
        assert path is None
        assert "File type not allowed" in error

    def test_download_rejects_blocked_domain(self, downloader, temp_dir):
        """Test blocked domains are rejected."""
        path, error = downloader.download_file(
            url="https://evil.com/malware.pdf",
            target_dir=Path(temp_dir),
            filename_prefix="123",
            original_filename="document.pdf"
        )
        assert path is None
        assert "Domain not allowed" in error

    # =========================================================================
    # Download Tests (with mocking)
    # =========================================================================

    @pytest.mark.skipif(not RESPONSES_AVAILABLE, reason="responses library not available")
    @responses.activate
    def test_download_file_success(self, downloader, temp_dir):
        """Test successful file download."""
        url = "https://files.slack.com/files-pri/T123/test.pdf"
        content = b"PDF content here"

        responses.add(
            responses.GET,
            url,
            body=content,
            status=200,
            headers={'content-length': str(len(content))}
        )

        target_dir = Path(temp_dir) / "downloads"
        path, error = downloader.download_file(
            url=url,
            target_dir=target_dir,
            filename_prefix="123456",
            original_filename="test.pdf",
            metadata={'source': 'slack', 'channel_id': 'C123'}
        )

        assert error is None
        assert path is not None
        assert Path(path).exists()
        assert Path(path + '.meta.json').exists()

        # Verify content
        with open(path, 'rb') as f:
            assert f.read() == content

        # Verify metadata
        with open(path + '.meta.json', 'r') as f:
            meta = json.load(f)
            assert meta['source'] == 'slack'
            assert meta['channel_id'] == 'C123'
            assert meta['original_filename'] == 'test.pdf'
            assert 'checksum_sha256' in meta

    @pytest.mark.skipif(not RESPONSES_AVAILABLE, reason="responses library not available")
    @responses.activate
    def test_download_file_too_large_header(self, downloader, temp_dir):
        """Test file rejection when content-length exceeds limit."""
        url = "https://files.slack.com/files-pri/T123/huge.zip"

        responses.add(
            responses.GET,
            url,
            body=b"x" * 100,  # Actual content doesn't matter
            status=200,
            headers={'content-length': str(100 * 1024 * 1024)}  # 100MB
        )

        target_dir = Path(temp_dir) / "downloads"
        path, error = downloader.download_file(
            url=url,
            target_dir=target_dir,
            filename_prefix="123",
            original_filename="huge.zip"
        )

        assert path is None
        assert "too large" in error.lower()

    @pytest.mark.skipif(not RESPONSES_AVAILABLE, reason="responses library not available")
    @responses.activate
    def test_download_file_http_error(self, downloader, temp_dir):
        """Test HTTP error handling."""
        url = "https://files.slack.com/files-pri/T123/missing.pdf"

        responses.add(
            responses.GET,
            url,
            status=404
        )

        target_dir = Path(temp_dir) / "downloads"
        path, error = downloader.download_file(
            url=url,
            target_dir=target_dir,
            filename_prefix="123",
            original_filename="missing.pdf"
        )

        assert path is None
        assert "HTTP error" in error or "404" in error

    # =========================================================================
    # Metadata Tests
    # =========================================================================

    def test_write_metadata(self, downloader, temp_dir):
        """Test metadata file is created correctly."""
        test_file = Path(temp_dir) / "test.txt"
        test_file.write_text("test")

        metadata = {
            'source': 'test',
            'original_filename': 'original.txt',
            'extra_field': 'value'
        }

        downloader._write_metadata(test_file, metadata)

        meta_path = Path(str(test_file) + '.meta.json')
        assert meta_path.exists()

        with open(meta_path, 'r') as f:
            saved_meta = json.load(f)
            assert saved_meta['source'] == 'test'
            assert saved_meta['original_filename'] == 'original.txt'
            assert saved_meta['extra_field'] == 'value'

    # =========================================================================
    # Directory Creation Tests
    # =========================================================================

    def test_ensure_directories(self, temp_dir):
        """Test directory structure is created."""
        downloader = AttachmentDownloader(base_dir=temp_dir)

        assert (Path(temp_dir) / 'slack').exists()
        assert (Path(temp_dir) / 'github').exists()


class TestFormatAttachmentsSection:
    """Tests for format_attachments_section function."""

    def test_format_with_files(self):
        """Test formatting with multiple files."""
        paths = [
            './.juno_task/attachments/slack/C123/1234_report.pdf',
            './.juno_task/attachments/slack/C123/1234_image.png'
        ]

        result = format_attachments_section(paths)
        assert '[attached files]' in result
        assert '- ./.juno_task/attachments/slack/C123/1234_report.pdf' in result
        assert '- ./.juno_task/attachments/slack/C123/1234_image.png' in result

    def test_format_empty_list(self):
        """Test formatting with no files."""
        result = format_attachments_section([])
        assert result == ""

    def test_format_single_file(self):
        """Test formatting with single file."""
        paths = ['./.juno_task/attachments/github/repo/issue_1_screen.png']
        result = format_attachments_section(paths)
        assert '[attached files]' in result
        assert '- ./.juno_task/attachments/github/repo/issue_1_screen.png' in result


class TestIsAttachmentsEnabled:
    """Tests for is_attachments_enabled function."""

    def test_default_enabled(self):
        """Test attachments are enabled by default."""
        # Clear any existing env var
        os.environ.pop('JUNO_DOWNLOAD_ATTACHMENTS', None)
        assert is_attachments_enabled() is True

    def test_explicitly_enabled(self):
        """Test explicit enable values."""
        for value in ['true', 'True', 'TRUE', '1', 'yes', 'YES']:
            os.environ['JUNO_DOWNLOAD_ATTACHMENTS'] = value
            assert is_attachments_enabled() is True
        os.environ.pop('JUNO_DOWNLOAD_ATTACHMENTS', None)

    def test_disabled(self):
        """Test disable values."""
        os.environ['JUNO_DOWNLOAD_ATTACHMENTS'] = 'false'
        assert is_attachments_enabled() is False

        os.environ['JUNO_DOWNLOAD_ATTACHMENTS'] = '0'
        assert is_attachments_enabled() is False

        os.environ.pop('JUNO_DOWNLOAD_ATTACHMENTS', None)


class TestCreateDownloader:
    """Tests for create_downloader factory function."""

    def test_create_with_defaults(self, tmp_path):
        """Test factory creates downloader with defaults."""
        downloader = create_downloader(str(tmp_path / 'attachments'))
        assert isinstance(downloader, AttachmentDownloader)
        assert downloader.base_dir == tmp_path / 'attachments'


class TestEnvironmentConfiguration:
    """Tests for environment variable configuration."""

    @pytest.fixture(autouse=True)
    def cleanup_env(self):
        """Clean up environment variables after each test."""
        yield
        for var in ['JUNO_MAX_ATTACHMENT_SIZE', 'JUNO_ALLOWED_FILE_TYPES',
                    'JUNO_SKIP_FILE_TYPES', 'JUNO_ALLOWED_DOMAINS']:
            os.environ.pop(var, None)

    def test_max_size_from_env(self, tmp_path):
        """Test max size configuration from environment."""
        os.environ['JUNO_MAX_ATTACHMENT_SIZE'] = '1048576'  # 1MB
        downloader = AttachmentDownloader(base_dir=str(tmp_path))
        assert downloader.max_size == 1048576

    def test_allowed_domains_from_env(self, tmp_path):
        """Test additional domains from environment."""
        os.environ['JUNO_ALLOWED_DOMAINS'] = 'my-cdn.example.com,storage.company.io'
        downloader = AttachmentDownloader(base_dir=str(tmp_path))

        assert downloader._is_allowed_domain('https://my-cdn.example.com/file.pdf')
        assert downloader._is_allowed_domain('https://storage.company.io/doc.txt')

    def test_allowed_file_types_from_env(self, tmp_path):
        """Test file type filtering from environment."""
        os.environ['JUNO_ALLOWED_FILE_TYPES'] = 'pdf,png'
        downloader = AttachmentDownloader(base_dir=str(tmp_path))

        # Only pdf and png should be allowed
        assert '.pdf' in downloader._allowed_types
        assert '.png' in downloader._allowed_types
        assert '.jpg' not in downloader._allowed_types

    def test_skip_file_types_from_env(self, tmp_path):
        """Test skip types from environment."""
        os.environ['JUNO_SKIP_FILE_TYPES'] = 'zip,tar,gz'
        downloader = AttachmentDownloader(base_dir=str(tmp_path))

        # These extensions should be in skip list
        assert '.zip' in downloader._skip_types
        assert '.tar' in downloader._skip_types
        assert '.gz' in downloader._skip_types


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
