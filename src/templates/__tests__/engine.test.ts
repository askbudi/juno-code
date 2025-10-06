/**
 * @fileoverview Tests for template engine implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateEngine, TemplateUtils } from '../engine.js';
import { TemplateCategory, Template, TemplateContext } from '../types.js';
import * as path from 'path';
import * as os from 'os';

describe('TemplateEngine', () => {
  let engine: TemplateEngine;

  beforeEach(() => {
    engine = new TemplateEngine();
  });

  describe('initialization', () => {
    it('should initialize with correct properties', () => {
      expect(engine.name).toBe('juno-task-handlebars');
      expect(engine.version).toBe('1.0.0');
      expect(engine.supportedExtensions).toEqual(['.md', '.hbs', '.txt', '.json', '.yml', '.ts', '.js']);
    });

    it('should load built-in templates', () => {
      const templates = engine.getBuiltInTemplates();
      expect(templates.length).toBeGreaterThan(0);

      const initTemplate = engine.getBuiltInTemplate('init.md');
      expect(initTemplate).toBeDefined();
      expect(initTemplate?.name).toBe('Main Task Initialization');
      expect(initTemplate?.category).toBe(TemplateCategory.CORE);
    });
  });

  describe('template validation', () => {
    it('should validate a simple template', () => {
      const template: Template = {
        id: 'test',
        name: 'Test Template',
        description: 'A test template',
        category: TemplateCategory.CORE,
        content: 'Hello {{name}}!',
        variables: [
          {
            name: 'name',
            description: 'Name to greet',
            type: 'text',
            required: true
          }
        ],
        version: '1.0.0'
      };

      const result = engine.validate(template);
      expect(result.valid).toBe(true);
    });

    it('should detect invalid template syntax', () => {
      const template: Template = {
        id: 'test',
        name: 'Test Template',
        description: 'A test template',
        category: TemplateCategory.CORE,
        content: 'Hello {{unclosed',
        variables: [],
        version: '1.0.0'
      };

      const result = engine.validate(template);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('syntax error');
    });
  });

  describe('template rendering', () => {
    it('should render a simple template', async () => {
      const template: Template = {
        id: 'test',
        name: 'Test Template',
        description: 'A test template',
        category: TemplateCategory.CORE,
        content: 'Hello {{name}}!',
        variables: [
          {
            name: 'name',
            description: 'Name to greet',
            type: 'text',
            required: true
          }
        ],
        version: '1.0.0'
      };

      const context: TemplateContext = {
        variables: { name: 'World' },
        environment: {
          cwd: process.cwd(),
          variables: {}
        },
        project: {
          name: 'test-project',
          path: process.cwd(),
          packageName: 'test_project'
        },
        git: {},
        timestamp: new Date()
      };

      const result = await engine.render(template, context);
      expect(result).toBe('Hello World!');
    });

    it('should render built-in init template', async () => {
      const template = engine.getBuiltInTemplate('init.md');
      expect(template).toBeDefined();

      if (template) {
        const variables = TemplateUtils.createDefaultVariables('/test/project');
        variables.main_task = 'Test the template system';
        variables.SUBAGENT = 'claude';
        variables.GIT_URL = 'https://github.com/test/repo';

        const context = await engine.createContext(variables, '/test/project');
        const result = await engine.render(template, context);

        expect(result).toContain('# Main Task');
        expect(result).toContain('Test the template system');
        expect(result).toContain('claude');
        expect(result).toContain('https://github.com/test/repo');
      }
    });
  });

  describe('variable validation', () => {
    it('should validate email addresses', async () => {
      const variables = { email: 'test@example.com' };
      const definitions = [
        {
          name: 'email',
          description: 'Email address',
          type: 'email' as const,
          required: true
        }
      ];

      const results = await engine.validateVariables(variables, definitions);
      expect(results[0].valid).toBe(true);
    });

    it('should reject invalid email addresses', async () => {
      const variables = { email: 'invalid-email' };
      const definitions = [
        {
          name: 'email',
          description: 'Email address',
          type: 'email' as const,
          required: true
        }
      ];

      const results = await engine.validateVariables(variables, definitions);
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toContain('Invalid email format');
    });

    it('should validate subagent choices', async () => {
      const variables = { subagent: 'claude' };
      const definitions = [
        {
          name: 'subagent',
          description: 'AI subagent',
          type: 'subagent' as const,
          required: true
        }
      ];

      const results = await engine.validateVariables(variables, definitions);
      expect(results[0].valid).toBe(true);
    });

    it('should reject invalid subagent choices', async () => {
      const variables = { subagent: 'invalid-agent' };
      const definitions = [
        {
          name: 'subagent',
          description: 'AI subagent',
          type: 'subagent' as const,
          required: true
        }
      ];

      const results = await engine.validateVariables(variables, definitions);
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toContain('Invalid subagent');
    });
  });

  describe('context creation', () => {
    it('should create template context with project info', async () => {
      const variables = TemplateUtils.createDefaultVariables('/test/project', 'test-app');
      const context = await engine.createContext(variables, '/test/project');

      expect(context.variables.PROJECT_NAME).toBe('test-app');
      expect(context.variables.PROJECT_PATH).toBe('/test/project');
      expect(context.environment.cwd).toBe('/test/project');
      expect(context.project.name).toBe('test-app');
      expect(context.project.path).toBe('/test/project');
      expect(context.timestamp).toBeInstanceOf(Date);
    });
  });
});

describe('TemplateUtils', () => {
  describe('createDefaultVariables', () => {
    it('should create default variables for a project', () => {
      const variables = TemplateUtils.createDefaultVariables('/test/my-project');

      expect(variables.PROJECT_NAME).toBe('my-project');
      expect(variables.PROJECT_PATH).toBe('/test/my-project');
      expect(variables.PACKAGE_NAME).toBe('my_project');
      expect(variables.TASK).toBe('Define your main task objective here');
      expect(variables.SUBAGENT).toBe('claude');
      expect(variables.GIT_URL).toBe('https://github.com/owner/repo');
      expect(variables.CURRENT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should handle custom project name', () => {
      const variables = TemplateUtils.createDefaultVariables('/test/path', 'custom-name');

      expect(variables.PROJECT_NAME).toBe('custom-name');
      expect(variables.PACKAGE_NAME).toBe('custom_name');
    });
  });

  describe('isValidTemplateId', () => {
    it('should validate template IDs', () => {
      expect(TemplateUtils.isValidTemplateId('init.md')).toBe(true);
      expect(TemplateUtils.isValidTemplateId('specs/requirements.md')).toBe(true);
      expect(TemplateUtils.isValidTemplateId('my_template')).toBe(true);
      expect(TemplateUtils.isValidTemplateId('template-1.0')).toBe(true);

      expect(TemplateUtils.isValidTemplateId('')).toBe(false);
      expect(TemplateUtils.isValidTemplateId('invalid template')).toBe(false);
      expect(TemplateUtils.isValidTemplateId('template@1.0')).toBe(false);
    });
  });

  describe('extractVariablesFromContent', () => {
    it('should extract variables from template content', () => {
      const content = 'Hello {{name}}, your task is {{TASK}} with {{SUBAGENT}}.';
      const variables = TemplateUtils.extractVariablesFromContent(content);

      expect(variables).toEqual(['name', 'TASK', 'SUBAGENT']);
    });

    it('should handle empty content', () => {
      const variables = TemplateUtils.extractVariablesFromContent('');
      expect(variables).toEqual([]);
    });

    it('should handle content without variables', () => {
      const variables = TemplateUtils.extractVariablesFromContent('Static content');
      expect(variables).toEqual([]);
    });
  });

  describe('mergeVariables', () => {
    it('should merge variables with overrides', () => {
      const defaults = { a: 1, b: 2, c: 3 };
      const overrides = { b: 'override', d: 'new' };

      const result = TemplateUtils.mergeVariables(defaults, overrides);

      expect(result).toEqual({
        a: 1,
        b: 'override',
        c: 3,
        d: 'new'
      });
    });
  });
});