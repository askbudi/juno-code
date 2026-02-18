#!/usr/bin/env bash

# install_requirements.sh
#
# Purpose: Install Python dependencies required for juno-code
#
# This script:
# 1. Checks if 'pipx' (recommended for app installations) is installed
# 2. Falls back to 'uv' (ultrafast Python package manager) if 'pipx' not available
# 3. Falls back to 'pip' if neither 'pipx' nor 'uv' is available
# 4. Detects externally managed Python (PEP 668) on Ubuntu/Debian systems
# 5. Handles installation based on environment:
#    - If inside venv: installs into venv
#    - If externally managed Python detected: uses pipx or creates temporary venv
#    - If outside venv (non-managed): uses --system flag for system-wide installation
# 6. Installs required packages: juno-kanban, roundtable-ai
# 7. Reports if requirements are already satisfied
#
# Usage: ./install_requirements.sh
#
# Created by: juno-code init command
# Date: Auto-generated during project initialization

set -euo pipefail  # Exit on error, undefined variable, or pipe failure

# Handle --help early (before any debug output)
for arg in "$@"; do
    if [[ "$arg" == "-h" ]] || [[ "$arg" == "--help" ]]; then
        echo "Usage: install_requirements.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --check-updates   Only check for updates without installing"
        echo "  --force-update    Force update check and upgrade packages"
        echo "  -h, --help        Show this help message"
        echo ""
        echo "Environment Variables:"
        echo "  VERSION_CHECK_INTERVAL_HOURS   Hours between automatic update checks (default: 24)"
        exit 0
    fi
done

# DEBUG OUTPUT: Show that install_requirements.sh is being executed
# User feedback: "Add a one line printing from .sh file as well so we could debug it"
echo "[DEBUG] install_requirements.sh is being executed from: $(pwd)" >&2
echo "[DEBUG] .venv_juno will be created in: $(pwd)/.venv_juno" >&2

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Required packages
# Note: requests and python-dotenv are required by github.py
# slack_sdk is required by Slack integration scripts (slack_fetch.py, slack_respond.py)
REQUIRED_PACKAGES=("juno-kanban" "roundtable-ai" "requests" "python-dotenv" "slack_sdk")

# Version check cache configuration
# This ensures we don't check PyPI on every run (performance optimization per Task RTafs5)
VERSION_CHECK_CACHE_DIR="${HOME}/.juno_code"
VERSION_CHECK_CACHE_FILE="${VERSION_CHECK_CACHE_DIR}/.version_check_cache"
VERSION_CHECK_INTERVAL_HOURS=24  # Check for updates once per day

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a Python package is installed
check_package_installed() {
    local package_name="$1"

    # Try using python -m pip show (most reliable)
    if python3 -m pip show "$package_name" &>/dev/null || python -m pip show "$package_name" &>/dev/null; then
        return 0  # Package is installed
    fi

    return 1  # Package not installed
}

# Function to get installed version of a package
get_installed_version() {
    local package_name="$1"
    local version=""

    # Try python3 first, then python
    version=$(python3 -m pip show "$package_name" 2>/dev/null | grep -i "^Version:" | awk '{print $2}')
    if [ -z "$version" ]; then
        version=$(python -m pip show "$package_name" 2>/dev/null | grep -i "^Version:" | awk '{print $2}')
    fi

    echo "$version"
}

