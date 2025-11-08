/**
 * @fileoverview Template engine demonstration
 *
 * This demo shows the comprehensive template engine functionality
 * implemented for juno-code based on the Python budi-cli.
 */

import { TemplateEngine, TemplateUtils } from './engine.js';
import * as path from 'path';

async function demonstrateTemplateEngine() {
  console.log('🚀 Juno-Task Template Engine Demo\n');

  // Initialize the template engine
  const engine = new TemplateEngine();
  console.log(`📋 Engine: ${engine.name} v${engine.version}`);
  console.log(`📁 Supported extensions: ${engine.supportedExtensions.join(', ')}\n`);

  // Show built-in templates
  const builtInTemplates = engine.getBuiltInTemplates();
  console.log(`📚 Built-in templates (${builtInTemplates.length}):`);
  builtInTemplates.forEach(template => {
    console.log(`  - ${template.id}: ${template.name} (${template.category})`);
  });
  console.log();

  // Create default variables for a sample project
  const projectPath = '/Users/developer/my-awesome-project';
  const variables = TemplateUtils.createDefaultVariables(projectPath, 'my-awesome-project');

  // Customize some variables for the demo
  variables.main_task = 'Build an AI-powered task automation system';
  variables.TASK = 'Build an AI-powered task automation system';
  variables.SUBAGENT = 'claude';
  variables.GIT_URL = 'https://github.com/developer/my-awesome-project';
  variables.AUTHOR = 'John Developer';
  variables.EMAIL = 'john@developer.com';
  variables.DESCRIPTION = 'An innovative AI task automation system';

  console.log('🔧 Project Variables:');
  console.log(`  PROJECT_NAME: ${variables.PROJECT_NAME}`);
  console.log(`  TASK: ${variables.TASK}`);
  console.log(`  SUBAGENT: ${variables.SUBAGENT}`);
  console.log(`  AUTHOR: ${variables.AUTHOR}`);
  console.log(`  GIT_URL: ${variables.GIT_URL}\n`);

  // Create template context
  const context = await engine.createContext(variables, projectPath, {
    includeGitInfo: false,
    includeEnvironment: true
  });

  // Demonstrate rendering the init.md template
  const initTemplate = engine.getBuiltInTemplate('init.md');
  if (initTemplate) {
    console.log('📝 Rendering init.md template...\n');

    try {
      const renderedContent = await engine.render(initTemplate, context);
      console.log('━'.repeat(80));
      console.log('RENDERED INIT.MD:');
      console.log('━'.repeat(80));
      console.log(renderedContent);
      console.log('━'.repeat(80));
      console.log();
    } catch (error) {
      console.error('❌ Error rendering template:', error);
    }
  }

  // Demonstrate template validation
  console.log('✅ Template Validation:');
  const builtInValid = builtInTemplates.every(template => {
    const validation = engine.validate(template);
    if (!validation.valid) {
      console.log(`  ❌ ${template.id}: ${validation.error}`);
      return false;
    }
    return true;
  });

  if (builtInValid) {
    console.log(`  ✅ All ${builtInTemplates.length} built-in templates are valid!`);
  }
  console.log();

  // Demonstrate variable validation
  console.log('🔍 Variable Validation Demo:');

  // Test email validation
  const emailResults = await engine.validateVariables(
    { email: 'john@developer.com' },
    [{ name: 'email', description: 'Email', type: 'email', required: true }]
  );
  console.log(`  Email 'john@developer.com': ${emailResults[0].valid ? '✅ Valid' : '❌ Invalid'}`);

  // Test subagent validation
  const subagentResults = await engine.validateVariables(
    { subagent: 'claude' },
    [{ name: 'subagent', description: 'Subagent', type: 'subagent', required: true }]
  );
  console.log(`  Subagent 'claude': ${subagentResults[0].valid ? '✅ Valid' : '❌ Invalid'}`);

  // Test invalid values
  const invalidEmailResults = await engine.validateVariables(
    { email: 'invalid-email' },
    [{ name: 'email', description: 'Email', type: 'email', required: true }]
  );
  console.log(`  Email 'invalid-email': ${invalidEmailResults[0].valid ? '✅ Valid' : '❌ Invalid'}`);
  console.log();

  // Show variable extraction from content
  const sampleContent = 'Hello {{USER_NAME}}, your task is {{TASK}} using {{SUBAGENT}}.';
  const extractedVars = TemplateUtils.extractVariablesFromContent(sampleContent);
  console.log('🔎 Variable Extraction Demo:');
  console.log(`  Content: "${sampleContent}"`);
  console.log(`  Extracted variables: ${extractedVars.join(', ')}\n`);

  // Show utility functions
  console.log('🛠️ Utility Functions:');
  console.log(`  Valid template ID 'init.md': ${TemplateUtils.isValidTemplateId('init.md') ? '✅' : '❌'}`);
  console.log(`  Valid template ID 'invalid id': ${TemplateUtils.isValidTemplateId('invalid id') ? '✅' : '❌'}`);

  const uniqueId = TemplateUtils.generateTemplateId('custom-template');
  console.log(`  Generated unique ID: ${uniqueId}`);
  console.log();

  console.log('🎉 Template Engine Demo Complete!');
  console.log('\nKey Features Demonstrated:');
  console.log('  ✅ Built-in templates from Python budi-cli implementation');
  console.log('  ✅ Handlebars template compilation and rendering');
  console.log('  ✅ Variable validation with type checking');
  console.log('  ✅ Template context creation with environment info');
  console.log('  ✅ Template validation and error handling');
  console.log('  ✅ Utility functions for template management');
  console.log('  ✅ Full TypeScript support with strict types');
}

// Run the demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateTemplateEngine().catch(console.error);
}

export { demonstrateTemplateEngine };