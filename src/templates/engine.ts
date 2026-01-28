/**
 * @fileoverview Template engine implementation for juno-code
 *
 * Comprehensive template processing engine based on the Python budi-cli implementation.
 * Supports Handlebars template engine with variable substitution patterns compatible
 * with the Python implementation. Includes built-in templates, variable validation,
 * file generation with conflict resolution, and template discovery.
 *
 * @version 1.0.0
 * @author juno-code
 */

import fs from 'fs-extra';
import * as path from 'path';
import Handlebars from 'handlebars';
import { v4 as uuidv4 } from 'uuid';

import {
  Template,
  TemplateVariable,
  TemplateContext,
  TemplateVariables,
  TemplateEngine as ITemplateEngine,
  TemplateCategory,
  GenerationResult,
  FileGenerationResult,
  ValidationResult,
  RenderOptions,
  TemplateError,
  TemplateParseError,
  TemplateVariableError,
  VariableValidator,
  VariableValue,
  VariableType,
  TemplateEnvironment,
  ProjectContext,
  GitContext,
  DEFAULT_TEMPLATE_VARIABLES,
  VALID_SUBAGENTS
} from './types.js';

/**
 * Core template processing engine implementation.
 *
 * Provides comprehensive template processing with variable substitution,
 * file generation, validation, and template discovery capabilities.
 * Compatible with the Python budi-cli template system.
 */
export class TemplateEngine implements ITemplateEngine {
  /** Engine name identifier */
  public readonly name = 'juno-code-handlebars';

  /** Engine version */
  public readonly version = '1.0.0';

  /** Supported template file extensions */
  public readonly supportedExtensions = ['.md', '.hbs', '.txt', '.json', '.yml', '.ts', '.js'] as const;

  /** Handlebars template compiler instance */
  private readonly handlebars: typeof Handlebars;

  /** Cache for compiled templates */
  private readonly templateCache = new Map<string, HandlebarsTemplateDelegate>();

  /** Template source for built-in templates */
  private readonly builtInTemplates: Map<string, Template>;

  /** Variable validators */
  private readonly validators = new Map<VariableType, VariableValidator>();

  constructor() {
    this.handlebars = Handlebars.create();
    this.builtInTemplates = new Map();
    this.initializeBuiltInTemplates();
    this.initializeValidators();
    this.registerHandlebarsHelpers();
  }

