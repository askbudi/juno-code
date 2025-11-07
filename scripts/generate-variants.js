#!/usr/bin/env node

/**
 * Generate Package Variants Script
 *
 * This script generates multiple NPM package variants from a base package.json.
 * It creates separate package directories for juno-agent, juno-code, and juno-ts-task,
 * each with its own package.json configuration.
 *
 * Usage: node scripts/generate-variants.js
 */

const fs = require('fs-extra');
const path = require('path');

// Configuration
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const VARIANTS_DIR = path.join(ROOT_DIR, 'package-variants');
const PACKAGES_OUTPUT_DIR = path.join(DIST_DIR, 'packages');

// Variant names
const VARIANTS = ['juno-agent', 'juno-code', 'juno-ts-task'];

/**
 * Load base package.json
 */
function loadBasePackage() {
  const packagePath = path.join(ROOT_DIR, 'package.json');
  console.log(`📦 Loading base package.json from: ${packagePath}`);
  return fs.readJsonSync(packagePath);
}

/**
 * Load variant configuration
 */
function loadVariantConfig(variantName) {
  const variantPath = path.join(VARIANTS_DIR, `${variantName}.json`);
  console.log(`🔧 Loading variant config: ${variantName}`);

  if (!fs.existsSync(variantPath)) {
    throw new Error(`Variant configuration not found: ${variantPath}`);
  }

  return fs.readJsonSync(variantPath);
}

/**
 * Merge base package with variant configuration
 */
function mergePackageConfig(basePackage, variantConfig) {
  // Deep clone base package to avoid mutations
  const merged = JSON.parse(JSON.stringify(basePackage));

  // Override with variant-specific values
  Object.keys(variantConfig).forEach(key => {
    if (typeof variantConfig[key] === 'object' && !Array.isArray(variantConfig[key])) {
      // Deep merge objects (like bin, repository, etc.)
      merged[key] = { ...merged[key], ...variantConfig[key] };
    } else {
      // Direct override for primitives and arrays
      merged[key] = variantConfig[key];
    }
  });

  // Remove build-related scripts since packages are pre-built
  const scriptsToRemove = [
    'dev', 'build', 'build:copy-templates', 'build:watch',
    'test', 'test:tui', 'test:tui:preserve', 'test:feedback',
    'test:binary', 'test:unit', 'test:integration', 'test:e2e',
    'test:coverage', 'test:watch', 'lint', 'lint:fix',
    'format', 'format:check', 'typecheck', 'clean',
    'prepack', 'cli', 'completion:install', 'docs:api',
    'release', 'deploy', 'deploy:minor', 'deploy:major',
    'deploy:dry-run', 'variants:generate', 'help:test:tui', 'help:test:binary'
  ];

  if (merged.scripts) {
    scriptsToRemove.forEach(script => {
      delete merged.scripts[script];
    });

    // If scripts object is empty, remove it
    if (Object.keys(merged.scripts).length === 0) {
      delete merged.scripts;
    }
  }

  // Remove devDependencies since packages are pre-built
  delete merged.devDependencies;

  return merged;
}

/**
 * Copy dist build artifacts to variant package directory
 */
function copyBuildArtifacts(variantPackageDir) {
  const distSrc = DIST_DIR;
  const distDest = path.join(variantPackageDir, 'dist');

  // Copy everything from dist except the packages directory itself
  const itemsToCopy = fs.readdirSync(distSrc).filter(item => item !== 'packages');

  itemsToCopy.forEach(item => {
    const srcPath = path.join(distSrc, item);
    const destPath = path.join(distDest, item);
    fs.copySync(srcPath, destPath);
  });

  console.log(`   ✓ Copied build artifacts to ${variantPackageDir}`);
}

/**
 * Copy additional files (README, CHANGELOG, etc.)
 */
function copyAdditionalFiles(variantPackageDir) {
  const filesToCopy = ['README.md', 'CHANGELOG.md', 'LICENSE'];

  filesToCopy.forEach(file => {
    const srcPath = path.join(ROOT_DIR, file);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(variantPackageDir, file);
      fs.copySync(srcPath, destPath);
      console.log(`   ✓ Copied ${file}`);
    }
  });
}

/**
 * Generate a single package variant
 */
function generateVariant(basePackage, variantName) {
  console.log(`\n🚀 Generating variant: ${variantName}`);

  // Load variant config
  const variantConfig = loadVariantConfig(variantName);

  // Merge configurations
  const packageJson = mergePackageConfig(basePackage, variantConfig);

  // Create variant package directory
  const variantPackageDir = path.join(PACKAGES_OUTPUT_DIR, variantName);
  fs.ensureDirSync(variantPackageDir);

  // Write package.json
  const packageJsonPath = path.join(variantPackageDir, 'package.json');
  fs.writeJsonSync(packageJsonPath, packageJson, { spaces: 2 });
  console.log(`   ✓ Created package.json at ${packageJsonPath}`);

  // Copy build artifacts
  copyBuildArtifacts(variantPackageDir);

  // Copy additional files
  copyAdditionalFiles(variantPackageDir);

  console.log(`✅ Successfully generated ${variantName} package`);

  return variantPackageDir;
}

/**
 * Main execution
 */
function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🏗️  NPM Package Variants Generator');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    // Ensure dist directory exists
    if (!fs.existsSync(DIST_DIR)) {
      throw new Error('Build artifacts not found. Please run "npm run build" first.');
    }

    // Clean previous packages output
    if (fs.existsSync(PACKAGES_OUTPUT_DIR)) {
      console.log('🧹 Cleaning previous package variants...');
      fs.removeSync(PACKAGES_OUTPUT_DIR);
    }

    // Create packages output directory
    fs.ensureDirSync(PACKAGES_OUTPUT_DIR);

    // Load base package
    const basePackage = loadBasePackage();
    console.log(`   Version: ${basePackage.version}\n`);

    // Generate all variants
    const generatedPackages = [];
    VARIANTS.forEach(variantName => {
      const packageDir = generateVariant(basePackage, variantName);
      generatedPackages.push({ name: variantName, dir: packageDir });
    });

    // Summary
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('✅ Package Generation Complete!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\nGenerated Packages:');
    generatedPackages.forEach(pkg => {
      console.log(`  • ${pkg.name} → ${pkg.dir}`);
    });
    console.log('\n📋 Next Steps:');
    console.log('  1. Review generated packages in dist/packages/');
    console.log('  2. Run publish script to deploy to NPM');
    console.log('\n');

  } catch (error) {
    console.error('\n❌ Error generating package variants:');
    console.error(error.message);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { generateVariant, mergePackageConfig };
