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

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Required packages
REQUIRED_PACKAGES=("juno-kanban" "roundtable-ai")

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

    if is_in_virtualenv; then
        log_info "Detected virtual environment - installing into venv"
    elif is_externally_managed_python; then
        log_warning "Detected externally managed Python (PEP 668) - Ubuntu/Debian system"
        log_info "Creating temporary virtual environment for installation..."

        # Create a project-local venv if it doesn't exist
        local venv_path=".juno_venv"
        if [ ! -d "$venv_path" ]; then
            if ! python3 -m venv "$venv_path" 2>/dev/null; then
                log_error "Failed to create virtual environment"
                log_info "Please install python3-venv: sudo apt install python3-venv python3-full"
                return 1
            fi
            log_success "Created virtual environment at $venv_path"
        fi

        # Activate the venv for this script
        # shellcheck disable=SC1091
        source "$venv_path/bin/activate"
        log_success "Activated virtual environment"
    else
        log_info "Not in a virtual environment - using --system flag for system-wide installation"
        uv_flags="--quiet --system"
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

    # Handle externally managed Python
    if ! is_in_virtualenv && is_externally_managed_python; then
        log_warning "Detected externally managed Python (PEP 668) - Ubuntu/Debian system"
        log_info "Creating temporary virtual environment for installation..."

        # Create a project-local venv if it doesn't exist
        local venv_path=".juno_venv"
        if [ ! -d "$venv_path" ]; then
            if ! $python_cmd -m venv "$venv_path" 2>/dev/null; then
                log_error "Failed to create virtual environment"
                log_info "Please install python3-venv: sudo apt install python3-venv python3-full"
                return 1
            fi
            log_success "Created virtual environment at $venv_path"
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
    echo ""
    log_info "=== Python Requirements Installation ==="
    echo ""

    # Step 1: Check if all requirements are already satisfied
    log_info "Checking if requirements are already satisfied..."

    if check_all_requirements_satisfied; then
        log_success "All requirements already satisfied!"
        echo ""
        log_info "Installed packages:"
        for package in "${REQUIRED_PACKAGES[@]}"; do
            echo "  ✓ $package"
        done
        echo ""
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
            if [ -d ".juno_venv" ]; then
                log_info "Packages installed in virtual environment: .juno_venv"
                log_info "To use them, activate the venv: source .juno_venv/bin/activate"
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
            if [ -d ".juno_venv" ]; then
                log_info "Packages installed in virtual environment: .juno_venv"
                log_info "To use them, activate the venv: source .juno_venv/bin/activate"
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
