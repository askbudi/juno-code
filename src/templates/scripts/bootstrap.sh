#!/usr/bin/env bash

# bootstrap.sh
#
# Purpose: Pre-flight Python environment setup for juno-code
#
# This script runs before the main juno-code entrypoint and ensures:
# 1. Python virtual environment (.venv_juno) exists
# 2. Required Python packages are installed
# 3. Virtual environment is activated if needed
# 4. Main application can run with proper Python dependencies
#
# Usage: ./bootstrap.sh [main-entrypoint-command] [args...]
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

# Configuration
VENV_DIR=".venv_juno"
SCRIPTS_DIR=".juno_task/scripts"
INSTALL_SCRIPT="${SCRIPTS_DIR}/install_requirements.sh"

# Logging functions
log_info() {
    echo -e "${BLUE}[BOOTSTRAP]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[BOOTSTRAP]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[BOOTSTRAP]${NC} $1"
}

log_error() {
    echo -e "${RED}[BOOTSTRAP]${NC} $1"
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

# Function to activate virtual environment
activate_venv() {
    local venv_path="$1"

    if [ ! -d "$venv_path" ]; then
        log_error "Virtual environment not found: $venv_path"
        return 1
    fi

    # Activate the venv
    # shellcheck disable=SC1091
    if [ -f "$venv_path/bin/activate" ]; then
        source "$venv_path/bin/activate"
        log_success "Activated virtual environment: $venv_path"
        return 0
    else
        log_error "Activation script not found: $venv_path/bin/activate"
        return 1
    fi
}

# Function to ensure Python environment is ready
ensure_python_environment() {
    log_info "Checking Python environment..."

    # Step 1: Check if we're already in a virtual environment
    if is_in_virtualenv; then
        log_success "Already inside a virtual environment"
        return 0
    fi

    # Step 2: Check if .venv_juno exists in project root
    if [ -d "$VENV_DIR" ]; then
        log_info "Found existing virtual environment: $VENV_DIR"

        # Activate the venv
        if activate_venv "$VENV_DIR"; then
            return 0
        else
            log_error "Failed to activate virtual environment"
            return 1
        fi
    fi

    # Step 3: .venv_juno doesn't exist - need to create it
    log_warning "Virtual environment not found: $VENV_DIR"
    log_info "Running install_requirements.sh to create virtual environment..."

    # Check if install_requirements.sh exists
    if [ ! -f "$INSTALL_SCRIPT" ]; then
        log_error "Install script not found: $INSTALL_SCRIPT"
        log_error "Please run 'juno-code init' to initialize the project"
        return 1
    fi

    # Make sure the script is executable
    chmod +x "$INSTALL_SCRIPT"

    # Run the install script
    if bash "$INSTALL_SCRIPT"; then
        log_success "Python environment setup completed successfully"

        # After install, activate the venv if it was created
        if [ -d "$VENV_DIR" ]; then
            if activate_venv "$VENV_DIR"; then
                return 0
            fi
        fi

        return 0
    else
        log_error "Failed to run install_requirements.sh"
        log_error "Please check the error messages above"
        return 1
    fi
}

# Main bootstrap logic
main() {
    log_info "=== juno-code Bootstrap ==="
    echo ""

    # Ensure Python environment is ready
    if ! ensure_python_environment; then
        log_error "Failed to setup Python environment"
        exit 1
    fi

    echo ""
    log_success "Python environment ready!"

    # If there are additional arguments, execute them as the main entrypoint
    if [ $# -gt 0 ]; then
        log_info "Executing main entrypoint: $*"
        echo ""

        # Execute the main entrypoint with all arguments
        exec "$@"
    else
        log_info "No main entrypoint specified - environment is ready for use"
        log_info "To activate the virtual environment manually, run:"
        echo ""
        echo "    source $VENV_DIR/bin/activate"
        echo ""
    fi
}

# Run main function with all arguments
main "$@"