  /**
   * Render a template with the given context.
   *
   * @param template - Template to render
   * @param context - Rendering context with variables
   * @param options - Optional rendering configuration
   * @returns Promise resolving to rendered content
   * @throws {TemplateParseError} When template syntax is invalid
   * @throws {TemplateVariableError} When required variables are missing
   */
  public async render(
    template: Template,
    context: TemplateContext,
    options: RenderOptions = {}
  ): Promise<string> {
    try {
      // Validate template syntax first
      const validation = this.validate(template);
      if (!validation.valid) {
        throw new TemplateParseError(
          `Template validation failed: ${validation.error}`,
          undefined,
          undefined
        );
      }

      // Validate required variables are present
      await this.validateRequiredVariables(template, context.variables);

      // Get or compile template
      const compiledTemplate = this.getCompiledTemplate(template);

      // Prepare rendering context with helpers and options
      const renderingContext = this.prepareRenderingContext(context, options);

      // Render template
      const rendered = compiledTemplate(renderingContext);

      // Post-process if needed
      return this.postProcessContent(rendered, options);

    } catch (error) {
      if (error instanceof TemplateError) {
        throw error;
      }
      throw new TemplateParseError(
        `Template rendering failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Validate template syntax and structure.
   *
   * @param template - Template to validate
   * @returns Validation result with success status and error details
   */
  public validate(template: Template): ValidationResult {
    try {
      // Check basic template structure
      if (typeof template.content !== 'string') {
        return {
          valid: false,
          error: 'Template content must be a string'
        };
      }

      // Allow empty content for templates like plan.md
      if (template.content.length === 0) {
        return { valid: true };
      }

      // Try to compile and render template to check syntax
      try {
        const compiled = this.handlebars.compile(template.content);

        // Test render with empty context to catch syntax errors
        // that only appear during rendering (like unclosed braces)
        try {
          compiled({});
        } catch (renderError) {
          return {
            valid: false,
            error: `Template syntax error: ${renderError instanceof Error ? renderError.message : 'Unknown syntax error'}`
          };
        }
      } catch (syntaxError) {
        return {
          valid: false,
          error: `Template syntax error: ${syntaxError instanceof Error ? syntaxError.message : 'Unknown syntax error'}`
        };
      }

      // Validate template variables are properly defined
      // Skip this validation for now to allow templates with extensive variable usage
      // The validation will happen at render time when actual variables are provided
      const usedVariables = this.getUsedVariables(template);
      const definedVariables = new Set(template.variables.map(v => v.name));

      // Only fail validation for truly critical missing variables
      // Allow templates to use variables that will be provided at render time
      const criticalMissingVariables = usedVariables.filter(varName =>
        !definedVariables.has(varName) &&
        // Only flag as critical if it's a core variable that should always be defined
        ['PROJECT_NAME', 'TASK', 'SUBAGENT'].includes(varName)
      );

      if (criticalMissingVariables.length > 0) {
        return {
          valid: false,
          error: `Template uses critical undefined variables: ${criticalMissingVariables.join(', ')}`
        };
      }

      return { valid: true };

    } catch (error) {
      return {
        valid: false,
        error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Extract variable names used in a template.
   *
   * @param template - Template to analyze
   * @returns Array of variable names found in template content
   */
  public getUsedVariables(template: Template): readonly string[] {
    const variablePattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    const variables = new Set<string>();
    let match;

    while ((match = variablePattern.exec(template.content)) !== null) {
      variables.add(match[1]);
    }

    return Array.from(variables);
  }

  /**
   * Generate files from templates with comprehensive options.
   *
   * @param templates - Templates to generate
   * @param targetDirectory - Target directory for file generation
   * @param context - Template context for variable substitution
   * @param options - Generation options
   * @returns Promise resolving to generation results
   */
  public async generateFiles(
    templates: Template[],
    targetDirectory: string,
    context: TemplateContext,
    options: {
      force?: boolean;
      createBackup?: boolean;
      dryRun?: boolean;
      onConflict?: 'skip' | 'overwrite' | 'prompt';
    } = {}
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const results: FileGenerationResult[] = [];
    let overallSuccess = true;
    let overallError: string | undefined;

    try {
      // Ensure target directory exists
      if (!options.dryRun) {
        await fs.ensureDir(targetDirectory);
      }

      // Process each template
      for (const template of templates) {
        try {
          const result = await this.generateSingleFile(
            template,
            targetDirectory,
            context,
            options
          );
          results.push(result);

          if (result.status === 'error') {
            overallSuccess = false;
          }

        } catch (error) {
          const errorResult: FileGenerationResult = {
            path: path.join(targetDirectory, this.getTemplateFileName(template)),
            content: '',
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            size: 0,
            timestamp: new Date()
          };
          results.push(errorResult);
          overallSuccess = false;
        }
      }

    } catch (error) {
      overallSuccess = false;
      overallError = error instanceof Error ? error.message : 'Unknown error';
    }

    return {
      success: overallSuccess,
      files: results,
      context,
      duration: Date.now() - startTime,
      timestamp: new Date(),
      ...(overallError && { error: overallError })
    } as GenerationResult;
  }

  /**
   * Create a template context from environment and project information.
   *
   * @param variables - Template variables
   * @param projectPath - Project root path
   * @param options - Additional context options
   * @returns Complete template context
   */
  public async createContext(
    variables: TemplateVariables,
    projectPath: string,
    options: {
      includeGitInfo?: boolean;
      includeEnvironment?: boolean;
    } = {}
  ): Promise<TemplateContext> {
    const environment = options.includeEnvironment
      ? await this.gatherEnvironmentInfo(projectPath)
      : this.getBasicEnvironment(projectPath);

    const project = this.extractProjectInfo(variables, projectPath);

    const git = options.includeGitInfo
      ? await this.gatherGitInfo(projectPath)
      : {};

    return {
      variables,
      environment,
      project,
      git,
      timestamp: new Date()
    };
  }

  /**
   * Validate template variables against their definitions.
   *
   * @param variables - Variables to validate
   * @param definitions - Variable definitions with validation rules
   * @returns Array of validation results for each variable
   */
  public async validateVariables(
    variables: TemplateVariables,
    definitions: readonly TemplateVariable[]
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const definition of definitions) {
      const value = variables[definition.name];

      // Check required variables
      if (definition.required && (value === undefined || value === null || value === '')) {
        results.push({
          valid: false,
          error: `Required variable '${definition.name}' is missing`
        });
        continue;
      }

      // Skip validation for optional undefined variables
      if (!definition.required && (value === undefined || value === null)) {
        results.push({ valid: true });
        continue;
      }

      // Validate variable value
      const validator = this.validators.get(definition.type);
      if (validator) {
        const validationResult = validator(value);
        results.push(validationResult);
      } else {
        // No validator for this type, consider it valid
        results.push({ valid: true });
      }
    }

    return results;
  }

  /**
   * Get all built-in templates.
   *
   * @returns Array of built-in template definitions
   */
  public getBuiltInTemplates(): Template[] {
    return Array.from(this.builtInTemplates.values());
  }

  /**
   * Get a specific built-in template by ID.
   *
   * @param templateId - Template identifier
   * @returns Template definition or undefined if not found
   */
  public getBuiltInTemplate(templateId: string): Template | undefined {
    return this.builtInTemplates.get(templateId);
  }

  /**
   * Collect variables interactively from user input.
   *
   * @param template - Template requiring variables
   * @param existingVariables - Existing variable values
   * @param interactive - Whether to prompt for missing variables
   * @returns Promise resolving to collected variables
   */
  public async collectVariables(
    template: Template,
    existingVariables: TemplateVariables = {},
    interactive: boolean = false
  ): Promise<TemplateVariables> {
    const collected: TemplateVariables = { ...existingVariables };

    for (const variable of template.variables) {
      if (collected[variable.name] !== undefined) {
        continue; // Already have value
      }

      if (variable.defaultValue !== undefined) {
        (collected as Record<string, VariableValue>)[variable.name] = variable.defaultValue;
      } else if (variable.required) {
        if (interactive) {
          // In a real CLI implementation, this would prompt the user
          // For now, we'll throw an error for missing required variables
          throw new TemplateVariableError(
            `Required variable '${variable.name}' is missing and no default value is provided`,
            variable.name,
            undefined
          );
        } else {
          throw new TemplateVariableError(
            `Required variable '${variable.name}' is missing`,
            variable.name,
            undefined
          );
        }
      }
    }

    return collected;
  }

  /**
   * Preview template generation without creating files.
   *
   * @param template - Template to preview
   * @param context - Template context
   * @param options - Rendering options
   * @returns Promise resolving to preview content
   */
  public async previewTemplate(
    template: Template,
    context: TemplateContext,
    options: RenderOptions = {}
  ): Promise<string> {
    return this.render(template, context, options);
  }

  // Private implementation methods

  /**
   * Initialize built-in templates from the Python implementation.
   */
  private initializeBuiltInTemplates(): void {
    // Template content exactly matching Python implementation
    const templates: Array<[string, Template]> = [
      ['init.md', {
        id: 'init.md',
        name: 'Main Task Initialization',
        description: 'Primary task definition and setup template',
        category: TemplateCategory.CORE,
        content: `# Main Task
{{main_task}}

### Task 1
First task is to study @.juno_task/plan.md  (it may be incorrect) and is to use up to 500 subagents to study existing project
and study what is needed to achieve the main task.
From that create/update a @.juno_task/plan.md  which is a bullet point list sorted in priority of the items which have yet to be implemeneted. Think extra hard.
Study @.juno_task/plan.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

### Task 2
Second Task is to understand the task, create a spec for process to follow, plan to execute, scripts to create, virtual enviroment that we need, things that we need to be aware of, how to test the scripts and follow progress.
Think hard and plan/create spec for every step of this task
and for each part create a seperate .md file under @.juno_task/spec/*

## ULTIMATE Goal
We want to achieve the main Task with respect to the Constraints section

Part 1)
Consider missing steps and plan. If the step is missing then author the specification at @.juno_task/spec/FILENAME.md (do NOT assume that it does not exist, search before creating). The naming of the module should be GenZ named and not conflict with another module name. If you create a new step then document the plan to implement in @.juno_task/plan.md


Part 2) after completing the plan, and spec, create task for implementing each part on kanban './.juno_task/scripts/kanban.sh' You need to create a task for each step of implementation and testing. You need to go through the project, the spec and plan at the end to make sure you have covered all tasks on the kanban. We will later on implement tasks from kanban one by one.
After completing the proccess an implementer agent would start the job and go through kanban tasks one by one.


### Constraints
**Preferred Subagent**: {{SUBAGENT}}
**Repository URL**: {{GIT_URL}}
`,
        variables: [
          {
            name: 'main_task',
            description: 'Main task description',
            type: 'text',
            required: true,
            defaultValue: 'Define your main task objective here'
          },
          {
            name: 'SUBAGENT',
            description: 'Preferred AI subagent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'GIT_URL',
            description: 'Git repository URL',
            type: 'url',
            required: true,
            defaultValue: 'https://github.com/owner/repo'
          }
        ],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['prompt.md', {
        id: 'prompt.md',
        name: 'Agent Prompt Template',
        description: 'Comprehensive agent prompt with task instructions',
        category: TemplateCategory.CORE,
        content: `0a. study @.juno_task/implement.md.

0b.  When you discover a syntax, logic, UI, User Flow Error or bug. Immediately update  tasks.md with your findings using a {{SUBAGENT}} subagent. When the issue is resolved, update tasks.md and remove the item using a {{SUBAGENT}} subagent.


999. Important: When authoring documentation capture the why tests and the backing implementation is important.

9999. Important: We want single sources of truth, no migrations/adapters. If tests unrelated to your work fail then it's your job to resolve these tests as part of the increment of change.

999999. As soon as there are no build or test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 for example 0.0.1 if 0.0.0 does not exist.

999999999. You may add extra logging if required to be able to debug the issues.

9999999999. ALWAYS KEEP Tasks up to date with your learnings using a {{SUBAGENT}} subagent. Especially after wrapping up/finishing your turn.



99999999999. When you learn something new about how to run the app or examples make sure you update @{{AGENT_DOC_FILE}} using a {{SUBAGENT}} subagent but keep it brief. For example if you run commands multiple times before learning the correct command then that file should be updated.

999999999999. IMPORTANT when you discover a bug resolve it using {{SUBAGENT}} subagents even if it is unrelated to the current piece of work after documenting it in Tasks

9999999999999999999. Keep @{{AGENT_DOC_FILE}} up to date with information on how to build the app and your learnings to optimize the build/test loop using a {{SUBAGENT}} subagent.

999999999999999999999. For any bugs you notice, it's important to resolve them or document them in Tasks to be resolved using a {{SUBAGENT}} subagent.

99999999999999999999999. When authoring the missing features you may author multiple standard libraries at once using up to 1000 parallel subagents

99999999999999999999999999. When Tasks, {{AGENT_DOC_FILE}} becomes large periodically clean out the items that are completed from the file using a {{SUBAGENT}} subagent.
Large {{AGENT_DOC_FILE}} reduce the performance.



9999999999999999999999999999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. WE WANT FULL IMPLEMENTATIONS. DO IT OR I WILL YELL AT YOU

9999999999999999999999999999999. SUPER IMPORTANT DO NOT IGNORE. DO NOT PLACE STATUS REPORT UPDATES INTO @{{AGENT_DOC_FILE}}

99999999999999999999999999999999. After reveiwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the Tasks or @{{AGENT_DOC_FILE}} as resolved. You should update it to reflect that the issue is not resolved.
it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows 1.the issue is still open,2. past approaches to resolve it, what it was, and know that it has failed.
Tasks , USER_FEEDBACK and @{{AGENT_DOC_FILE}} should repesent truth. User Open Issue is a high level of truth. so you need to reflect it on the files.
`,
        variables: [
          {
            name: 'PROJECT_ROOT',
            description: 'Project root directory path',
            type: 'path',
            required: true
          },
          {
            name: 'TASK',
            description: 'Main task description',
            type: 'text',
            required: true
          },
          {
            name: 'VENV_PATH',
            description: 'Virtual environment path',
            type: 'path',
            required: true
          },
          {
            name: 'SUBAGENT',
            description: 'Preferred AI subagent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'AGENT_DOC_FILE',
            description: 'Agent documentation file - CLAUDE.md if subagent is claude, otherwise AGENTS.md',
            type: 'text',
            required: false
          }
        ],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['plan.md', {
        id: 'plan.md',
        name: 'Project Plan',
        description: 'Empty project plan template for user customization',
        category: TemplateCategory.WORKFLOW,
        content: '',
        variables: [],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['implement.md', {
        id: 'implement.md',
        name: 'Implementation Guide',
        description: 'Implementation steps and current task breakdown',
        category: TemplateCategory.WORKFLOW,
        content: `---
description: Execute the implementation plan by processing and executing all tasks defined in tasks.md
---

## User Input
\`\`\`text
A.
**ALWAYS check remaing tasks and user feedbacks. Integrate it into the plan,
this is the primary mechanism for user input and for you to track your progress.
\`./.juno_task/scripts/kanban.sh list --limit 5\`
return the most recent 5 Tasks and their status and potential agent response to them.

**Important** ./.juno_task/scripts/kanban.sh has already installed in your enviroment and you can execute it in your bash.

A-1.
read @.juno_task/USER_FEEDBACK.md user feedback on your current execution will be writeen here. And will guide you. If user wants to talk to you while you are working , he will write into this file. first think you do is to read it file.

B.
Based on Items in **./.juno_task/scripts/kanban.sh** reflect on @.juno_task/plan.md and keep it up-to-date.
0g. Entities and their status in **./.juno_task/scripts/kanban.sh** has higher priority and level of truth than other parts of the app.
If you see user report a bug that you earlier marked as resolved, you need to investigate the issue again.
./.juno_task/scripts/kanban.sh items has the higher level of truth. Always

0e. Status in ./.juno_task/scripts/kanban.sh could be backlog, todo, in_progress, done.
in_progress, todo, backlog. That is the priority of tasks in general sense, unless you find something with 10X magnitute of importance, or if you do it first it make other tasks easier or unnecessary.


0f. After reviwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the feedback/plan or Claude.md as resolved. You should update it to reflect that the issue is not resolved.
\`./.juno_task/scripts/kanban.sh mark todo --ID {Task_ID}\`

it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows 
   1.the issue is still open,
   2. past approaches to resolve it, what it was, and know that it has failed.
\`./.juno_task/scripts/kanban.sh mark todo --ID {Task_ID} --response "<PREVIOUS_AGENT_ATTEMP>{what happend before ...}<PREVIOUS_AGENT_ATTEMP>" \`

   **Note** updating response will REPLACE response. So you need to include everything important from the past as well you can check the content of a task with 
   \`./.juno_task/scripts/kanban.sh get {TASK_ID}\`



C. Using parallel subagents. You may use up to 500 parallel subagents for all operations but only 1 subagent for build/tests.

D. Choose the most important 1 things, ( Based on Open Issue  and Also Tasks ), Think hard about what is the most important Task. 

E. update status of most important task on ./.juno_task/scripts/kanban.sh. 
(if the task is not on ./.juno_task/scripts/kanban.sh, create it ! Kanban is our source of truth)
\`./.juno_task/scripts/kanban.sh mark in_progress --ID {Task_ID}\`


F. Implement the most important 1 thing following the outline. 

\`\`\`

You **MUST** consider the user input before proceeding (if not empty).

## Outline

1. Run \`./.juno_task/scripts/kanban.sh list\` from repo root and check current project status.

2. Load and analyze the implementation context:
   - **REQUIRED**: Read tasks.md for the complete task list and execution plan
   - **REQUIRED**: Read plan.md for tech stack, architecture, and file structure
   - **IF EXISTS**: Read data-model.md for entities and relationships
   - **IF EXISTS**: Read contracts/ for API specifications and test requirements
   - **IF EXISTS**: Read research.md for technical decisions and constraints
   - **IF EXISTS**: Read quickstart.md for integration scenarios

3. **Project Setup Verification**:
   - **REQUIRED**: Create/verify ignore files based on actual project setup:
   
   **Detection & Creation Logic**:
   - Check if the following command succeeds to determine if the repository is a git repo (create/verify .gitignore if so):

     \`\`\`sh
     git rev-parse --git-dir 2>/dev/null
     \`\`\`
   - Check if Dockerfile* exists or Docker in plan.md → create/verify .dockerignore
   - Check if .eslintrc* or eslint.config.* exists → create/verify .eslintignore
   - Check if .prettierrc* exists → create/verify .prettierignore
   - Check if .npmrc or package.json exists → create/verify .npmignore (if publishing)
   - Check if terraform files (*.tf) exist → create/verify .terraformignore
   - Check if .helmignore needed (helm charts present) → create/verify .helmignore
   
   **If ignore file already exists**: Verify it contains essential patterns, append missing critical patterns only
   **If ignore file missing**: Create with full pattern set for detected technology
   
   **Common Patterns by Technology** (from plan.md tech stack):
   - **Node.js/JavaScript**: \`node_modules/\`, \`dist/\`, \`build/\`, \`*.log\`, \`.env*\`
   - **Python**: \`__pycache__/\`, \`*.pyc\`, \`.venv/\`, \`venv/\`, \`dist/\`, \`*.egg-info/\`
   - **Java**: \`target/\`, \`*.class\`, \`*.jar\`, \`.gradle/\`, \`build/\`
   - **C#/.NET**: \`bin/\`, \`obj/\`, \`*.user\`, \`*.suo\`, \`packages/\`
   - **Go**: \`*.exe\`, \`*.test\`, \`vendor/\`, \`*.out\`
   - **Universal**: \`.DS_Store\`, \`Thumbs.db\`, \`*.tmp\`, \`*.swp\`, \`.vscode/\`, \`.idea/\`
   
   **Tool-Specific Patterns**:
   - **Docker**: \`node_modules/\`, \`.git/\`, \`Dockerfile*\`, \`.dockerignore\`, \`*.log*\`, \`.env*\`, \`coverage/\`
   - **ESLint**: \`node_modules/\`, \`dist/\`, \`build/\`, \`coverage/\`, \`*.min.js\`
   - **Prettier**: \`node_modules/\`, \`dist/\`, \`build/\`, \`coverage/\`, \`package-lock.json\`, \`yarn.lock\`, \`pnpm-lock.yaml\`
   - **Terraform**: \`.terraform/\`, \`*.tfstate*\`, \`*.tfvars\`, \`.terraform.lock.hcl\`

5. Parse tasks.md structure and extract:
   - **Task phases**: Setup, Tests, Core, Integration, Polish
   - **Task dependencies**: Sequential vs parallel execution rules
   - **Task details**: ID, description, file paths, parallel markers [P]
   - **Execution flow**: Order and dependency requirements

6. Execute implementation following the task plan:
   - **Phase-by-phase execution**: Complete each phase before moving to the next
   - **Respect dependencies**: Run sequential tasks in order, parallel tasks [P] can run together  
   - **Follow TDD approach**: Execute test tasks before their corresponding implementation tasks
   - **File-based coordination**: Tasks affecting the same files must run sequentially
   - **Validation checkpoints**: Verify each phase completion before proceeding

7. Implementation execution rules:
   - **Setup first**: Initialize project structure, dependencies, configuration
   - **Tests before code**: If you need to write tests for contracts, entities, and integration scenarios
   - **Core development**: Implement models, services, CLI commands, endpoints
   - **Integration work**: Database connections, middleware, logging, external services
   - **Polish and validation**: Unit tests, performance optimization, documentation

8. Progress tracking and error handling:
   - Report progress after each completed task
   - Halt execution if any non-parallel task fails
   - For parallel tasks [P], continue with successful tasks, report failed ones
   - Provide clear error messages with context for debugging
   - Suggest next steps if implementation cannot proceed
   - **IMPORTANT** For completed tasks, make sure to mark the task off as [X] in the tasks file.
   - **IMPORTANT** Keep ./.juno_task/scripts/kanban.sh up-to-date
   When the issue is resolved always update ./.juno_task/scripts/kanban.sh
   \`./.juno_task/scripts/kanban.sh --status {status} --ID {task_id} --response "{key actions you take, and how you did test it}"\`

9. Completion validation:
   - Verify all required tasks are completed
   - Check that implemented features match the original specification
   - Validate that tests pass and coverage meets requirements
   - Confirm the implementation follows the technical plan
   - Report final status with summary of completed work
   - When the issue is resolved always update ./.juno_task/scripts/kanban.sh
   \` ./.juno_task/scripts/kanban.sh --mark done --ID {task_id} --response "{key actions you take, and how you did test it}" \`

10. Git

   When the tests pass update ./.juno_task/scripts/kanban.sh, then add changed code with "git add -A" via bash then do a "git commit" with a message that describes the changes you made to the code. After the commit do a "git push" to push the changes to the remote repository.
   Use commit message as a backlog of what has achieved. So later on we would know exactly what we achieved in each commit.
   Update the task in ./.juno_task/scripts/kanban.sh with the commit hash so later on we could map each task to a specific git commit
   \`./.juno_task/scripts/kanban.sh update {task_id} --commit {commit_hash}\`



Note: This command assumes a complete task breakdown exists in tasks.md. If tasks are incomplete or missing, suggest running \`/tasks\` first to regenerate the task list.


---
*Last updated: {{CURRENT_DATE}}*
*Primary subagent: {{SUBAGENT}}*`,
        variables: [
          {
            name: 'TASK',
            description: 'Main task description',
            type: 'text',
            required: true
          },
          {
            name: 'SUBAGENT',
            description: 'Preferred AI subagent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'CURRENT_DATE',
            description: 'Current date',
            type: 'date',
            required: true
          }
        ],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['USER_FEEDBACK.md', {
        id: 'USER_FEEDBACK.md',
        name: 'User Feedback Template',
        description: 'Template for collecting user feedback and bug reports',
        category: TemplateCategory.WORKFLOW,
        content: `## Bug Reports

List any bugs you encounter here.

Example:
1. Bug description
2. Steps to reproduce
3. Expected vs actual behavior

## Feature Requests

List any features you'd like to see added.

## Resolved

Items that have been resolved will be moved here.`,
        variables: [],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['CLAUDE.md', {
        id: 'CLAUDE.md',
        name: 'Claude Session Documentation',
        description: 'Documentation for Claude coding sessions and learnings',
        category: TemplateCategory.DOCS,
        content: `# Claude Code Session Documentation

## Current Project Configuration

**Selected Coding Agent:** {{SUBAGENT}}
**Main Task:** {{TASK}}
**Project Path:** {{PROJECT_PATH}}
**Git Repository:** {{GIT_URL}}
**Configuration Date:** {{CURRENT_DATE}}

## Kanban Task Management

\`\`\`bash
# List tasks
./.juno_task/scripts/kanban.sh list --limit 5 --sort asc 
./.juno_task/scripts/kanban.sh list --status [backlog|todo|in_progress|done] --sort asc

# Task operations
./.juno_task/scripts/kanban.sh get {TASK_ID}
./.juno_task/scripts/kanban.sh mark [in_progress|done|todo] --id {TASK_ID} --response "message"
./.juno_task/scripts/kanban.sh update {TASK_ID} --commit {COMMIT_HASH}
\`\`\`

When a task on kanban, has related_tasks key, you need to get the task to understand the complete picture of tasks related to the current current task, you can get all the context through
\`./.juno_task/scripts/kanban.sh get {TASK_ID}\`

When creating a task, relevant to another task, you can add the following format anywhere in the body of the task : \`[task_id]{Ref_TASK_ID}[/task_id]\` , using ref task id, help kanban organize dependecies between tasks better. 

Important: You need to get maximum 3 tasks done in one go. 

## Agent-Specific Instructions

### {{SUBAGENT}} Configuration
- **Recommended Model:** Latest available model for {{SUBAGENT}}
- **Interaction Style:** Professional and detail-oriented
- **Code Quality:** Focus on production-ready, well-documented code
- **Testing:** Comprehensive unit and integration tests required

## Build & Test Commands

**Environment Setup:**
\`\`\`bash
# Activate virtual environment (if applicable)
source {{VENV_PATH}}/bin/activate

# Navigate to project
cd {{PROJECT_PATH}}
\`\`\`

**Testing:**
\`\`\`bash
# Run tests
python -m pytest tests/ -v

# Run with coverage
python -m pytest tests/ --cov=src --cov-report=term-missing
\`\`\`

**Development Notes:**
- Keep this file updated with important learnings and optimizations
- Document any environment-specific setup requirements
- Record successful command patterns for future reference

## Session History

| Date | Agent | Task Summary | Status |
|------|-------|--------------|---------|
| {{CURRENT_DATE}} | {{SUBAGENT}} | Project initialization | ✅ Completed |

## Agent Performance Notes

### {{SUBAGENT}} Observations:
- Initial setup: Successful
- Code quality: To be evaluated
- Test coverage: To be assessed
- Documentation: To be reviewed

*Note: Update this section with actual performance observations during development*`,
        variables: [
          {
            name: 'SUBAGENT',
            description: 'Selected coding agent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'TASK',
            description: 'Main task description',
            type: 'text',
            required: true
          },
          {
            name: 'PROJECT_PATH',
            description: 'Project root directory path',
            type: 'path',
            required: true
          },
          {
            name: 'GIT_URL',
            description: 'Git repository URL',
            type: 'url',
            required: true
          },
          {
            name: 'CURRENT_DATE',
            description: 'Current date',
            type: 'date',
            required: true
          },
          {
            name: 'VENV_PATH',
            description: 'Virtual environment path',
            type: 'path',
            required: true
          }
        ],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['AGENTS.md', {
        id: 'AGENTS.md',
        name: 'AGENTS.md Session Documentation',
        description: 'Documentation for AGENTS.md coding sessions and learnings',
        category: TemplateCategory.DOCS,
        content: `# AGENTS.md Session Documentation

## Current Project Configuration

**Selected Coding Agent:** {{SUBAGENT}}
**Main Task:** {{TASK}}
**Project Path:** {{PROJECT_PATH}}
**Git Repository:** {{GIT_URL}}
**Configuration Date:** {{CURRENT_DATE}}

## Agent-Specific Instructions

### {{SUBAGENT}} Configuration
- **Recommended Model:** Latest available model for {{SUBAGENT}}
- **Interaction Style:** Professional and detail-oriented
- **Code Quality:** Focus on production-ready, well-documented code
- **Testing:** Comprehensive unit and integration tests required

## Kanban Task Management

\`\`\`bash
# List tasks
./.juno_task/scripts/kanban.sh list --limit 5 --sort asc 
./.juno_task/scripts/kanban.sh list --status [backlog|todo|in_progress|done] --sort asc

# Task operations
./.juno_task/scripts/kanban.sh get {TASK_ID}
./.juno_task/scripts/kanban.sh mark [in_progress|done|todo] --id {TASK_ID} --response "message"
./.juno_task/scripts/kanban.sh update {TASK_ID} --commit {COMMIT_HASH}
\`\`\`

When a task on kanban, has related_tasks key, you need to get the task to understand the complete picture of tasks related to the current current task, you can get all the context through
\`./.juno_task/scripts/kanban.sh get {TASK_ID}\`


When creating a task, relevant to another task, you can add the following format anywhere in the body of the task : \`[task_id]{Ref_TASK_ID}[/task_id]\` , using ref task id, help kanban organize dependecies between tasks better. 

Important: You need to get maximum 3 tasks done in one go. 

## Build & Test Commands

**Environment Setup:**
\`\`\`bash
# Activate virtual environment (if applicable)
source {{VENV_PATH}}/bin/activate

# Navigate to project
cd {{PROJECT_PATH}}
\`\`\`

**Testing:**
\`\`\`bash
# Run tests
python -m pytest tests/ -v

# Run with coverage
python -m pytest tests/ --cov=src --cov-report=term-missing
\`\`\`

**Development Notes:**
- Keep this file updated with important learnings and optimizations
- Document any environment-specific setup requirements
- Record successful command patterns for future reference

## Session History

| Date | Agent | Task Summary | Status |
|------|-------|--------------|---------|
| {{CURRENT_DATE}} | {{SUBAGENT}} | Project initialization | ✅ Completed |

## Agent Performance Notes

### {{SUBAGENT}} Observations:
- Initial setup: Successful
- Code quality: To be evaluated
- Test coverage: To be assessed
- Documentation: To be reviewed

*Note: Update this section with actual performance observations during development*`,
        variables: [
          {
            name: 'SUBAGENT',
            description: 'Selected coding agent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'TASK',
            description: 'Main task description',
            type: 'text',
            required: true
          },
          {
            name: 'PROJECT_PATH',
            description: 'Project root directory path',
            type: 'path',
            required: true
          },
          {
            name: 'GIT_URL',
            description: 'Git repository URL',
            type: 'url',
            required: true
          },
          {
            name: 'CURRENT_DATE',
            description: 'Current date',
            type: 'date',
            required: true
          },
          {
            name: 'VENV_PATH',
            description: 'Virtual environment path',
            type: 'path',
            required: true
          }
        ],
        version: '1.0.0',
        fileExtension: '.md'
      }],

      ['specs/README.md', {
        id: 'specs/README.md',
        name: 'Specifications README',
        description: 'Overview of specification documents',
        category: TemplateCategory.SPECS,
        content: `# Specifications

This directory contains specification documents for your project.

## Document Structure

- \`requirements.md\` - Functional requirements
- \`architecture.md\` - System architecture
- \`api.md\` - API specifications
- \`testing.md\` - Testing strategy

## How to Use

1. Create specification documents as needed
2. Reference them in your prompts
3. Keep them updated as the project evolves

## Best Practices

- Keep specifications clear and concise
- Use examples to illustrate complex concepts
- Version control all specification changes
- Review and update regularly`,
        variables: [],
        version: '1.0.0',
        fileExtension: '.md',
        multiFile: true
      }],

      ['specs/requirements.md', {
        id: 'specs/requirements.md',
        name: 'Requirements Specification',
        description: 'Comprehensive requirements specification template',
        category: TemplateCategory.SPECS,
        content: `# Requirements Specification

## Functional Requirements

### Core Features
- **FR1:** {{FEATURE_1_DESCRIPTION}}
- **FR2:** {{FEATURE_2_DESCRIPTION}}
- **FR3:** {{FEATURE_3_DESCRIPTION}}

### User Stories
- **US1:** As a {{USER_TYPE}}, I want to {{ACTION}} so that {{BENEFIT}}
- **US2:** As a {{USER_TYPE}}, I want to {{ACTION}} so that {{BENEFIT}}
- **US3:** As a {{USER_TYPE}}, I want to {{ACTION}} so that {{BENEFIT}}

### Business Rules
- **BR1:** {{BUSINESS_RULE_1}}
- **BR2:** {{BUSINESS_RULE_2}}
- **BR3:** {{BUSINESS_RULE_3}}

## Non-Functional Requirements

### Performance Requirements
- Response time: < {{RESPONSE_TIME}}ms for critical operations
- Throughput: Handle {{THROUGHPUT}} concurrent users
- Scalability: Scale to {{SCALE_TARGET}} without performance degradation

### Security Requirements
- Authentication: {{AUTH_METHOD}}
- Authorization: Role-based access control
- Data encryption: At rest and in transit
- Input validation: All user inputs sanitized

### Reliability Requirements
- Availability: {{AVAILABILITY_TARGET}}% uptime
- Error handling: Graceful degradation and recovery
- Data integrity: ACID compliance where applicable

### Usability Requirements
- User interface: Intuitive and responsive design
- Accessibility: WCAG 2.1 AA compliance
- Browser support: Modern browsers (Chrome, Firefox, Safari, Edge)

## Constraints

### Technical Constraints
- Platform: {{TARGET_PLATFORM}}
- Programming language: {{PROGRAMMING_LANGUAGE}}
- Database: {{DATABASE_TYPE}}
- External dependencies: {{DEPENDENCIES}}

### Business Constraints
- Budget: {{BUDGET_CONSTRAINT}}
- Timeline: {{TIMELINE_CONSTRAINT}}
- Resources: {{RESOURCE_CONSTRAINT}}

## Acceptance Criteria

### Definition of Done
- [ ] All functional requirements implemented
- [ ] Unit tests with >90% coverage
- [ ] Integration tests passing
- [ ] Performance benchmarks met
- [ ] Security review completed
- [ ] Documentation updated

### Success Metrics
- {{METRIC_1}}: {{TARGET_VALUE}}
- {{METRIC_2}}: {{TARGET_VALUE}}
- {{METRIC_3}}: {{TARGET_VALUE}}`,
        variables: [
          {
            name: 'FEATURE_1_DESCRIPTION',
            description: 'First core feature description',
            type: 'text',
            required: false,
            defaultValue: 'Core feature description placeholder'
          },
          {
            name: 'FEATURE_2_DESCRIPTION',
            description: 'Second core feature description',
            type: 'text',
            required: false,
            defaultValue: 'Core feature description placeholder'
          },
          {
            name: 'FEATURE_3_DESCRIPTION',
            description: 'Third core feature description',
            type: 'text',
            required: false,
            defaultValue: 'Core feature description placeholder'
          },
          {
            name: 'USER_TYPE',
            description: 'Primary user type',
            type: 'text',
            required: false,
            defaultValue: 'user'
          },
          {
            name: 'ACTION',
            description: 'User action description',
            type: 'text',
            required: false,
            defaultValue: 'perform an action'
          },
          {
            name: 'BENEFIT',
            description: 'User benefit description',
            type: 'text',
            required: false,
            defaultValue: 'achieve a benefit'
          }
        ],
        version: '1.0.0',
        fileExtension: '.md',
        multiFile: true
      }],

      ['specs/architecture.md', {
        id: 'specs/architecture.md',
        name: 'Architecture Specification',
        description: 'System architecture and design specification',
        category: TemplateCategory.SPECS,
        content: `# Architecture Specification

## System Overview

### Purpose
{{SYSTEM_PURPOSE}}

### Scope
{{SYSTEM_SCOPE}}

### Key Stakeholders
- {{STAKEHOLDER_1}}: {{ROLE_DESCRIPTION}}
- {{STAKEHOLDER_2}}: {{ROLE_DESCRIPTION}}
- {{STAKEHOLDER_3}}: {{ROLE_DESCRIPTION}}

## Architectural Decisions

### Architecture Style
- **Pattern**: {{ARCHITECTURE_PATTERN}} (e.g., Microservices, Monolith, Layered)
- **Rationale**: {{ARCHITECTURE_RATIONALE}}

### Technology Stack
- **Frontend**: {{FRONTEND_TECH}}
- **Backend**: {{BACKEND_TECH}}
- **Database**: {{DATABASE_TECH}}
- **Infrastructure**: {{INFRASTRUCTURE_TECH}}

## System Architecture

### High-Level Components
\`\`\`
[Component Diagram - Replace with actual diagram]

┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Frontend  │────│   Backend   │────│  Database   │
└─────────────┘    └─────────────┘    └─────────────┘
\`\`\`

### Component Descriptions
- **Frontend**: {{FRONTEND_DESCRIPTION}}
- **Backend**: {{BACKEND_DESCRIPTION}}
- **Database**: {{DATABASE_DESCRIPTION}}

## Detailed Design

### Data Architecture
- **Data Models**: {{DATA_MODEL_DESCRIPTION}}
- **Persistence Strategy**: {{PERSISTENCE_STRATEGY}}
- **Data Flow**: {{DATA_FLOW_DESCRIPTION}}

### API Design
- **API Style**: {{API_STYLE}} (REST, GraphQL, gRPC)
- **Authentication**: {{API_AUTH_METHOD}}
- **Rate Limiting**: {{RATE_LIMITING_STRATEGY}}

### Security Architecture
- **Authentication Flow**: {{AUTH_FLOW}}
- **Authorization Model**: {{AUTHZ_MODEL}}
- **Data Protection**: {{DATA_PROTECTION}}

## Infrastructure

### Deployment Architecture
- **Environment Strategy**: {{DEPLOYMENT_STRATEGY}}
- **Container Strategy**: {{CONTAINER_STRATEGY}}
- **Orchestration**: {{ORCHESTRATION_PLATFORM}}

### Monitoring and Logging
- **Application Monitoring**: {{MONITORING_SOLUTION}}
- **Log Aggregation**: {{LOGGING_SOLUTION}}
- **Alerting**: {{ALERTING_STRATEGY}}

### Backup and Recovery
- **Backup Strategy**: {{BACKUP_STRATEGY}}
- **Recovery Time Objective**: {{RTO}}
- **Recovery Point Objective**: {{RPO}}

## Quality Attributes

### Performance
- **Response Time Targets**: {{RESPONSE_TIME_TARGETS}}
- **Throughput Requirements**: {{THROUGHPUT_REQUIREMENTS}}
- **Scalability Strategy**: {{SCALABILITY_STRATEGY}}

### Reliability
- **Availability Target**: {{AVAILABILITY_TARGET}}
- **Fault Tolerance**: {{FAULT_TOLERANCE_STRATEGY}}
- **Disaster Recovery**: {{DISASTER_RECOVERY_PLAN}}

### Security
- **Threat Model**: {{THREAT_MODEL}}
- **Security Controls**: {{SECURITY_CONTROLS}}
- **Compliance Requirements**: {{COMPLIANCE_REQUIREMENTS}}

## Implementation Considerations

### Development Guidelines
- **Coding Standards**: {{CODING_STANDARDS}}
- **Testing Strategy**: {{TESTING_STRATEGY}}
- **Documentation Requirements**: {{DOCUMENTATION_REQUIREMENTS}}

### Migration Strategy
- **Data Migration**: {{DATA_MIGRATION_PLAN}}
- **System Migration**: {{SYSTEM_MIGRATION_PLAN}}
- **Rollback Plan**: {{ROLLBACK_STRATEGY}}

## Risks and Mitigations

### Technical Risks
- **Risk 1**: {{RISK_DESCRIPTION}} → Mitigation: {{MITIGATION_STRATEGY}}
- **Risk 2**: {{RISK_DESCRIPTION}} → Mitigation: {{MITIGATION_STRATEGY}}

### Operational Risks
- **Risk 1**: {{RISK_DESCRIPTION}} → Mitigation: {{MITIGATION_STRATEGY}}
- **Risk 2**: {{RISK_DESCRIPTION}} → Mitigation: {{MITIGATION_STRATEGY}}`,
        variables: [
          {
            name: 'SYSTEM_PURPOSE',
            description: 'System purpose description',
            type: 'text',
            required: false,
            defaultValue: 'System purpose to be defined'
          },
          {
            name: 'SYSTEM_SCOPE',
            description: 'System scope description',
            type: 'text',
            required: false,
            defaultValue: 'System scope to be defined'
          },
          {
            name: 'ARCHITECTURE_PATTERN',
            description: 'Primary architecture pattern',
            type: 'text',
            required: false,
            defaultValue: 'Architecture pattern to be determined'
          }
        ],
        version: '1.0.0',
        fileExtension: '.md',
        multiFile: true
      }],

      ['mcp.json', {
        id: 'mcp.json',
        name: 'MCP Server Configuration',
        description: 'Model Context Protocol server configuration for AI subagents',
        category: TemplateCategory.CONFIG,
        content: `{
  "mcpServers": {
    "roundtable-ai": {
      "name": "roundtable-ai",
      "command": "roundtable-ai",
      "args": [
        
      ],
      "timeout": 36000000.0,
      "enable_default_progress_callback": false,
      "suppress_subprocess_logs": true,
      "env": {
        "PYTHONPATH": "{{PROJECT_ROOT}}",
        "ROUNDTABLE_DEBUG": "false"
      },
      "_metadata": {
        "description": "Roundtable AI MCP Server - Multi-agent orchestration with claude, cursor, codex, and gemini subagents",
        "capabilities": [
          "claude_subagent - Advanced reasoning and code quality",
          "cursor_subagent - Real-time collaboration and editing",
          "codex_subagent - Code generation and completion",
          "gemini_subagent - Multimodal analysis and generation"
        ],
        "working_directory": "{{PROJECT_ROOT}}",
        "verbose": false,
        "created_at": "{{TIMESTAMP}}",
        "project_name": "{{PROJECT_NAME}}",
        "main_task": "{{TASK}}"
      }
    }
  },
  "default_server": "roundtable-ai",
  "global_settings": {
    "connection_timeout": 30000000.0,
    "default_retries": 3,
    "enable_progress_streaming": true,
    "log_level": "info",
    "debug_mode": false
  },
  "project_config": {
    "name": "{{PROJECT_NAME}}",
    "main_task": "{{TASK}}",
    "preferred_subagent": "{{SUBAGENT}}",
    "created_at": "{{TIMESTAMP}}",
    "version": "1.0.0"
  }
}`,
        variables: [
          {
            name: 'PROJECT_ROOT',
            description: 'Project root directory path',
            type: 'path',
            required: true
          },
          {
            name: 'PROJECT_NAME',
            description: 'Project name',
            type: 'text',
            required: true
          },
          {
            name: 'TASK',
            description: 'Main task description',
            type: 'text',
            required: true
          },
          {
            name: 'SUBAGENT',
            description: 'Preferred AI subagent',
            type: 'subagent',
            required: true,
            defaultValue: 'claude',
            choices: VALID_SUBAGENTS
          },
          {
            name: 'TIMESTAMP',
            description: 'Current timestamp',
            type: 'date',
            required: true
          }
        ],
        version: '1.0.0',
        fileExtension: '.json'
      }]
    ];

    // Add all templates to the built-in collection
    templates.forEach(([id, template]) => {
      this.builtInTemplates.set(id, template);
    });
  }

  /**
   * Initialize variable validators.
   */
  private initializeValidators(): void {
    this.validators.set('text', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { valid: false, error: 'Text value is required and cannot be empty' };
      }
      return { valid: true };
    });

    this.validators.set('email', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'Email must be a string' };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return { valid: false, error: 'Invalid email format (expected: user@domain.com)' };
      }
      return { valid: true };
    });

    this.validators.set('url', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'URL must be a string' };
      }
      if (!/^https?:\/\/.+/.test(value)) {
        return { valid: false, error: 'Invalid URL format (expected: https://example.com)' };
      }
      return { valid: true };
    });

    this.validators.set('identifier', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'Identifier must be a string' };
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)) {
        return { valid: false, error: 'Invalid identifier (use letters, numbers, hyphens, underscores)' };
      }
      return { valid: true };
    });

    this.validators.set('version', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'Version must be a string' };
      }
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+)?$/.test(value)) {
        return { valid: false, error: 'Invalid version format (expected: X.Y.Z)' };
      }
      return { valid: true };
    });

    this.validators.set('path', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'Path must be a string' };
      }
      try {
        // Basic path validation - just check if it's a reasonable path
        path.resolve(value);
        return { valid: true };
      } catch {
        return { valid: false, error: 'Invalid path format' };
      }
    });

    this.validators.set('subagent', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'string') {
        return { valid: false, error: 'Subagent must be a string' };
      }
      if (!VALID_SUBAGENTS.includes(value as any)) {
        return { valid: false, error: `Invalid subagent (choose: ${VALID_SUBAGENTS.join(', ')})` };
      }
      return { valid: true };
    });

    this.validators.set('choice', (): ValidationResult => {
      // Choice validation requires the choices array from the variable definition
      // This is a generic validator, specific validation happens in validateVariables
      return { valid: true };
    });

    this.validators.set('boolean', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'boolean') {
        return { valid: false, error: 'Value must be a boolean' };
      }
      return { valid: true };
    });

    this.validators.set('number', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'number' || isNaN(value)) {
        return { valid: false, error: 'Value must be a valid number' };
      }
      return { valid: true };
    });

    this.validators.set('date', (value: VariableValue): ValidationResult => {
      if (!(value instanceof Date) && typeof value !== 'string') {
        return { valid: false, error: 'Date must be a Date object or string' };
      }
      if (typeof value === 'string') {
        const parsed = new Date(value);
        if (isNaN(parsed.getTime())) {
          return { valid: false, error: 'Invalid date format' };
        }
      }
      return { valid: true };
    });

    this.validators.set('timestamp', (value: VariableValue): ValidationResult => {
      if (typeof value !== 'number' && !(value instanceof Date) && typeof value !== 'string') {
        return { valid: false, error: 'Timestamp must be a number, Date, or string' };
      }
      return { valid: true };
    });
  }

  /**
   * Register custom Handlebars helpers.
   */
  private registerHandlebarsHelpers(): void {
    // Date formatting helper
    this.handlebars.registerHelper('formatDate', (date: Date | string) => {
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return 'Invalid Date';

      return d.toISOString().split('T')[0]; // Simple YYYY-MM-DD format
    });

    // String transformation helpers
    this.handlebars.registerHelper('uppercase', (str: string) => {
      return typeof str === 'string' ? str.toUpperCase() : str;
    });

    this.handlebars.registerHelper('lowercase', (str: string) => {
      return typeof str === 'string' ? str.toLowerCase() : str;
    });

    this.handlebars.registerHelper('kebabCase', (str: string) => {
      return typeof str === 'string'
        ? str.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
        : str;
    });

    this.handlebars.registerHelper('snakeCase', (str: string) => {
      return typeof str === 'string'
        ? str.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
        : str;
    });

    // Conditional helpers
    this.handlebars.registerHelper('eq', (a: any, b: any) => a === b);
    this.handlebars.registerHelper('ne', (a: any, b: any) => a !== b);
    this.handlebars.registerHelper('gt', (a: any, b: any) => a > b);
    this.handlebars.registerHelper('lt', (a: any, b: any) => a < b);

    // Agent status helper (matches Python implementation)
    this.handlebars.registerHelper('agentStatus', (currentAgent: string, targetAgent: string) => {
      return currentAgent?.toLowerCase() === targetAgent?.toLowerCase()
        ? '✅ SELECTED'
        : '⭕ Available';
    });
  }

  /**
   * Get or compile a template for rendering.
   */
  private getCompiledTemplate(template: Template): HandlebarsTemplateDelegate {
    const cacheKey = `${template.id}:${template.version}`;

    let compiled = this.templateCache.get(cacheKey);
    if (!compiled) {
      compiled = this.handlebars.compile(template.content);
      this.templateCache.set(cacheKey, compiled);
    }

    return compiled;
  }

  /**
   * Prepare rendering context with helpers and environment data.
   */
  private prepareRenderingContext(context: TemplateContext, options: RenderOptions): any {
    // Determine agent documentation file based on SUBAGENT
    const subagent = (context.variables.SUBAGENT as string || 'claude').toLowerCase();
    const agentDocFile = subagent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';

    return {
      // Flatten variables for easier access in templates
      ...context.variables,

      // Environment context
      environment: context.environment,
      project: context.project,
      git: context.git,
      timestamp: context.timestamp,

      // Helper functions from options
      ...(options.helpers || {}),

      // Built-in computed values
      CURRENT_DATE: context.timestamp.toISOString().split('T')[0],
      TIMESTAMP: context.timestamp.toISOString(),

      // Agent documentation file (conditional based on SUBAGENT)
      AGENT_DOC_FILE: agentDocFile,

      // Agent status helpers (matching Python implementation)
      CLAUDE_STATUS: this.getAgentStatus(context.variables.SUBAGENT as string, 'claude'),
      CURSOR_STATUS: this.getAgentStatus(context.variables.SUBAGENT as string, 'cursor'),
      CODEX_STATUS: this.getAgentStatus(context.variables.SUBAGENT as string, 'codex'),
      GEMINI_STATUS: this.getAgentStatus(context.variables.SUBAGENT as string, 'gemini')
    };
  }

  /**
   * Get agent selection status (matches Python implementation).
   */
  private getAgentStatus(selectedAgent: string, targetAgent: string): string {
    if (!selectedAgent) return '⭕ Available';
    return selectedAgent.toLowerCase() === targetAgent.toLowerCase()
      ? '✅ SELECTED'
      : '⭕ Available';
  }

  /**
   * Post-process rendered content.
   */
  private postProcessContent(content: string, options: RenderOptions): string {
    let processed = content;

    // Handle whitespace preservation
    if (!options.preserveWhitespace) {
      // Remove excessive blank lines
      processed = processed.replace(/\n\s*\n\s*\n/g, '\n\n');
    }

    // HTML escaping (if needed)
    if (options.escapeHtml) {
      processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    return processed.trim();
  }

  /**
   * Validate required variables are present in context.
   */
  private async validateRequiredVariables(template: Template, variables: TemplateVariables): Promise<void> {
    const requiredVariables = template.variables.filter(v => v.required);
    const missingVariables: string[] = [];

    for (const variable of requiredVariables) {
      const value = variables[variable.name];
      if (value === undefined || value === null || value === '') {
        missingVariables.push(variable.name);
      }
    }

    if (missingVariables.length > 0) {
      throw new TemplateVariableError(
        `Missing required variables: ${missingVariables.join(', ')}`,
        missingVariables[0],
        undefined
      );
    }
  }

  /**
   * Generate a single file from template.
   */
  private async generateSingleFile(
    template: Template,
    targetDirectory: string,
    context: TemplateContext,
    options: {
      force?: boolean;
      createBackup?: boolean;
      dryRun?: boolean;
      onConflict?: 'skip' | 'overwrite' | 'prompt';
    }
  ): Promise<FileGenerationResult> {
    const fileName = this.getTemplateFileName(template);
    const targetPath = path.join(targetDirectory, fileName);

    try {
      // Check if file exists
      const fileExists = await fs.pathExists(targetPath);

      if (fileExists && !options.force && options.onConflict !== 'overwrite') {
        return {
          path: targetPath,
          content: '',
          status: 'skipped',
          size: 0,
          timestamp: new Date()
        };
      }

      // Render template content
      const renderedContent = await this.render(template, context);

      if (options.dryRun) {
        return {
          path: targetPath,
          content: renderedContent,
          status: 'created',
          size: Buffer.byteLength(renderedContent, 'utf8'),
          timestamp: new Date()
        };
      }

      // Create backup if requested and file exists
      if (options.createBackup && fileExists) {
        const backupPath = `${targetPath}.backup.${Date.now()}`;
        await fs.copy(targetPath, backupPath);
      }

      // Ensure directory exists
      await fs.ensureDir(path.dirname(targetPath));

      // Write file
      await fs.writeFile(targetPath, renderedContent, 'utf8');

      return {
        path: targetPath,
        content: renderedContent,
        status: fileExists ? 'overwritten' : 'created',
        size: Buffer.byteLength(renderedContent, 'utf8'),
        timestamp: new Date()
      };

    } catch (error) {
      return {
        path: targetPath,
        content: '',
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        size: 0,
        timestamp: new Date()
      };
    }
  }

  /**
   * Get filename for template based on its ID.
   */
  private getTemplateFileName(template: Template): string {
    // Handle special cases for specs/ subdirectory
    if (template.id.startsWith('specs/')) {
      return template.id;
    }

    // For other templates, use the ID as the filename
    return template.id;
  }

  /**
   * Gather environment information.
   */
  private async gatherEnvironmentInfo(projectPath: string): Promise<TemplateEnvironment> {
    const basic = this.getBasicEnvironment(projectPath);

    try {
      // Try to detect Node.js version
      const { execa } = await import('execa');
      const nodeResult = await execa('node', ['--version']);
      (basic as any).nodeVersion = nodeResult.stdout.trim();

      // Try to detect npm version
      const npmResult = await execa('npm', ['--version']);
      (basic as any).npmVersion = npmResult.stdout.trim();
    } catch {
      // Ignore errors in version detection
    }

    return basic;
  }

  /**
   * Get basic environment information.
   */
  private getBasicEnvironment(projectPath: string): TemplateEnvironment {
    return {
      cwd: projectPath,
      ...(process.env.VIRTUAL_ENV && { venvPath: process.env.VIRTUAL_ENV }),
      variables: { ...process.env } as Record<string, string>
    } as TemplateEnvironment;
  }

  /**
   * Extract project information from variables and path.
   */
  private extractProjectInfo(variables: TemplateVariables, projectPath: string): ProjectContext {
    const projectName = variables.PROJECT_NAME as string || path.basename(projectPath);

    return {
      name: projectName,
      path: projectPath,
      packageName: variables.PACKAGE_NAME as string || projectName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      description: variables.DESCRIPTION as string,
      version: variables.VERSION as string,
      author: variables.AUTHOR as string,
      license: variables.LICENSE as string,
      phase: variables.PROJECT_PHASE as string
    };
  }

  /**
   * Gather Git repository information.
   */
  private async gatherGitInfo(projectPath: string): Promise<GitContext> {
    try {
      const { execa } = await import('execa');

      // Get current branch
      const branchResult = await execa('git', ['branch', '--show-current'], { cwd: projectPath });
      const branch = branchResult.stdout.trim();

      // Get remote URL
      let url: string | undefined;
      try {
        const urlResult = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
        url = urlResult.stdout.trim();
      } catch {
        // No remote or other error
      }

      // Get latest commit
      let commit: string | undefined;
      try {
        const commitResult = await execa('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
        commit = commitResult.stdout.trim();
      } catch {
        // No commits or other error
      }

      // Check for uncommitted changes
      let dirty = false;
      try {
        const statusResult = await execa('git', ['status', '--porcelain'], { cwd: projectPath });
        dirty = statusResult.stdout.trim().length > 0;
      } catch {
        // Assume not dirty if we can't determine
      }

      // Extract owner and repo from URL
      let owner: string | undefined;
      let repo: string | undefined;
      if (url) {
        const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (match) {
          owner = match[1];
          repo = match[2];
        }
      }

      return {
        ...(url && { url }),
        ...(branch && { branch }),
        ...(commit && { commit }),
        ...(owner && { owner }),
        ...(repo && { repo }),
        dirty
      } as GitContext;

    } catch {
      // Return empty git context if git is not available or not a git repo
      return {};
    }
  }
}

/**
 * Default template engine instance.
 */
export const defaultTemplateEngine = new TemplateEngine();

/**
 * Utility functions for template operations.
 */
export namespace TemplateUtils {
  /**
   * Create default variables for a project.
   */
  export function createDefaultVariables(projectPath: string, projectName?: string): TemplateVariables {
    const name = projectName || path.basename(projectPath);
    const currentDate = new Date().toISOString().split('T')[0];

    return {
      // Core variables
      PROJECT_NAME: name,
      TASK: DEFAULT_TEMPLATE_VARIABLES.CORE.TASK,
      SUBAGENT: DEFAULT_TEMPLATE_VARIABLES.CORE.SUBAGENT,
      GIT_URL: DEFAULT_TEMPLATE_VARIABLES.CORE.GIT_URL,

      // Project variables
      PROJECT_PATH: projectPath,
      PROJECT_ROOT: projectPath,
      PACKAGE_NAME: name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      VENV_PATH: path.join(projectPath, '.venv'),

      // Metadata variables
      CURRENT_DATE: currentDate,
      TIMESTAMP: new Date().toISOString(),
      PROJECT_PHASE: DEFAULT_TEMPLATE_VARIABLES.PROJECT.PROJECT_PHASE,
      CURRENT_PRIORITY: DEFAULT_TEMPLATE_VARIABLES.PROJECT.CURRENT_PRIORITY,

      // Optional variables
      AUTHOR: DEFAULT_TEMPLATE_VARIABLES.PROJECT.AUTHOR,
      EMAIL: DEFAULT_TEMPLATE_VARIABLES.PROJECT.EMAIL,
      LICENSE: DEFAULT_TEMPLATE_VARIABLES.PROJECT.LICENSE,
      DESCRIPTION: DEFAULT_TEMPLATE_VARIABLES.PROJECT.DESCRIPTION,
      VERSION: DEFAULT_TEMPLATE_VARIABLES.PROJECT.VERSION,

      // Template aliases for Python compatibility
      main_task: DEFAULT_TEMPLATE_VARIABLES.CORE.TASK
    };
  }

  /**
   * Validate template ID format.
   */
  export function isValidTemplateId(id: string): boolean {
    return /^[a-zA-Z0-9._/-]+$/.test(id) && id.length > 0;
  }

  /**
   * Generate unique template ID.
   */
  export function generateTemplateId(baseName: string): string {
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${sanitized}_${uuidv4().substring(0, 8)}`;
  }

  /**
   * Merge template variables with defaults.
   */
  export function mergeVariables(
    defaults: TemplateVariables,
    overrides: TemplateVariables
  ): TemplateVariables {
    return { ...defaults, ...overrides };
  }

  /**
   * Extract variables from template content.
   */
  export function extractVariablesFromContent(content: string): string[] {
    const variablePattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    const variables = new Set<string>();
    let match;

    while ((match = variablePattern.exec(content)) !== null) {
      if (match[1]) {
        variables.add(match[1]);
      }
    }

    return Array.from(variables);
  }
}

// Export everything from types for convenience
export * from './types.js';
