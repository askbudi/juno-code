#!/bin/bash

###############################################################################
# NPM Package Publishing Script for juno-code
#
# This script automates the process of publishing the juno-code NPM package.
#
# Features:
# - Automated version bumping (patch/minor/major)
# - Builds the project once
# - Generates juno-code package variant
# - Publishes to NPM
# - Includes template scripts in package
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
PACKAGES_DIR="$ROOT_DIR/dist/packages"

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
  print_step "Bumping version ($VERSION_TYPE)..."

  cd "$ROOT_DIR"

  # Get current version
  local current_version=$(node -p "require('./package.json').version")
  print_success "Current version: $current_version"

  if [[ "$DRY_RUN" == false ]]; then
    # Bump version using npm version
    npm version "$VERSION_TYPE" --no-git-tag-version

    local new_version=$(node -p "require('./package.json').version")
    print_success "New version: $new_version"

    # Return new version
    echo "$new_version"
  else
    print_warning "DRY RUN: Would bump version from $current_version"
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

generate_variants() {
  print_step "Generating package variants..."

  cd "$ROOT_DIR"

  # Run the variant generation script
  node scripts/generate-variants.js

  print_success "Package variants generated"
}

###############################################################################
# Publishing Functions
###############################################################################

publish_package() {
  local package_name=$1
  local package_dir="$PACKAGES_DIR/$package_name"

  print_step "Publishing $package_name..."

  cd "$package_dir"

  if [[ "$DRY_RUN" == true ]]; then
    print_warning "DRY RUN: Would publish $package_name"
    npm pack --dry-run
  else
    # Publish to NPM
    npm publish --access public
    print_success "Published $package_name"
  fi
}

publish_all_variants() {
  print_step "Publishing all package variants..."

  local variants=("juno-agent" "juno-code" "juno-ts-task")

  for variant in "${variants[@]}"; do
    publish_package "$variant"
  done

  print_success "All packages published"
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

  # Keep the packages directory for inspection in dry-run mode
  if [[ "$DRY_RUN" == false ]]; then
    if [[ -d "$PACKAGES_DIR" ]]; then
      rm -rf "$PACKAGES_DIR"
      print_success "Cleaned up package variants"
    fi
  else
    print_warning "DRY RUN: Keeping packages in $PACKAGES_DIR for inspection"
  fi
}

###############################################################################
# Main Execution
###############################################################################

main() {
  print_header "🚀 NPM Multi-Package Publishing"

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

  # Build and generate
  build_project
  generate_variants

  # Publish
  if [[ "$DRY_RUN" == false ]]; then
    echo -e "\n${YELLOW}⚠ About to publish the following packages to NPM:${NC}"
    echo "  • juno-agent@$new_version"
    echo "  • juno-code@$new_version"
    echo "  • juno-ts-task@$new_version"
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
    echo "  • juno-agent@$new_version"
    echo "  • juno-code@$new_version"
    echo "  • juno-ts-task@$new_version"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Verify packages on npmjs.com"
    echo "  2. Test installation: npm install -g juno-agent@$new_version"
    echo "  3. Update documentation if needed"
  else
    echo -e "\n${YELLOW}DRY RUN Summary:${NC}"
    echo "  • Would bump version: $VERSION_TYPE"
    echo "  • Would publish 3 packages"
    echo "  • Package variants available in: $PACKAGES_DIR"
    echo ""
    echo "Run without --dry-run to actually publish"
  fi

  echo ""
}

# Run main function
main
