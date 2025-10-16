import { readFileSync } from 'fs';

// Read the compiled client.ts file and check for process.env usage in mergedEnv
const clientCode = readFileSync('dist/bin/cli.mjs', 'utf-8');

// Extract all mergedEnv sections
const mergedEnvRegex = /const mergedEnv = \{[\s\S]*?\};/g;
const mergedEnvSections = clientCode.match(mergedEnvRegex) || [];

console.log(`Found ${mergedEnvSections.length} mergedEnv definitions\n`);

let hasSecurityIssue = false;
mergedEnvSections.forEach((section, idx) => {
  console.log(`=== mergedEnv #${idx + 1} ===`);
  console.log(section);
  
  if (section.includes('...process.env')) {
    console.log('❌ SECURITY ISSUE: Contains process.env spreading!\n');
    hasSecurityIssue = true;
  } else {
    console.log('✅ SECURE: No process.env spreading\n');
  }
});

if (hasSecurityIssue) {
  console.log('❌ FAILED: Security vulnerability detected in environment variable handling');
  process.exit(1);
} else {
  console.log('✅ PASSED: All mergedEnv definitions are secure (no parent env inheritance)');
  process.exit(0);
}
