# Template Engine Module

## Overview

This module provides a comprehensive template processing engine for juno-code, based on the Python budi-cli implementation. It supports Handlebars template compilation with variable substitution patterns compatible with the original Python implementation.

## Features

### ✅ Core Template Engine
- **TemplateEngine class** - Complete template processing with variable substitution
- **Handlebars integration** - Full Handlebars template compilation and rendering
- **Template validation** - Syntax checking and variable validation
- **File generation** - Safe file creation with conflict resolution
- **Template caching** - Compiled template caching for performance

### ✅ Built-in Templates
All templates from the Python budi-cli implementation are included:

- **init.md** - Main task initialization template
- **prompt.md** - Comprehensive agent prompt with task instructions
- **plan.md** - Empty project plan template for user customization
- **USER_FEEDBACK.md** - User feedback and bug report template
- **CLAUDE.md** - Claude session documentation template
- **AGENTS.md** - Available coding agents documentation
- **specs/README.md** - Specifications overview template
- **specs/requirements.md** - Requirements specification template
- **specs/architecture.md** - Architecture specification template

### ✅ Variable Management
- **Type validation** - Email, URL, version, path, subagent validation
- **Interactive collection** - Support for collecting variables from user input
- **Default values** - Automatic default value resolution
- **Custom validators** - Support for custom validation functions
- **Variable dependency resolution** - Hierarchical variable systems

### ✅ File Generation
- **Safe file writing** - Conflict detection and resolution
- **Atomic operations** - All-or-nothing file generation
- **Backup support** - Optional backup creation before overwriting
- **Directory management** - Automatic directory structure creation
- **Permission handling** - Proper file permission management

### ✅ Template Discovery
- **Built-in enumeration** - Access to all built-in templates
- **Template metadata** - Rich template information and categorization
- **Template validation** - Comprehensive syntax and structure validation

### ✅ Integration Features
- **Configuration system** - Integration with project configuration
- **Error handling** - Template-specific error types and messages
- **Progress tracking** - Support for generation progress monitoring
- **Metrics collection** - Template usage and performance metrics

## Usage Examples

### Basic Template Rendering

```typescript
import { TemplateEngine, TemplateUtils } from './templates/engine.js';

// Initialize the engine
const engine = new TemplateEngine();

// Get a built-in template
const initTemplate = engine.getBuiltInTemplate('init.md');

// Create project variables
const variables = TemplateUtils.createDefaultVariables('/path/to/project');
variables.main_task = 'Build an awesome application';
variables.SUBAGENT = 'claude';

// Create template context
const context = await engine.createContext(variables, '/path/to/project');

// Render the template
const rendered = await engine.render(initTemplate, context);
console.log(rendered);
```

### Variable Validation

```typescript
// Validate template variables
const results = await engine.validateVariables(
  { email: 'user@example.com', subagent: 'claude' },
  [
    { name: 'email', type: 'email', required: true, description: 'User email' },
    { name: 'subagent', type: 'subagent', required: true, description: 'AI agent' }
  ]
);

results.forEach((result, index) => {
  console.log(`Variable ${index}: ${result.valid ? 'Valid' : result.error}`);
});
```

### File Generation

```typescript
// Generate files from templates
const templates = [
  engine.getBuiltInTemplate('init.md'),
  engine.getBuiltInTemplate('prompt.md'),
  engine.getBuiltInTemplate('USER_FEEDBACK.md')
].filter(Boolean);

const result = await engine.generateFiles(
  templates,
  '/path/to/target/directory',
  context,
  {
    force: false,
    createBackup: true,
    onConflict: 'skip'
  }
);

console.log(`Generated ${result.files.length} files in ${result.duration}ms`);
```

### Template Validation

```typescript
// Validate all built-in templates
const templates = engine.getBuiltInTemplates();
templates.forEach(template => {
  const validation = engine.validate(template);
  console.log(`${template.id}: ${validation.valid ? '✅' : '❌'} ${validation.error || ''}`);
});
```

## Architecture

### Class Structure