# Function to get latest version from PyPI
get_pypi_latest_version() {
    local package_name="$1"
    local version=""

    # Use curl to fetch from PyPI JSON API (lightweight and fast)
    if command -v curl &>/dev/null; then
        version=$(curl -s --max-time 5 "https://pypi.org/pypi/${package_name}/json" 2>/dev/null | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
    fi

    echo "$version"
}

# Function to check if version check cache is stale
is_version_check_stale() {
    # Ensure cache directory exists
    if [ ! -d "$VERSION_CHECK_CACHE_DIR" ]; then
        mkdir -p "$VERSION_CHECK_CACHE_DIR"
        return 0  # No cache, needs check
    fi

    # Check if cache file exists
    if [ ! -f "$VERSION_CHECK_CACHE_FILE" ]; then
        return 0  # No cache file, needs check
    fi

    # Get cache file modification time and current time
    local cache_mtime
    local current_time
    local age_hours

    # Cross-platform way to get file age
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        cache_mtime=$(stat -f %m "$VERSION_CHECK_CACHE_FILE" 2>/dev/null || echo 0)
    else
        # Linux and others
        cache_mtime=$(stat -c %Y "$VERSION_CHECK_CACHE_FILE" 2>/dev/null || echo 0)
    fi

    current_time=$(date +%s)
    age_hours=$(( (current_time - cache_mtime) / 3600 ))

    if [ "$age_hours" -ge "$VERSION_CHECK_INTERVAL_HOURS" ]; then
        return 0  # Cache is stale, needs check
    fi

    return 1  # Cache is fresh, no check needed
}

# Function to update version check cache
update_version_check_cache() {
    local package_name="$1"
    local installed_version="$2"
    local latest_version="$3"

    # Ensure cache directory exists
    mkdir -p "$VERSION_CHECK_CACHE_DIR"

    # Update cache file with package info
    local cache_line="${package_name}=${installed_version}:${latest_version}"

    # Remove old entry for this package if exists, then add new entry
    if [ -f "$VERSION_CHECK_CACHE_FILE" ]; then
        grep -v "^${package_name}=" "$VERSION_CHECK_CACHE_FILE" > "${VERSION_CHECK_CACHE_FILE}.tmp" 2>/dev/null || true
        mv "${VERSION_CHECK_CACHE_FILE}.tmp" "$VERSION_CHECK_CACHE_FILE"
    fi

    echo "$cache_line" >> "$VERSION_CHECK_CACHE_FILE"

    # Touch the file to update modification time
    touch "$VERSION_CHECK_CACHE_FILE"
}

# Function to check and upgrade a single package if needed
check_and_upgrade_package() {
    local package_name="$1"
    local force_check="${2:-false}"

    # Only check if cache is stale or force_check is true
    if [ "$force_check" != "true" ] && ! is_version_check_stale; then
        log_info "Version check cache is fresh (checked within ${VERSION_CHECK_INTERVAL_HOURS}h)"
        return 0
    fi

    log_info "Checking for updates for: $package_name"

    local installed_version
    local latest_version

    installed_version=$(get_installed_version "$package_name")

    if [ -z "$installed_version" ]; then
        log_warning "$package_name is not installed"
        return 1  # Package not installed
    fi

    latest_version=$(get_pypi_latest_version "$package_name")

    if [ -z "$latest_version" ]; then
        log_warning "Could not fetch latest version for $package_name from PyPI"
        return 0  # Can't check, assume OK
    fi

    # Update cache
    update_version_check_cache "$package_name" "$installed_version" "$latest_version"

    if [ "$installed_version" = "$latest_version" ]; then
        log_success "$package_name is up-to-date (v$installed_version)"
        return 0
    fi

    log_warning "$package_name update available: $installed_version -> $latest_version"
    return 2  # Update available
}

# Function to upgrade packages
upgrade_packages() {
    local packages_to_upgrade=("$@")

    if [ ${#packages_to_upgrade[@]} -eq 0 ]; then
        return 0
    fi

    log_info "Upgrading packages: ${packages_to_upgrade[*]}"

    # Determine which package manager to use (prefer uv for speed)
    if command -v uv &>/dev/null; then
        for package in "${packages_to_upgrade[@]}"; do
            log_info "Upgrading $package with uv..."
            if uv pip install --upgrade "$package" --quiet 2>/dev/null; then
                log_success "Upgraded: $package"
            else
                log_warning "Failed to upgrade $package with uv, trying pip..."
                python3 -m pip install --upgrade "$package" --quiet 2>/dev/null || true
            fi
        done
    elif command -v pipx &>/dev/null && is_externally_managed_python && ! is_in_virtualenv; then
        for package in "${packages_to_upgrade[@]}"; do
            log_info "Upgrading $package with pipx..."
            if pipx upgrade "$package" 2>/dev/null; then
                log_success "Upgraded: $package"
            else
                log_warning "Failed to upgrade $package"
            fi
        done
    else
        for package in "${packages_to_upgrade[@]}"; do
            log_info "Upgrading $package with pip..."
            if python3 -m pip install --upgrade "$package" --quiet 2>/dev/null; then
                log_success "Upgraded: $package"
            else
                log_warning "Failed to upgrade $package"
            fi
        done
    fi
}

# Function to check all packages for updates (periodic check)
check_all_for_updates() {
    local force_check="${1:-false}"
    local packages_needing_upgrade=()

    # Skip check if cache is fresh and not forcing
    if [ "$force_check" != "true" ] && ! is_version_check_stale; then
        return 0
    fi

    log_info "Performing periodic version check..."

    for package in "${REQUIRED_PACKAGES[@]}"; do
        check_and_upgrade_package "$package" "true"
        local result=$?
        if [ $result -eq 2 ]; then
            packages_needing_upgrade+=("$package")
        fi
    done

    if [ ${#packages_needing_upgrade[@]} -gt 0 ]; then
        upgrade_packages "${packages_needing_upgrade[@]}"
    else
        log_success "All packages are up-to-date"
    fi
}

# Function to check if all requirements are satisfied
check_all_requirements_satisfied() {
    local all_satisfied=true

    for package in "${REQUIRED_PACKAGES[@]}"; do
        if ! check_package_installed "$package"; then
            all_satisfied=false
            break
        fi
    done

    if [ "$all_satisfied" = true ]; then
        return 0  # All requirements satisfied
    else
        return 1  # Some requirements missing
    fi
}

# Function to check if we're inside a virtual environment
is_in_virtualenv() {
    # Check for VIRTUAL_ENV environment variable (most common indicator)
    if [ -n "${VIRTUAL_ENV:-}" ]; then
        return 0  # Inside venv
    fi

    # Check for CONDA_DEFAULT_ENV (conda environments)
    if [ -n "${CONDA_DEFAULT_ENV:-}" ]; then
        return 0  # Inside conda env
    fi

    # Check if sys.prefix != sys.base_prefix (Python way to detect venv)
    if command -v python3 &> /dev/null; then
        if python3 -c "import sys; exit(0 if sys.prefix != sys.base_prefix else 1)" 2>/dev/null; then
            return 0  # Inside venv
        fi
    fi

    return 1  # Not inside venv
}

# Function to find the best Python version (3.10-3.13, preferably 3.13)
find_best_python() {
    # Try to find Python in order of preference: 3.13, 3.12, 3.11, 3.10
    local python_versions=("python3.13" "python3.12" "python3.11" "python3.10")

    for py_cmd in "${python_versions[@]}"; do
        if command -v "$py_cmd" &> /dev/null; then
            # Verify it's actually the right version
            local version
            version=$($py_cmd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
            local major
            major=$(echo "$version" | cut -d'.' -f1)
            local minor
            minor=$(echo "$version" | cut -d'.' -f2)

            # Check if version is 3.10 or higher
            if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ]; then
                echo "$py_cmd"
                return 0
            fi
        fi
    done

    # Fall back to python3 if available and check its version
    if command -v python3 &> /dev/null; then
        local version
        version=$(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
        local major
        major=$(echo "$version" | cut -d'.' -f1)
        local minor
        minor=$(echo "$version" | cut -d'.' -f2)

        # Check if version is 3.10 or higher
        if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ]; then
            echo "python3"
            return 0
        else
            # Python3 exists but is too old
            log_error "Found Python $version, but Python 3.10+ is required"
            return 1
        fi
    fi

    # No suitable Python found
    log_error "No Python 3.10+ found. Please install Python 3.10, 3.11, 3.12, or 3.13 (preferably 3.13)"
    return 1
}

# Function to check if Python is externally managed (PEP 668)
# This is common on Ubuntu 23.04+, Debian, and other modern Linux distros
is_externally_managed_python() {
    # Check for EXTERNALLY-MANAGED marker file
    local python_cmd="python3"
    if ! command -v python3 &> /dev/null; then
        if command -v python &> /dev/null; then
            python_cmd="python"
        else
            return 1  # Python not found, can't determine
        fi
    fi

    # Get the stdlib directory and check for EXTERNALLY-MANAGED file
    local stdlib_dir
    stdlib_dir=$($python_cmd -c "import sysconfig; print(sysconfig.get_path('stdlib'))" 2>/dev/null || echo "")

    if [ -n "$stdlib_dir" ] && [ -f "$stdlib_dir/EXTERNALLY-MANAGED" ]; then
        return 0  # Externally managed
    fi

    return 1  # Not externally managed
}

# Function to install packages using pipx
install_with_pipx() {
    log_info "Installing packages using 'pipx' (recommended for Python applications)..."

    local failed_packages=()

    for package in "${REQUIRED_PACKAGES[@]}"; do
        log_info "Installing: $package"
        if pipx install "$package" --force &>/dev/null || pipx install "$package" &>/dev/null; then
            log_success "Successfully installed: $package"
        else
            log_error "Failed to install: $package"
            failed_packages+=("$package")
        fi
    done

    if [ ${#failed_packages[@]} -gt 0 ]; then
        log_error "Failed to install ${#failed_packages[@]} package(s): ${failed_packages[*]}"
        return 1
    fi

    return 0
}

# Function to install packages using uv with externally managed Python handling
install_with_uv() {
    log_info "Installing packages using 'uv' (ultrafast Python package manager)..."

    local uv_flags="--quiet"

    # CRITICAL FIX: Properly detect if uv will work in the current environment
    # User feedback: "Maybe the way you are verifying being inside venv by uv is not correct !!!"
    # Previous approach failed because uv pip list doesn't reliably indicate venv compatibility
    # NEW APPROACH: Always create .venv_juno unless we're already inside it

    local venv_path=".venv_juno"
    local need_venv=true

    # Check if we're already inside .venv_juno
    if [ -n "${VIRTUAL_ENV:-}" ] && ( [[ "${VIRTUAL_ENV:-}" == *"/.venv_juno" ]] || [[ "${VIRTUAL_ENV:-}" == *".venv_juno"* ]] ); then
        log_info "Already inside .venv_juno virtual environment"
        need_venv=false
    # Check if we're in .venv_juno by checking the activate script path
    elif [ -n "${VIRTUAL_ENV:-}" ] && [ "$(basename "${VIRTUAL_ENV:-}")" = ".venv_juno" ]; then
        log_info "Already inside .venv_juno virtual environment"
        need_venv=false
    fi

    # If we need a venv, create and activate .venv_juno
    if [ "$need_venv" = true ]; then
        log_info "Creating/using .venv_juno virtual environment for reliable uv installation..."

        # Find best Python version (3.10-3.13, preferably 3.13)
        local python_cmd
        if ! python_cmd=$(find_best_python); then
            log_error "Cannot create venv: No suitable Python version found"
            log_info "Please install Python 3.10+ (preferably Python 3.13)"
            log_info "  Mac: brew install python@3.13"
            log_info "  Ubuntu/Debian: sudo apt install python3.13 python3.13-venv"
            return 1
        fi

        local version
        version=$($python_cmd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
        log_info "Using Python $version for virtual environment"

        # Create a project-local venv if it doesn't exist
        if [ ! -d "$venv_path" ]; then
            log_info "Creating virtual environment with $python_cmd..."
            if ! $python_cmd -m venv "$venv_path" 2>/dev/null; then
                log_error "Failed to create virtual environment"
                log_info "Please ensure python venv module is installed:"
                log_info "  Mac: brew install python@3.13"
                log_info "  Ubuntu/Debian: sudo apt install python3.13-venv python3-full"
                return 1
            fi
            log_success "Created virtual environment at $venv_path with Python $version"
        else
            log_info "Using existing virtual environment at $venv_path"
        fi

        # Activate the venv for this script
        # shellcheck disable=SC1091
        if [ -f "$venv_path/bin/activate" ]; then
            source "$venv_path/bin/activate"
            log_success "Activated virtual environment - uv will now install into .venv_juno"
        else
            log_error "Virtual environment activation script not found"
            return 1
        fi
    fi

    local failed_packages=()

    for package in "${REQUIRED_PACKAGES[@]}"; do
        log_info "Installing: $package"
        if uv pip install "$package" $uv_flags; then
            log_success "Successfully installed: $package"
        else
            log_error "Failed to install: $package"
            failed_packages+=("$package")
        fi
    done

    if [ ${#failed_packages[@]} -gt 0 ]; then
        log_error "Failed to install ${#failed_packages[@]} package(s): ${failed_packages[*]}"
        return 1
    fi

    return 0
}

# Function to install packages using pip with externally managed Python handling
install_with_pip() {
    log_info "Installing packages using 'pip'..."

    # Detect python command (python3 or python)
    local python_cmd="python3"
    if ! command -v python3 &> /dev/null; then
        if command -v python &> /dev/null; then
            python_cmd="python"
        else
            log_error "Python not found. Please install Python 3."
            return 1
        fi
    fi

    # Handle externally managed Python or missing venv
    if ! is_in_virtualenv && is_externally_managed_python; then
        log_warning "Detected externally managed Python (PEP 668) - Ubuntu/Debian system"
        log_info "Creating virtual environment for installation..."

        # Find best Python version (3.10-3.13, preferably 3.13)
        if ! python_cmd=$(find_best_python); then
            log_error "Cannot create venv: No suitable Python version found"
            log_info "Please install Python 3.10+ (preferably Python 3.13)"
            log_info "  Ubuntu/Debian: sudo apt install python3.13 python3.13-venv"
            return 1
        fi

        local version
        version=$($python_cmd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
        log_info "Using Python $version for virtual environment"

        # Create a project-local venv if it doesn't exist
        local venv_path=".venv_juno"
        if [ ! -d "$venv_path" ]; then
            if ! $python_cmd -m venv "$venv_path" 2>/dev/null; then
                log_error "Failed to create virtual environment"
                log_info "Please install python3-venv (Linux: sudo apt install python3.13-venv python3-full)"
                return 1
            fi
            log_success "Created virtual environment at $venv_path with Python $version"
        fi

        # Activate the venv for this script
        # shellcheck disable=SC1091
        source "$venv_path/bin/activate"
        log_success "Activated virtual environment"
        python_cmd="python"  # Use the venv's python
    fi

    local failed_packages=()

    for package in "${REQUIRED_PACKAGES[@]}"; do
        log_info "Installing: $package"
        if $python_cmd -m pip install "$package" --quiet; then
            log_success "Successfully installed: $package"
        else
            log_error "Failed to install: $package"
            failed_packages+=("$package")
        fi
    done

    if [ ${#failed_packages[@]} -gt 0 ]; then
        log_error "Failed to install ${#failed_packages[@]} package(s): ${failed_packages[*]}"
        return 1
    fi

    return 0
}

# Main installation logic
main() {
    local force_update=false
    local check_updates_only=false

    # Parse command line arguments (--help is handled early, before debug output)
    while [[ $# -gt 0 ]]; do
        case $1 in
            --force-update)
                force_update=true
                shift
                ;;
            --check-updates)
                check_updates_only=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    echo ""
    log_info "=== Python Requirements Installation ==="
    echo ""

    # Handle --check-updates: just check and report, don't install
    if [ "$check_updates_only" = true ]; then
        log_info "Checking for updates..."
        for package in "${REQUIRED_PACKAGES[@]}"; do
            local installed_ver
            local latest_ver
            installed_ver=$(get_installed_version "$package")
            latest_ver=$(get_pypi_latest_version "$package")

            if [ -z "$installed_ver" ]; then
                log_warning "$package is not installed"
            elif [ -z "$latest_ver" ]; then
                log_info "$package: v$installed_ver (could not check PyPI)"
            elif [ "$installed_ver" = "$latest_ver" ]; then
                log_success "$package: v$installed_ver (up-to-date)"
            else
                log_warning "$package: v$installed_ver -> v$latest_ver (update available)"
            fi
        done
        exit 0
    fi

    # Step 1: Check if all requirements are already satisfied
    log_info "Checking if requirements are already satisfied..."

    if check_all_requirements_satisfied; then
        log_success "All requirements already satisfied!"
        echo ""
        log_info "Installed packages:"
        for package in "${REQUIRED_PACKAGES[@]}"; do
            local ver
            ver=$(get_installed_version "$package")
            echo "  ✓ $package (v$ver)"
        done
        echo ""

        # Step 1b: Periodic update check (only when cache is stale, or forced)
        # This ensures dependencies stay up-to-date without degrading performance
        check_all_for_updates "$force_update"
        exit 0
    fi

    log_info "Some packages need to be installed."
    echo ""

    # Step 2: Determine which package manager to use
    local installer=""

    # Check if Python is externally managed (Ubuntu/Debian PEP 668)
    local is_ext_managed=false
    if is_externally_managed_python && ! is_in_virtualenv; then
        is_ext_managed=true
        log_warning "Detected externally managed Python environment (Ubuntu/Debian PEP 668)"
    fi

    # Prioritize pipx for externally managed systems
    if [ "$is_ext_managed" = true ] && command -v pipx &> /dev/null; then
        log_success "'pipx' found - using pipx (recommended for externally managed Python)"
        installer="pipx"
    elif command -v uv &> /dev/null; then
        log_success "'uv' found - using ultrafast Python package manager"
        installer="uv"
    elif command -v pip3 &> /dev/null || command -v pip &> /dev/null; then
        log_success "'pip' found - using standard Python package installer"
        installer="pip"
    else
        # No package manager found
        log_error "No suitable package manager found!"
        echo ""
        log_info "Please install one of the following:"
        echo ""
        if [ "$is_ext_managed" = true ]; then
            echo "  Option 1: Install 'pipx' (RECOMMENDED for Ubuntu/Debian)"
            echo "    sudo apt install pipx"
            echo "    pipx ensurepath"
            echo ""
        fi
        echo "  Option 2: Install 'uv' (ultrafast Python package manager)"
        echo "    curl -LsSf https://astral.sh/uv/install.sh | sh"
        echo "    OR"
        echo "    brew install uv  (macOS)"
        echo ""
        echo "  Option 3: Install 'pip' (standard Python package manager)"
        echo "    python3 -m ensurepip --upgrade"
        echo "    OR"
        echo "    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py && python3 get-pip.py"
        echo ""
        if [ "$is_ext_managed" = true ]; then
            log_info "Note: On Ubuntu/Debian with externally managed Python, 'pipx' is recommended"
            log_info "Alternatively, install python3-venv: sudo apt install python3-venv python3-full"
        fi
        echo ""
        exit 1
    fi

    # Step 3: Install packages
    echo ""
    log_info "Installing required packages: ${REQUIRED_PACKAGES[*]}"
    echo ""

    if [ "$installer" = "pipx" ]; then
        if install_with_pipx; then
            echo ""
            log_success "All packages installed successfully using 'pipx'!"
            log_info "Packages installed in isolated environments and added to PATH"
            echo ""
            exit 0
        else
            log_error "Some packages failed to install with 'pipx'"
            exit 1
        fi
    elif [ "$installer" = "uv" ]; then
        if install_with_uv; then
            echo ""
            log_success "All packages installed successfully using 'uv'!"
            if [ -d ".venv_juno" ]; then
                log_info "Packages installed in virtual environment: .venv_juno"
                log_info "To use them, activate the venv: source .venv_juno/bin/activate"
            fi
            echo ""
            exit 0
        else
            log_error "Some packages failed to install with 'uv'"
            exit 1
        fi
    elif [ "$installer" = "pip" ]; then
        if install_with_pip; then
            echo ""
            log_success "All packages installed successfully using 'pip'!"
            if [ -d ".venv_juno" ]; then
                log_info "Packages installed in virtual environment: .venv_juno"
                log_info "To use them, activate the venv: source .venv_juno/bin/activate"
            fi
            echo ""
            exit 0
        else
            log_error "Some packages failed to install with 'pip'"
            exit 1
        fi
    fi

    # Should not reach here
    log_error "Unexpected error during installation"
    exit 1
}

# Run main function
main "$@"
