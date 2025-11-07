# NPM Deployment Guide

## Overview

This project is published to NPM under **three different package names**, all providing the same CLI functionality:

- **`juno-agent`** (Primary - recommended for new installations)
- **`juno-code`** (Code-focused alias)
- **`juno-ts-task`** (Legacy package name for backward compatibility)

All packages install the same binary commands: `juno`, `juno-agent`, `juno-code`, `juno-ts-task`, and `juno-collect-feedback`.

## Package Aliasing Strategy

We use a **separate packages strategy** where:
1. Single codebase in this repository
2. Build artifacts generated once
3. Multiple package variants created from the build
4. All variants published to NPM simultaneously with identical versions

## Installation

Users can install any of the three package names:

```bash
# Recommended (primary package)
npm install -g juno-agent

# Alternative installations
npm install -g juno-code
npm install -g juno-ts-task
```

All three installations provide the same functionality and binary commands.

## Binary Commands

After installation, all packages provide these commands:

```bash
juno --help               # Universal command
juno-agent --help         # Package-specific command
juno-code --help          # Package-specific command
juno-ts-task --help       # Legacy command
juno-collect-feedback     # Feedback collection utility
```

## Deployment Process

### Prerequisites

1. **NPM Authentication**: Login to NPM registry
   ```bash
   npm login
   ```

2. **Clean Git State**: Ensure no uncommitted changes
   ```bash
   git status
   ```

### Automated Deployment Scripts

We provide NPM scripts for automated deployment with version management:

#### Patch Release (Bug fixes)
```bash
npm run deploy
# or
npm run deploy:patch
```
Bumps version from `1.0.0` → `1.0.1`

#### Minor Release (New features, backward compatible)
```bash
npm run deploy:minor
```
Bumps version from `1.0.0` → `1.1.0`

#### Major Release (Breaking changes)
```bash
npm run deploy:major
```
Bumps version from `1.0.0` → `2.0.0`

#### Dry Run (Test without publishing)
```bash
npm run deploy:dry-run
```
Simulates the full deployment process without actually publishing to NPM.

### What the Deployment Script Does

The `scripts/publish-all.sh` script automates the entire deployment workflow:

1. **Validates Environment**
   - Checks NPM authentication
   - Validates git state (warns about uncommitted changes)
   - Validates version bump type

2. **Version Management**
   - Bumps package version in `package.json`
   - Updates `package-lock.json`

3. **Build Process**
   - Cleans previous builds (`npm run clean`)
   - Builds the project (`npm run build`)
   - Copies template scripts to dist directory

4. **Package Variant Generation**
   - Runs `node scripts/generate-variants.js`
   - Creates three package variants in `dist/packages/`:
     - `juno-agent`
     - `juno-code`
     - `juno-ts-task`
   - Each variant includes:
     - All build artifacts
     - Template scripts (clean_logs_folder.sh, install_requirements.sh)
     - README.md
     - Variant-specific package.json

5. **Publishing**
   - Publishes all three packages to NPM
   - All packages get the same version number
   - Published with `--access public`

6. **Git Operations**
   - Commits version bump changes
   - Creates git tag (`v1.0.1`, etc.)
   - Optionally pushes to remote repository

7. **Cleanup**
   - Removes temporary package variant directories

## Manual Deployment (Step by Step)

If you need more control, you can run each step manually:

```bash
# 1. Build the project
npm run build

# 2. Generate package variants
npm run variants:generate

# 3. Verify generated packages
ls -la dist/packages/
cat dist/packages/juno-agent/package.json

# 4. Test package locally (optional)
cd dist/packages/juno-agent
npm pack --dry-run

# 5. Publish each package
cd dist/packages/juno-agent && npm publish --access public
cd dist/packages/juno-code && npm publish --access public
cd dist/packages/juno-ts-task && npm publish --access public

# 6. Create git tag
git tag -a v1.0.1 -m "Release v1.0.1"
git push && git push --tags
```

## Package Variant Configuration

Package variants are defined in `package-variants/`:

- **`juno-agent.json`**: Primary package configuration
- **`juno-code.json`**: Code-focused package configuration
- **`juno-ts-task.json`**: Legacy package configuration

Each variant file contains package-specific overrides:
- Package name
- Description
- Keywords
- Binary command mappings
- Repository URLs

The `scripts/generate-variants.js` merges these overrides with the base `package.json`.

## Template Scripts Inclusion

The deployment process ensures that template scripts are included in all published packages:

- `dist/templates/scripts/clean_logs_folder.sh`
- `dist/templates/scripts/install_requirements.sh`

These scripts are automatically:
1. Built from `src/templates/scripts/` during `npm run build`
2. Copied to each package variant in `dist/packages/*/dist/templates/scripts/`
3. Included in the published NPM packages

## Version Management

### Synchronized Versioning

All three packages maintain **identical version numbers**. When you publish, all packages get the same version.

### Semantic Versioning

We follow [Semantic Versioning](https://semver.org/):

- **Patch** (1.0.0 → 1.0.1): Bug fixes, no new features
- **Minor** (1.0.0 → 1.1.0): New features, backward compatible
- **Major** (1.0.0 → 2.0.0): Breaking changes

### Version Bump Methods

1. **Automated (Recommended)**: Use deployment scripts
   ```bash
   npm run deploy:patch
   npm run deploy:minor
   npm run deploy:major
   ```

2. **Manual**: Use `npm version`
   ```bash
   npm version patch  # 1.0.0 → 1.0.1
   npm version minor  # 1.0.0 → 1.1.0
   npm version major  # 1.0.0 → 2.0.0
   ```

## Post-Deployment Verification

After publishing, verify the packages:

1. **Check NPM Registry**
   ```bash
   npm view juno-agent
   npm view juno-code
   npm view juno-ts-task
   ```

2. **Test Installation**
   ```bash
   npm install -g juno-agent@latest
   juno --version
   juno-agent --help
   ```

3. **Verify Template Scripts**
   ```bash
   # Initialize a test project
   mkdir test-juno && cd test-juno
   juno-agent init --task "test" --subagent "claude" --git-url "https://example.com"

   # Check scripts were installed
   ls -la .juno_task/scripts/
   ```

## Troubleshooting

### Build Failures

```bash
# Clean and rebuild
npm run clean
npm run build
```

### Publish Permission Errors

```bash
# Re-authenticate with NPM
npm logout
npm login
```

### Version Conflicts

```bash
# Check current version
npm view juno-agent version

# Ensure local version is higher
cat package.json | grep version
```

### Uncommitted Changes Warning

The deployment script warns about uncommitted changes. Either:
1. Commit your changes: `git add . && git commit -m "message"`
2. Stash your changes: `git stash`
3. Continue anyway (not recommended)

## CI/CD Integration (Future Enhancement)

For automated deployments, consider setting up GitHub Actions:

```yaml
name: Publish to NPM
on:
  push:
    tags:
      - 'v*'
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm run variants:generate
      - run: npm publish dist/packages/juno-agent --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
      - run: npm publish dist/packages/juno-code --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
      - run: npm publish dist/packages/juno-ts-task --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

## Package Naming Rationale

- **juno-agent**: Primary package name focusing on AI agent orchestration
- **juno-code**: Alternative name emphasizing coding assistance
- **juno-ts-task**: Legacy name for backward compatibility with existing installations

All three names point to the same functionality to provide flexibility for different user preferences and use cases.