```
TemplateEngine (implements ITemplateEngine)
├── name: string
├── version: string
├── supportedExtensions: string[]
├── handlebars: Handlebars instance
├── templateCache: Map<string, CompiledTemplate>
├── builtInTemplates: Map<string, Template>
└── validators: Map<VariableType, VariableValidator>

Methods:
├── render(template, context, options) → Promise<string>
├── validate(template) → ValidationResult
├── getUsedVariables(template) → string[]
├── generateFiles(templates, targetDir, context, options) → Promise<GenerationResult>
├── createContext(variables, projectPath, options) → Promise<TemplateContext>
├── validateVariables(variables, definitions) → Promise<ValidationResult[]>
├── getBuiltInTemplates() → Template[]
├── getBuiltInTemplate(id) → Template | undefined
├── collectVariables(template, existing, interactive) → Promise<TemplateVariables>
└── previewTemplate(template, context, options) → Promise<string>
```

### Type System

The module uses a comprehensive TypeScript type system with strict typing:

- **Template** - Core template definition with metadata
- **TemplateContext** - Complete rendering context with variables and environment
- **TemplateVariable** - Variable definition with validation rules
- **GenerationResult** - File generation results with detailed status
- **ValidationResult** - Validation outcomes with error details

### Error Handling

Comprehensive error handling with specific error types:

- **TemplateError** - Base template error class
- **TemplateParseError** - Template syntax and parsing errors
- **TemplateVariableError** - Variable validation and missing variable errors
- **TemplateGenerationError** - File generation and I/O errors

## Variable Types Supported

- **text** - General text input with non-empty validation
- **email** - Email address with format validation
- **url** - URL with protocol validation
- **identifier** - Programming identifier (letters, numbers, underscores, hyphens)
- **version** - Semantic version (X.Y.Z format)
- **path** - File system path validation
- **subagent** - AI subagent choice validation (claude, gemini, cursor, codex)
- **choice** - Multiple choice from predefined options
- **boolean** - Boolean value validation
- **number** - Numeric value validation
- **date** - Date value validation
- **timestamp** - Timestamp validation

## Built-in Variable Categories

### Core Variables (Required)
- **TASK** - Main task description
- **SUBAGENT** - Preferred AI subagent
- **GIT_URL** - Git repository URL

### Project Variables
- **PROJECT_NAME** - Project name
- **PROJECT_PATH** - Project root directory
- **PACKAGE_NAME** - Sanitized package name
- **VENV_PATH** - Virtual environment path

### Optional Variables
- **AUTHOR** - Project author name
- **EMAIL** - Author email address
- **LICENSE** - Project license
- **DESCRIPTION** - Project description
- **VERSION** - Initial version

## Python Compatibility

This implementation maintains full compatibility with the Python budi-cli template system:

- **Exact template content** - All built-in templates match the Python implementation
- **Variable substitution** - Compatible `{{VARIABLE_NAME}}` syntax
- **Template structure** - Consistent file organization and naming
- **Default values** - Matching default variable values
- **Validation rules** - Compatible validation patterns

## Performance

The template engine is optimized for performance:

- **Template caching** - Compiled templates are cached for reuse
- **Lazy loading** - Templates are only compiled when first used
- **Efficient validation** - Fast syntax checking and variable validation
- **Minimal dependencies** - Uses only Handlebars for template processing

## Testing

Comprehensive test coverage includes:

- **Template rendering** - Verification of correct template output
- **Variable validation** - Testing all variable types and edge cases
- **Error handling** - Verification of proper error reporting
- **Built-in templates** - Validation of all included templates
- **Utility functions** - Testing of helper functions

## Demo

Run the included demonstration to see all features in action:

```bash
npx tsx src/templates/demo.ts
```

This will showcase:
- Template engine initialization
- Built-in template listing
- Variable creation and validation
- Template rendering with real output
- Utility function demonstrations

## Integration

The template engine integrates seamlessly with the juno-code ecosystem:

- **CLI commands** - Used by `juno-code init` command
- **Configuration** - Integrates with project configuration system
- **File system** - Safe file operations with proper error handling
- **Metrics** - Template usage tracking and performance monitoring