#!/usr/bin/env bash

# install_requirements.sh
#
# Purpose: Install Python dependencies required for juno-task-ts
#
# This script:
# 1. Checks if 'uv' (ultrafast Python package manager) is installed
# 2. Falls back to 'pip' if 'uv' is not available
# 3. Detects virtual environment and installs accordingly:
#    - If inside venv: installs into venv
#    - If outside venv: uses --system flag for system-wide installation
# 4. Installs required packages: juno-kanban, roundtable-ai
# 5. Reports if requirements are already satisfied
# 6. Shows error if neither 'uv' nor 'pip' is available
#
# Usage: ./install_requirements.sh
#
# Created by: juno-task-ts init command
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

# Function to install packages using uv
install_with_uv() {
    log_info "Installing packages using 'uv' (ultrafast Python package manager)..."

    # Determine if we need --system flag
    local uv_flags="--quiet"
    if ! is_in_virtualenv; then
        log_info "Not in a virtual environment - using --system flag for system-wide installation"
        uv_flags="--quiet --system"
    else
        log_info "Detected virtual environment - installing into venv"
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

# Function to install packages using pip
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

    if command -v uv &> /dev/null; then
        log_success "'uv' found - using ultrafast Python package manager"
        installer="uv"
    elif command -v pip3 &> /dev/null || command -v pip &> /dev/null; then
        log_success "'pip' found - using standard Python package installer"
        installer="pip"
    else
        # Neither uv nor pip found
        log_error "Neither 'uv' nor 'pip' package manager found!"
        echo ""
        log_info "Please install one of the following:"
        echo ""
        echo "  Option 1: Install 'uv' (recommended - ultrafast)"
        echo "    curl -LsSf https://astral.sh/uv/install.sh | sh"
        echo "    OR"
        echo "    brew install uv  (macOS)"
        echo ""
        echo "  Option 2: Install 'pip' (standard Python package manager)"
        echo "    python3 -m ensurepip --upgrade"
        echo "    OR"
        echo "    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py && python3 get-pip.py"
        echo ""
        exit 1
    fi

    # Step 3: Install packages
    echo ""
    log_info "Installing required packages: ${REQUIRED_PACKAGES[*]}"
    echo ""

    if [ "$installer" = "uv" ]; then
        if install_with_uv; then
            echo ""
            log_success "All packages installed successfully using 'uv'!"
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
