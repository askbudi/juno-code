# NPM Deployment Guide

## Overview

This project is published to NPM as **`juno-code`**, providing the `juno-code` command for AI-powered code automation and Claude Code integration.

**Package**: `juno-code`
**Binary Command**: `juno-code`

## Package Strategy

We use a **direct deployment strategy**:
1. Single codebase in this repository
2. Build artifacts generated once
3. Published directly to NPM as `juno-code`

This simplified approach eliminates binary command conflicts and provides a clean installation experience.

## Installation

Users install via:

```bash
npm install -g juno-code
```

## Binary Command

After installation, the package provides:

```bash
juno-code --help          # Main command for code automation
```

**Note**: Only the `juno-code` command is installed to avoid conflicts with other packages.

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

4. **Publishing**
   - Publishes directly from main directory to NPM
   - Published with `--access public`

5. **Git Operations**
   - Commits version bump changes
   - Creates git tag (`v1.0.1`, etc.) with clean version strings (no ANSI color codes)
   - Optionally pushes to remote repository

6. **Cleanup**
   - No cleanup needed (publishes directly from main directory)

## Manual Deployment (Step by Step)

If you need more control, you can run each step manually:

```bash
# 1. Build the project
npm run build

# 2. Test package locally (optional)
npm pack --dry-run

# 3. Publish package
npm publish --access public

# 4. Create git tag
git tag -a v1.0.1 -m "Release v1.0.1"
git push && git push --tags
```

## Package Configuration

The package is defined directly in the main `package.json`:

```json
{
  "name": "juno-code",
  "description": "TypeScript CLI tool for AI subagent orchestration with code automation",
  "bin": {
    "juno-code": "./dist/bin/juno-code.sh",
    "juno-collect-feedback": "./dist/bin/feedback-collector.mjs"
  }
}
```

Key features:
- **Direct deployment**: No package variants needed
- **Single binary focus**: Primary `juno-code` command with feedback collector
- **No conflicts**: Simple, focused installation

## Template Scripts Inclusion

The deployment process ensures that template scripts are included in the published package:

- `dist/templates/scripts/clean_logs_folder.sh`
- `dist/templates/scripts/install_requirements.sh`

These scripts are automatically:
1. Built from `src/templates/scripts/` during `npm run build`
2. Copied to `dist/templates/scripts/`
3. Included in the published NPM package

## Version Management

### Versioning

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
   npm view juno-code
   ```

2. **Test Installation**
   ```bash
   npm install -g juno-code@latest
   juno-code --version
   juno-code --help
   ```

3. **Verify Template Scripts**
   ```bash
   # Initialize a test project
   mkdir test-juno && cd test-juno
   juno-code init --task "test" --subagent "claude" --git-url "https://example.com"

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
npm view juno-code version

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
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

## Package Naming Rationale

- **juno-code**: Focused package name emphasizing AI-powered code automation and Claude Code integration
- **Single binary**: Avoids conflicts with other packages by only installing the `juno-code` command

## Migration from Previous Versions

If you had installed version 1.0.1 with multiple binary aliases:

```bash
# Uninstall old version
npm uninstall -g juno-code

# Install new version (1.0.2+)
npm install -g juno-code

# Only juno-code command will be available
juno-code --help
```
