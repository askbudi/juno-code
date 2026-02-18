#!/bin/bash

###############################################################################
# NPM Package Publishing Script for juno-code
#
# This script automates the process of publishing the juno-code NPM package.
#
# Features:
# - Automated version bumping (patch/minor/major)
# - Builds the project once
# - Publishes directly to NPM (no package variants)
# - Includes template scripts in package
# - Clean git tagging without ANSI color codes
#
# Usage:
#   ./scripts/publish-all.sh [patch|minor|major] [--dry-run]
#
# Examples:
#   ./scripts/publish-all.sh patch          # Bump patch version and publish
#   ./scripts/publish-all.sh minor          # Bump minor version and publish
#   ./scripts/publish-all.sh major          # Bump major version and publish
#   ./scripts/publish-all.sh patch --dry-run # Test without actually publishing
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

# Default values
VERSION_TYPE="${1:-patch}"
DRY_RUN=false

# Parse arguments
if [[ "$2" == "--dry-run" ]] || [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
fi

###############################################################################
# Helper Functions
###############################################################################

print_header() {
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
}

print_step() {
  echo -e "\n${GREEN}▶ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

###############################################################################
# Validation Functions
###############################################################################

validate_version_type() {
  if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    print_error "Invalid version type: $VERSION_TYPE"
    echo "Usage: $0 [patch|minor|major] [--dry-run]"
    exit 1
  fi
}

validate_npm_auth() {
  print_step "Validating NPM authentication..."

  if ! npm whoami > /dev/null 2>&1; then
    print_error "Not logged in to NPM"
    echo "Please run: npm login"
    exit 1
  fi

  local npm_user=$(npm whoami)
  print_success "Authenticated as: $npm_user"
}

validate_git_state() {
  print_step "Validating git state..."

  # Check for uncommitted changes
  if [[ -n $(git status -s) ]]; then
    print_warning "Uncommitted changes detected"
    echo "Please commit or stash your changes before publishing"

    if [[ "$DRY_RUN" == false ]]; then
      read -p "Continue anyway? (y/N) " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
      fi
    fi
  else
    print_success "Working directory clean"
  fi
}

###############################################################################
# Build and Version Functions
###############################################################################

bump_version() {
  # Redirect all colored output to stderr to keep stdout clean for version capture
  print_step "Bumping version ($VERSION_TYPE)..." >&2

  cd "$ROOT_DIR"

  # Get current version
  local current_version=$(node -p "require('./package.json').version")
  print_success "Current version: $current_version" >&2

  if [[ "$DRY_RUN" == false ]]; then
    # Bump version using npm version (suppress output to avoid ANSI codes)
    npm version "$VERSION_TYPE" --no-git-tag-version > /dev/null 2>&1

    local new_version=$(node -p "require('./package.json').version")
    print_success "New version: $new_version" >&2

    # Return new version (clean, no ANSI codes) to stdout
    echo "$new_version"
  else
    print_warning "DRY RUN: Would bump version from $current_version" >&2
    echo "$current_version"
  fi
}

build_project() {
  print_step "Building project..."

  cd "$ROOT_DIR"

  # Clean previous build
  npm run clean

  # Build the project
  npm run build

  print_success "Build complete"
}


###############################################################################
# Publishing Functions
###############################################################################

publish_package() {
  print_step "Publishing juno-code..."

  cd "$ROOT_DIR"

  if [[ "$DRY_RUN" == true ]]; then
    print_warning "DRY RUN: Would publish juno-code"
    npm pack --dry-run
  else
    # Publish to NPM
    npm publish --access public
    print_success "Published juno-code"
  fi
}

publish_all_variants() {
  print_step "Publishing juno-code package..."

  # Publish directly from main directory
  publish_package

  print_success "juno-code package published"
}

###############################################################################
# Git Operations
###############################################################################

commit_and_tag() {
  local version=$1

  print_step "Committing version bump and creating git tag..."

  cd "$ROOT_DIR"

  if [[ "$DRY_RUN" == false ]]; then
    # Commit the version bump
    git add package.json package-lock.json
    git commit -m "chore: bump version to $version

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>"

    # Create git tag
    git tag -a "v$version" -m "Release v$version"

    print_success "Committed and tagged v$version"

    # Ask to push
    read -p "Push to remote repository? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      git push && git push --tags
      print_success "Pushed to remote"
    fi
  else
    print_warning "DRY RUN: Would commit and tag v$version"
  fi
}

###############################################################################
# Cleanup Functions
###############################################################################

cleanup() {
  print_step "Cleaning up temporary files..."

  cd "$ROOT_DIR"

  # No cleanup needed since we publish directly from main directory
  print_success "No temporary files to clean up"
}

###############################################################################
# Main Execution
###############################################################################

main() {
  print_header "🚀 NPM Package Publishing - juno-code"

  if [[ "$DRY_RUN" == true ]]; then
    print_warning "Running in DRY RUN mode - no actual publishing will occur"
  fi

  echo -e "\nVersion bump type: ${GREEN}$VERSION_TYPE${NC}"
  echo -e "Root directory: $ROOT_DIR\n"

  # Pre-flight checks
  validate_version_type

  if [[ "$DRY_RUN" == false ]]; then
    validate_npm_auth
  fi

  validate_git_state

  # Version bump
  new_version=$(bump_version)

  # Build project
  build_project

  # Publish
  if [[ "$DRY_RUN" == false ]]; then
    echo -e "\n${YELLOW}⚠ About to publish the following package to NPM:${NC}"
    echo "  • juno-code@$new_version"
    echo ""
    read -p "Continue with publishing? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      print_warning "Publishing cancelled"
      exit 0
    fi
  fi

  publish_all_variants

  # Git operations
  if [[ "$DRY_RUN" == false ]]; then
    commit_and_tag "$new_version"
  fi

  # Cleanup
  cleanup

  # Summary
  print_header "✅ Publishing Complete!"

  if [[ "$DRY_RUN" == false ]]; then
    echo -e "\n${GREEN}Successfully published:${NC}"
    echo "  • juno-code@$new_version"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Verify package on npmjs.com"
    echo "  2. Test installation: npm install -g juno-code@$new_version"
    echo "  3. Update documentation if needed"
  else
    echo -e "\n${YELLOW}DRY RUN Summary:${NC}"
    echo "  • Would bump version: $VERSION_TYPE"
    echo "  • Would publish juno-code package directly from main directory"
    echo "  • Package available in: $ROOT_DIR"
    echo ""
    echo "Run without --dry-run to actually publish"
  fi

  echo ""
}

# Run main function
main
