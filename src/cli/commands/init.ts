/**
 * Simplified Init command implementation for juno-task-ts CLI
 *
 * Minimal flow: Project Root → Main Task → Editor Selection → Git Setup → Save
 * Removes all complex features: token counting, cost calculation, character limits, etc.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import { promptMultiline, promptInputOnce } from '../utils/multiline.js';

import { loadConfig } from '../../core/config.js';
import type { InitCommandOptions } from '../types.js';
import { ValidationError } from '../types.js';
import type { TemplateVariables } from '../../templates/types.js';

interface InitializationContext {
  targetDirectory: string;
  task: string;
  subagent: string;
  gitUrl?: string;
  variables: TemplateVariables;
  force: boolean;
  interactive: boolean;
}

/**
 * Simplified Interactive TUI for project initialization
 * Minimal flow as requested by user:
 * Project Root → Main Task [Multi line] → select menu [Coding Editors] → Git Setup? yes | No → Save → Already exists? Override | Cancel → Done
 */
class SimpleInitTUI {
  private context: Partial<InitializationContext> = {};

  // Simple single-line input helper is provided by utils

  /**
   * Simplified gather method implementing the minimal flow
   */
  async gather(): Promise<InitializationContext> {
    console.log(chalk.blue.bold('\n🚀 Juno Task Project Initialization\n'));

    // 1. Project Root
    console.log(chalk.yellow('📁 Step 1: Project Directory'));
    const targetDirectory = await this.promptForDirectory();

    // 2. Main Task (multi-line, NO character limits)
    console.log(chalk.yellow('\n📝 Step 2: Main Task'));
    const task = await this.promptForTask();

    // 3. Editor Selection (simplified menu)
    console.log(chalk.yellow('\n👨‍💻 Step 3: Select Coding Editor'));
    const editor = await this.promptForEditor();

    // 4. Git Setup (simple yes/no)
    console.log(chalk.yellow('\n🔗 Step 4: Git Setup'));
    const gitUrl = await this.promptForGitSetup();

    // 5. Save confirmation (handle existing files)
    console.log(chalk.yellow('\n💾 Step 5: Save Project'));
    await this.confirmSave(targetDirectory);

    // Create simple variables (no complex template system)
    const variables = this.createSimpleVariables(targetDirectory, task, editor, gitUrl);

    console.log(chalk.green('\n✅ Setup complete! Creating project...\n'));

    return {
      targetDirectory,
      task,
      subagent: editor, // Use selected editor as subagent
      gitUrl,
      variables,
      force: false,
      interactive: true
    };
  }

  private async promptForDirectory(): Promise<string> {
    console.log(chalk.gray('   Enter the target directory for your project'));
    const answer = await promptInputOnce('Directory path', process.cwd());
    return path.resolve(answer || process.cwd());
  }

  private async promptForTask(): Promise<string> {
    const input = await promptMultiline({
      label: 'Describe what you want to build',
      hint: 'Finish with double Enter. Blank lines are kept.',
      prompt: '  ',
      minLength: 5,
    });

    if (!input || input.replace(/\s+/g, '').length < 5) {
      throw new ValidationError(
        'Task description must be at least 5 characters',
        ['Provide a basic description of what you want to build']
      );
    }

    return input;
  }

  private async promptForEditor(): Promise<string> {
    console.log(chalk.gray('   Select your preferred AI subagent (enter number):'));
    console.log(chalk.gray('   1) Claude'));
    console.log(chalk.gray('   2) Codex'));
    console.log(chalk.gray('   3) Gemini'));
    console.log(chalk.gray('   4) Cursor'));

    const answer = await promptInputOnce('Subagent choice', '1');
    const choice = parseInt(answer) || 1;

    switch (choice) {
      case 1: return 'claude';
      case 2: return 'codex';
      case 3: return 'gemini';
      case 4: return 'cursor';
      default: return 'claude';
    }
  }

  private async promptForGitSetup(): Promise<string | undefined> {
    console.log(chalk.gray('   Would you like to set up Git? (y/n):'));
    const answer = (await promptInputOnce('Git setup', 'y')).toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      console.log(chalk.gray('   Enter Git repository URL (optional):'));
      const gitUrl = await promptInputOnce('Git URL', '');

      if (gitUrl && gitUrl.trim()) {
        return gitUrl.trim();
      }
    }

    return undefined;
  }

  private async confirmSave(targetDirectory: string): Promise<void> {
    // Check if .juno_task already exists
    const junoTaskPath = path.join(targetDirectory, '.juno_task');

    if (await fs.pathExists(junoTaskPath)) {
      console.log(chalk.yellow('   ⚠️  .juno_task directory already exists'));
      console.log(chalk.gray('   Would you like to:'));
      console.log(chalk.gray('   1) Override existing files'));
      console.log(chalk.gray('   2) Cancel'));

      const answer = await promptInputOnce('Choice', '2');
      const choice = parseInt(answer) || 2;

      if (choice !== 1) {
        console.log(chalk.blue('\n❌ Initialization cancelled'));
        process.exit(0);
      }
    }
  }

  /**
   * Simplified variable creation - no complex template system
   */
  private createSimpleVariables(
    targetDirectory: string,
    task: string,
    editor: string,
    gitUrl?: string
  ): TemplateVariables {
    const projectName = path.basename(targetDirectory);
    const currentDate = new Date().toISOString().split('T')[0];
    let AGENTMD = 'AGENTS.md';
    if (editor == 'claude'){
      AGENTMD = 'CLAUDE.md';
    }

    return {
      // Core variables only
      PROJECT_NAME: projectName,
      TASK: task,
      EDITOR: editor,
      AGENTMD:AGENTMD,
      CURRENT_DATE: currentDate,

      // Simple defaults
      VERSION: '1.0.0',
      AUTHOR: 'Development Team',
      DESCRIPTION: task.substring(0, 200) + (task.length > 200 ? '...' : ''),
      GIT_URL: gitUrl || ''
    };
  }
}

/**
 * Simplified Project Generator - basic file creation only
 */
class SimpleProjectGenerator {
  constructor(private context: InitializationContext) {}

  async generate(): Promise<void> {
    const { targetDirectory, variables, force } = this.context;

    console.log(chalk.blue('📁 Creating project directory...'));

    // Ensure target directory exists
    await fs.ensureDir(targetDirectory);

    // Check if .juno_task already exists (unless force flag is set)
    const junoTaskDir = path.join(targetDirectory, '.juno_task');
    const junoTaskExists = await fs.pathExists(junoTaskDir);

    if (junoTaskExists && !force) {
      throw new ValidationError(
        'Project already initialized. Directory .juno_task already exists.',
        ['Use --force flag to overwrite existing files', 'Choose a different directory']
      );
    }

    // Create .juno_task directory
    await fs.ensureDir(junoTaskDir);

    // Create config.json with user's subagent choice and other settings
    console.log(chalk.blue('⚙️ Creating project configuration...'));
    await this.createConfigFile(junoTaskDir, targetDirectory);

    // Create mcp.json with MCP server configuration
    console.log(chalk.blue('🔧 Setting up MCP configuration...'));
    await this.createMcpFile(junoTaskDir, targetDirectory);

    console.log(chalk.blue('📄 Creating production-ready project files...'));

    // Create comprehensive prompt.md with production template
    const promptContent = `0a. study @.juno_task/specs/* to learn about the specifications
0b. **ALWAYS check @.juno_task/USER_FEEDBACK.md first** - read user feedback, integrate it into the plan, update status of feedback items, and remove completed/resolved items. This is the primary mechanism for user input.


0c. study @.juno_task/plan.md.


0d. Based on USER FEEDBACK reflect on @.juno_task/plan.md and keep it up-to-date.
0g. User Feedback has higher priority that test results. maybe the test results hasn't follow the use cases. IT is very important to focus on it.

0f. After reviwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the feedback/plan or Claude.md as resolved. You should update it to reflect that the issue is not resolved.
it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows 1.the issue is still open,2. past approaches to resolve it, what it was, and know that it has failed.

0h. Assign a subagent to do steps of 0b to 0f and when it is done. And the files has reflected the reality.
then do 0b, 0c youself (So your actual planning and thinking would be based on latest state of those KEY files.) and continue with the task.

0f. The source code of the project is in ${targetDirectory}

1. Your task is to ${variables.TASK}

Test the implementation under the virtual environment: ${targetDirectory}
virtual environment not necessarly has been created.!

Using parallel subagents. Follow the @.juno_task/plan.md and choose the most important 1 things. Before making changes search codebase (don't assume not implemented) using subagents. You may use up to 500 parallel subagents for all operations but only 1 subagent for build/tests.

Explicitly inform build/tests subagent to activate virtual environment at: ${targetDirectory}

2. After implementing functionality or resolving problems, run the tests for that unit of code that was improved. If functionality is missing then it's your job to add it as per the application specifications. Think hard.

2. When you discover a syntax, logic, UI, User Flow Error or bug. Immediately update @.juno_task/plan.md with your findings using a ${variables.EDITOR} subagent. When the issue is resolved, update @.juno_task/plan.md and remove the item using a ${variables.EDITOR} subagent.

3. When the tests pass update the @.juno_task/plan.md, then add changed code and @.juno_task/plan.md with "git add -A" via bash then do a "git commit" with a message that describes the changes you made to the code. After the commit do a "git push" to push the changes to the remote repository.

999. Important: When authoring documentation capture the why tests and the backing implementation is important.

9999. Important: We want single sources of truth, no migrations/adapters. If tests unrelated to your work fail then it's your job to resolve these tests as part of the increment of change.

999999. As soon as there are no build or test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 for example 0.0.1 if 0.0.0 does not exist.

999999999. You may add extra logging if required to be able to debug the issues.

9999999999. ALWAYS KEEP @.juno_task/plan.md up to date with your learnings using a ${variables.EDITOR} subagent. Especially after wrapping up/finishing your turn.

99999999999. **CRITICAL**: At start of each iteration, read @.juno_task/USER_FEEDBACK.md and integrate feedback into @.juno_task/plan.md. Update feedback status and remove resolved items from @.juno_task/USER_FEEDBACK.md using a ${variables.EDITOR} subagent.

99999999999. When you learn something new about how to run the app or examples make sure you update @${variables.AGENTMD} using a ${variables.EDITOR} subagent but keep it brief. For example if you run commands multiple times before learning the correct command then that file should be updated.

999999999999. IMPORTANT when you discover a bug resolve it using ${variables.EDITOR} subagents even if it is unrelated to the current piece of work after documenting it in @.juno_task/plan.md

9999999999999999999. Keep @${variables.AGENTMD} up to date with information on how to build the app and your learnings to optimize the build/test loop using a ${variables.EDITOR} subagent.

999999999999999999999. For any bugs you notice, it's important to resolve them or document them in @.juno_task/plan.md to be resolved using a ${variables.EDITOR} subagent.

99999999999999999999999. When authoring the missing features you may author multiple standard libraries at once using up to 1000 parallel subagents

99999999999999999999999999. When @.juno_task/plan.md becomes large periodically clean out the items that are completed from the file using a ${variables.EDITOR} subagent.

99999999999999999999999999. If you find inconsistencies in the specs/* then use the oracle and then update the specs. Specifically around types and lexical tokens.

9999999999999999999999999999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. WE WANT FULL IMPLEMENTATIONS. DO IT OR I WILL YELL AT YOU

9999999999999999999999999999999. SUPER IMPORTANT DO NOT IGNORE. DO NOT PLACE STATUS REPORT UPDATES INTO @${variables.AGENTMD}

99999999999999999999999999999999. After reveiwing Feedback, if you find an open issue, you need to update previously handled issues status as well. If user reporting a bug, that earlier on reported on the feedback/plan or @${variables.AGENTMD} as resolved. You should update it to reflect that the issue is not resolved.
it would be ok to include past reasoning and root causing to the open issue, You should mention. <PREVIOUS_AGENT_ATTEMP> Tag and describe the approach already taken, so the agent knows 1.the issue is still open,2. past approaches to resolve it, what it was, and know that it has failed.
Plan , USER_FEEDBACK and @${variables.AGENTMD} should repesent truth. User Open Issue is a high level of truth. so you need to reflect it on the files.
`;

    await fs.writeFile(path.join(junoTaskDir, 'prompt.md'), promptContent);

    // Create comprehensive init.md with production template
    const initContent = `# Main Task
${variables.TASK}

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
Consider missing steps and plan. If the step is missing then author the specification at @.juno_task/spec/FILENAME.md (do NOT assume that it does not exist, search before creating). The naming of the module should be GenZ named and not conflict with another module name. If you create a new step then document the plan to implement in @.juno_task/plan.md

### Constraints
**Preferred Subagent**: ${variables.EDITOR}
**Repository URL**: ${variables.GIT_URL || 'Not specified'}

## Environment Setup
[Empty]

### 2. Package Installation
[Empty]

### 3. Test Installation
[Empty]
`;

    await fs.writeFile(path.join(junoTaskDir, 'init.md'), initContent);

    // Create USER_FEEDBACK.md
    const userFeedbackContent = `## OPEN ISSUES
<OPEN_ISSUES>
<ISSUE>
</ISSUE>
...
</OPEN_ISSUES>




## Past Issues
Agent Response to previously reported issues.
(There could be mistakes in the agent response, agent could report an issue resolved while the error hasn't been resolved, Look at them, as a source of understanding agent thinking, and files that it touched. Not as a source of truth.)


<REPORTED_ISSUES>
<ISSUE_RESPONSE>
</ISSUE_RESPONSE>
...
</REPORTED_ISSUES>

`;

    await fs.writeFile(path.join(junoTaskDir, 'USER_FEEDBACK.md'), userFeedbackContent);

    // Create plan.md
    const planContent = `# Juno-Task Implementation Plan

## 🎯 CURRENT PRIORITIES

### 1. Study Existing Project
Analyze current codebase and identify what needs to be implemented for the main task.

### 2. Create Specifications
Create detailed specifications for each component needed to achieve the main task.

## 📋 TASK BREAKDOWN

Items will be added here as we discover what needs to be implemented.

## ✅ COMPLETED

- Project initialization complete
- Basic file structure created
- Task defined: ${variables.TASK}
`;

    await fs.writeFile(path.join(junoTaskDir, 'plan.md'), planContent);

    // Create specs directory and files
    const specsDir = path.join(junoTaskDir, 'specs');
    await fs.ensureDir(specsDir);

    // Create specs/README.md
    const specsReadmeContent = `# Project Specifications

This directory contains detailed specifications for the project components.

## Specification Files

- \`requirements.md\` - Functional and non-functional requirements
- \`architecture.md\` - System architecture and design decisions
- Additional spec files will be added as needed

## File Naming Convention

- Use GenZ-style naming (descriptive, modern)
- Avoid conflicts with existing file names
- Use \`.md\` extension for all specification files
`;

    await fs.writeFile(path.join(specsDir, 'README.md'), specsReadmeContent);

    // Create specs/requirements.md
    const requirementsContent = `# Requirements Specification

## Functional Requirements

### Core Features
- **FR1**: ${variables.TASK}
- **FR2**: Automated testing and validation
- **FR3**: Git integration and version control

### User Stories
- **US1**: As a developer, I want to have clear task instructions so that I can implement the solution effectively
- **US2**: As a developer, I want to have automated workflows so that I can focus on implementation
- **US3**: As a developer, I want to have proper documentation so that others can understand the project

## Non-Functional Requirements

### Performance Requirements
- Response time: Fast execution for AI subagent interactions
- Throughput: Handle multiple parallel subagent operations
- Scalability: Scale to handle complex tasks with multiple components

### Quality Requirements
- Code quality: Clean, maintainable, and well-documented code
- Testing: Comprehensive test coverage for all implemented features
- Documentation: Clear documentation for all components and workflows

## Constraints

### Technical Constraints
- Platform: Node.js/TypeScript environment
- AI Subagents: Use ${variables.EDITOR} as primary subagent
- Version Control: Git-based workflow with automated commits

## Acceptance Criteria

### Definition of Done
- [ ] All functional requirements implemented
- [ ] Tests passing for all implemented features
- [ ] Documentation updated
- [ ] Code review completed

### Success Metrics
- Task completion: Main task successfully implemented
- Code quality: Clean, maintainable codebase
- Documentation: Complete and accurate documentation
`;

    await fs.writeFile(path.join(specsDir, 'requirements.md'), requirementsContent);

    // Create specs/architecture.md
    const architectureContent = `# Architecture Specification

## System Overview

This project uses AI-assisted development with juno-task to achieve: ${variables.TASK}

## Architectural Decisions

### 1. AI-First Development
- Use ${variables.EDITOR} as primary AI subagent
- Parallel subagent processing for complex tasks
- Automated workflow orchestration

### 2. Template-Driven Development
- Production-ready templates for project initialization
- Comprehensive prompt templates for AI guidance
- Structured specification templates

### 3. Git-Integrated Workflow
- Automated commit generation
- Tag-based version management
- Branch management for features

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js
- **CLI**: juno-task with AI subagent integration
- **Version Control**: Git
- **Documentation**: Markdown-based

## Component Architecture

### Core Components
1. **Task Management**: Task definition and execution tracking
2. **Specification Management**: Requirements and architecture documentation
3. **AI Integration**: Subagent orchestration and communication
4. **Version Control**: Automated Git workflow management

### Data Flow
1. Task definition → AI processing → Implementation
2. Specifications → Development → Testing → Documentation
3. Continuous feedback loop through USER_FEEDBACK.md

## Quality Attributes

### Performance
- Fast AI subagent response times
- Efficient parallel processing
- Minimal overhead for workflow automation

### Maintainability
- Clear separation of concerns
- Comprehensive documentation
- Standardized templates and workflows

### Scalability
- Support for complex multi-component projects
- Flexible AI subagent configuration
- Extensible template system

## Implementation Guidelines

### Code Organization
- Follow TypeScript best practices
- Use meaningful naming conventions
- Implement proper error handling
- Maintain comprehensive test coverage

### Documentation Standards
- Keep specifications up to date
- Document architectural decisions
- Provide clear usage examples
- Maintain change logs

### Quality Assurance
- Automated testing for all components
- Code review process
- Performance monitoring
- Security best practices
`;

    await fs.writeFile(path.join(specsDir, 'architecture.md'), architectureContent);

    // Create CLAUDE.md in project root
    const claudeContent = `# Claude Development Session Learnings

## Project Overview

This project was initialized on ${variables.CURRENT_DATE} using juno-task.

**Main Task**: ${variables.TASK}
**Preferred Subagent**: ${variables.EDITOR}
**Project Root**: ${targetDirectory}

## Development Environment

### Build System
- Use \`npm run build\` to build the project
- Test with \`npm test\` for unit tests
- Use \`npm run test:binary\` for CLI testing

### Key Commands
- \`juno-task start\` - Begin task execution
- \`juno-task -s ${variables.EDITOR}\` - Quick execution with preferred subagent
- \`juno-task feedback\` - Provide feedback on the process

## Project Structure

\`\`\`
.
├── .juno_task/
│   ├── prompt.md          # Main task definition with AI instructions
│   ├── init.md            # Initial task breakdown and constraints
│   ├── plan.md            # Dynamic planning and priority tracking
│   ├── USER_FEEDBACK.md   # User feedback and issue tracking
│   ├── scripts/           # Utility scripts for project maintenance
│   │   └── clean_logs_folder.sh  # Archive old log files
│   └── specs/             # Project specifications
│       ├── README.md      # Specs overview
│       ├── requirements.md # Functional requirements
│       └── architecture.md # System architecture
├── CLAUDE.md              # This file - session documentation
└── README.md              # Project overview
\`\`\`

## AI Workflow

The project uses a sophisticated AI workflow with:

1. **Task Analysis**: Study existing codebase and requirements
2. **Specification Creation**: Detailed specs for each component
3. **Implementation**: AI-assisted development with parallel subagents
4. **Testing**: Automated testing and validation
5. **Documentation**: Continuous documentation updates
6. **Version Control**: Automated Git workflow management

## Important Notes

- Always check USER_FEEDBACK.md first for user input
- Keep plan.md up to date with current priorities
- Use up to 500 parallel subagents for analysis
- Use only 1 subagent for build/test operations
- Focus on full implementations, not placeholders
- Maintain comprehensive documentation

## Session Progress

This file will be updated as development progresses to track:
- Key decisions and their rationale
- Important learnings and discoveries
- Build/test optimization techniques
- Solutions to complex problems
- Performance improvements and optimizations
`;

    await fs.writeFile(path.join(targetDirectory, 'CLAUDE.md'), claudeContent);

    // Create AGENTS.md in project root
    const agentsContent = `# AI Agent Selection and Performance

## Available Agents

### ${variables.EDITOR.toUpperCase()} ✅ SELECTED
**Status**: Primary agent for this project
**Usage**: Main development and task execution
**Strengths**: ${this.getAgentStrengths(variables.EDITOR)}
**Best For**: ${this.getAgentBestFor(variables.EDITOR)}

### CLAUDE ⭕ Available
**Status**: Available as secondary agent
**Usage**: Complex reasoning, analysis, documentation
**Strengths**: Analytical thinking, detailed explanations
**Best For**: Code analysis, architectural decisions, documentation

### CURSOR ⭕ Available
**Status**: Available as secondary agent
**Usage**: Code generation, debugging, optimization
**Strengths**: Code-centric development, debugging
**Best For**: Feature implementation, bug fixes, code optimization

### CODEX ⭕ Available
**Status**: Available as secondary agent
**Usage**: General development, problem solving
**Strengths**: Versatile development capabilities
**Best For**: General purpose development tasks

### GEMINI ⭕ Available
**Status**: Available as secondary agent
**Usage**: Creative solutions, alternative approaches
**Strengths**: Creative problem solving, diverse perspectives
**Best For**: Brainstorming, alternative implementations, creative solutions

## Agent Selection Strategy

### Primary Agent Selection
- **${variables.EDITOR}** chosen as primary agent for this project
- Based on task requirements and project needs
- Can be changed by updating project configuration

### Secondary Agent Usage
- Use parallel agents for analysis and research
- Specialized agents for specific task types
- Load balancing for complex operations

## Performance Tracking

Track agent performance for:
- Task completion time
- Code quality
- Accuracy of implementation
- Documentation quality
- Problem-solving effectiveness

## Optimization Tips

1. **Right Agent for Right Task**: Choose agents based on their strengths
2. **Parallel Processing**: Use multiple agents for analysis phases
3. **Quality Validation**: Review and validate agent output
4. **Feedback Loop**: Provide feedback to improve agent performance
5. **Performance Monitoring**: Track and optimize agent usage
`;

    await fs.writeFile(path.join(targetDirectory, 'AGENTS.md'), agentsContent);

    // Create enhanced README.md in root
    const readmeContent = `# ${variables.PROJECT_NAME}

${variables.DESCRIPTION}

## Overview

This project uses juno-task for AI-powered development with ${variables.EDITOR} as the primary AI subagent.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- juno-task CLI installed
- Git for version control

### Quick Start

\`\`\`bash
# Start task execution with production-ready AI instructions
juno-task start

# Or use main command with preferred subagent
juno-task -s ${variables.EDITOR}

# Provide feedback on the development process
juno-task feedback
\`\`\`

## Project Structure

\`\`\`
.
├── .juno_task/
│   ├── prompt.md          # Production-ready AI instructions
│   ├── init.md            # Task breakdown and constraints
│   ├── plan.md            # Dynamic planning and tracking
│   ├── USER_FEEDBACK.md   # User feedback and issue tracking
│   ├── scripts/           # Utility scripts for project maintenance
│   │   └── clean_logs_folder.sh  # Archive old log files (3+ days)
│   └── specs/             # Comprehensive specifications
│       ├── README.md      # Specs overview and guide
│       ├── requirements.md # Detailed functional requirements
│       └── architecture.md # System architecture and design
├── CLAUDE.md              # Session documentation and learnings
├── AGENTS.md              # AI agent selection and performance tracking
└── README.md              # This file
\`\`\`

## AI-Powered Development

This project implements a sophisticated AI development workflow:

1. **Task Analysis**: AI studies existing codebase and requirements
2. **Specification Creation**: Detailed specs with parallel subagents
3. **Implementation**: AI-assisted development (up to 500 parallel agents)
4. **Testing**: Automated testing with dedicated subagents
5. **Documentation**: Continuous documentation updates
6. **Version Control**: Automated Git workflow with smart commits

## Key Features

- **Production-Ready Templates**: Comprehensive templates for AI guidance
- **Parallel Processing**: Up to 500 parallel subagents for analysis
- **Automated Workflows**: Git integration, tagging, and documentation
- **Quality Enforcement**: Strict requirements against placeholder implementations
- **User Feedback Integration**: Continuous feedback loop via USER_FEEDBACK.md
- **Session Management**: Detailed tracking of development sessions

## Configuration

The project uses \`${variables.EDITOR}\` as the primary AI subagent with these settings:
- **Parallel Agents**: Up to 500 for analysis, 1 for build/test
- **Quality Standards**: Full implementations required
- **Documentation**: Comprehensive and up-to-date
- **Version Control**: Automated Git workflow

${variables.GIT_URL ? `\n## Repository\n${variables.GIT_URL}` : ''}

## Development Workflow

1. **Review Task**: Check \`.juno_task/init.md\` for main task
2. **Check Plan**: Review \`.juno_task/plan.md\` for current priorities
3. **Provide Feedback**: Use \`juno-task feedback\` for issues or suggestions
4. **Track Progress**: Monitor AI development through \`.juno_task/prompt.md\`

---

Created with juno-task on ${variables.CURRENT_DATE}
${variables.EDITOR ? `using ${variables.EDITOR} as primary AI subagent` : ''}
`;

    await fs.writeFile(path.join(targetDirectory, 'README.md'), readmeContent);

    // Copy utility scripts from templates to .juno_task/scripts/
    console.log(chalk.blue('📦 Installing utility scripts...'));
    await this.copyScriptsFromTemplates(junoTaskDir);

    // Execute install_requirements.sh to install Python dependencies
    console.log(chalk.blue('🐍 Installing Python requirements...'));
    await this.executeInstallRequirements(junoTaskDir);

    // Set up Git repository if Git URL is provided
    await this.setupGitRepository();

    console.log(chalk.green.bold('\n✅ Project initialization complete!'));
    this.printNextSteps(targetDirectory, variables.EDITOR);
  }

  private getAgentStrengths(agent: string): string {
    const strengths = {
      claude: 'Analytical thinking, detailed explanations, architectural decisions',
      cursor: 'Code-centric development, debugging, optimization',
      codex: 'Versatile development capabilities, general purpose tasks',
      gemini: 'Creative problem solving, diverse perspectives'
    };
    return strengths[agent as keyof typeof strengths] || 'General AI assistance';
  }

  private getAgentBestFor(agent: string): string {
    const bestFor = {
      claude: 'Code analysis, architectural decisions, documentation',
      cursor: 'Feature implementation, bug fixes, code optimization',
      codex: 'General purpose development tasks',
      gemini: 'Brainstorming, alternative implementations, creative solutions'
    };
    return bestFor[agent as keyof typeof bestFor] || 'General development tasks';
  }

  private async createConfigFile(junoTaskDir: string, targetDirectory: string): Promise<void> {
    const configContent = {
      // Core settings
      defaultSubagent: this.context.subagent,
      defaultMaxIterations: 50,
      defaultModel: this.getDefaultModelForSubagent(this.context.subagent || 'claude'),

      // Logging settings
      logLevel: 'info',
      verbose: false,
      quiet: false,

      // MCP settings
      mcpTimeout: 3600000, // 3600 seconds (1 hour) - increased to prevent timeouts for longer operations
      mcpRetries: 3,
      mcpServerName: 'roundtable-ai',

      // TUI settings
      interactive: true,
      headlessMode: false,

      // Paths
      workingDirectory: targetDirectory,
      sessionDirectory: path.join(targetDirectory, '.juno_task')
    };

    const configPath = path.join(junoTaskDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(configContent, null, 2));

    console.log(chalk.green(`   ✓ Created .juno_task/config.json with ${this.context.subagent} as default subagent`));
  }

  private async createMcpFile(junoTaskDir: string, targetDirectory: string): Promise<void> {
    const projectName = path.basename(targetDirectory);
    const timestamp = new Date().toISOString();

    // Get the current directory in ESM way
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Get the roundtable server path - use environment variable or default
    const roundtablePath = process.env.JUNO_TASK_MCP_SERVER_PATH ||
      path.join(__dirname, '../../../roundtable_mcp_server/roundtable_mcp_server/server.py');

    const mcpContent = {
      mcpServers: {
        "roundtable-ai": {
          name: "roundtable-ai",
          command: "python",
          args: [roundtablePath],
          timeout: 7200.0,
          enable_default_progress_callback: true,
          suppress_subprocess_logs: true,
          env: {
            PYTHONPATH: path.resolve(__dirname, '../..'),
            ROUNDTABLE_DEBUG: "false"
          },
          _metadata: {
            description: "Roundtable AI MCP Server - Multi-agent orchestration with claude, cursor, codex, and gemini subagents",
            capabilities: [
              "claude_subagent - Advanced reasoning and code quality",
              "cursor_subagent - Real-time collaboration and editing",
              "codex_subagent - Code generation and completion",
              "gemini_subagent - Multimodal analysis and generation"
            ],
            working_directory: targetDirectory,
            verbose: false,
            created_at: timestamp,
            project_name: projectName,
            main_task: this.context.task || "Project initialization"
          }
        }
      },
      default_server: "roundtable-ai",
      global_settings: {
        connection_timeout: 300.0,
        default_retries: 3,
        enable_progress_streaming: true,
        log_level: "info",
        debug_mode: false
      },
      project_config: {
        name: projectName,
        main_task: this.context.task || "Project initialization",
        preferred_subagent: this.context.subagent || "claude",
        created_at: timestamp,
        version: "1.0.0"
      }
    };

    const mcpPath = path.join(junoTaskDir, 'mcp.json');
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2));

    console.log(chalk.green(`   ✓ Created .juno_task/mcp.json with roundtable-ai server configuration`));
  }

  private getDefaultModelForSubagent(subagent: string): string {
    const modelDefaults = {
      claude: 'sonnet-4',
      codex: 'gpt-5',
      gemini: 'gemini-2.5-pro',
      cursor: 'auto'
    };
    return modelDefaults[subagent as keyof typeof modelDefaults] || modelDefaults.claude;
  }

  /**
   * Copy utility scripts from templates/scripts to .juno_task/scripts directory
   * This includes scripts like clean_logs_folder.sh for log management
   */
  private async copyScriptsFromTemplates(junoTaskDir: string): Promise<void> {
    try {
      // Create scripts directory in .juno_task
      const scriptsDir = path.join(junoTaskDir, 'scripts');
      await fs.ensureDir(scriptsDir);

      // Get the template scripts directory path
      // In development: src/cli/commands/init.ts -> src/templates/scripts
      // In production (dist): dist/bin/cli.mjs -> dist/templates/scripts
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      // Determine the correct path based on whether we're in dist or src
      let templatesScriptsDir: string;

      if (__dirname.includes('/dist/bin') || __dirname.includes('\\dist\\bin')) {
        // Production: dist/bin -> dist/templates/scripts
        templatesScriptsDir = path.join(__dirname, '../templates/scripts');
      } else if (__dirname.includes('/src/cli/commands') || __dirname.includes('\\src\\cli\\commands')) {
        // Development: src/cli/commands -> src/templates/scripts
        templatesScriptsDir = path.join(__dirname, '../../templates/scripts');
      } else {
        // Fallback - try both
        templatesScriptsDir = path.join(__dirname, '../../templates/scripts');
      }

      // Check if template scripts directory exists
      if (!await fs.pathExists(templatesScriptsDir)) {
        console.log(chalk.yellow('   ⚠️  Template scripts directory not found, skipping script installation'));
        return;
      }

      // Read all files from template scripts directory
      const scriptFiles = await fs.readdir(templatesScriptsDir);

      if (scriptFiles.length === 0) {
        console.log(chalk.gray('   ℹ️  No template scripts found to install'));
        return;
      }

      // Copy each script file
      let copiedCount = 0;
      for (const scriptFile of scriptFiles) {
        const sourcePath = path.join(templatesScriptsDir, scriptFile);
        const destPath = path.join(scriptsDir, scriptFile);

        // Only copy files (not directories)
        const stats = await fs.stat(sourcePath);
        if (stats.isFile()) {
          await fs.copy(sourcePath, destPath);

          // Set executable permissions (chmod +x) for .sh files
          if (scriptFile.endsWith('.sh')) {
            await fs.chmod(destPath, 0o755); // rwxr-xr-x
          }

          copiedCount++;
          console.log(chalk.green(`   ✓ Installed script: ${scriptFile}`));
        }
      }

      if (copiedCount > 0) {
        console.log(chalk.green(`   ✓ Installed ${copiedCount} utility script(s) in .juno_task/scripts/`));
      }

    } catch (error) {
      console.log(chalk.yellow('   ⚠️  Failed to copy utility scripts'));
      console.log(chalk.gray(`   Error: ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.gray('   Scripts can be added manually later if needed'));
    }
  }

  /**
   * Execute install_requirements.sh script to install Python dependencies
   * This runs automatically during init to install juno-kanban and roundtable-ai
   */
  private async executeInstallRequirements(junoTaskDir: string): Promise<void> {
    try {
      const scriptsDir = path.join(junoTaskDir, 'scripts');
      const installScript = path.join(scriptsDir, 'install_requirements.sh');

      // Check if install_requirements.sh exists
      if (!await fs.pathExists(installScript)) {
        console.log(chalk.yellow('   ⚠️  install_requirements.sh not found, skipping Python dependencies installation'));
        console.log(chalk.gray('   You can install dependencies manually: juno-kanban, roundtable-ai'));
        return;
      }

      // Import child_process to execute the script
      const { execSync } = await import('child_process');

      // Execute the install_requirements.sh script
      try {
        // Run the script and capture output
        const output = execSync(installScript, {
          cwd: junoTaskDir,
          encoding: 'utf8',
          stdio: 'pipe' // Capture output instead of inheriting
        });

        // Print the script output
        if (output && output.trim()) {
          console.log(output);
        }

        console.log(chalk.green('   ✓ Python requirements installation completed'));

      } catch (error: any) {
        // Script execution failed
        const errorOutput = error.stdout ? error.stdout.toString() : '';
        const errorMsg = error.stderr ? error.stderr.toString() : error.message;

        // Print any output the script produced before failing
        if (errorOutput && errorOutput.trim()) {
          console.log(errorOutput);
        }

        // Check if this is a "requirements already satisfied" scenario (exit code 0)
        if (error.status === 0) {
          console.log(chalk.green('   ✓ Python requirements installation completed'));
          return;
        }

        // Check if this is a "neither uv nor pip found" error
        if (errorMsg.includes('Neither') || errorMsg.includes('not found')) {
          console.log(chalk.yellow('   ⚠️  Python package manager not found'));
          console.log(chalk.gray('   Please install uv or pip manually to install Python dependencies'));
          console.log(chalk.gray('   Required packages: juno-kanban, roundtable-ai'));
        } else {
          console.log(chalk.yellow('   ⚠️  Failed to install Python requirements'));
          console.log(chalk.gray(`   Error: ${errorMsg}`));
          console.log(chalk.gray('   You can run the script manually later: .juno_task/scripts/install_requirements.sh'));
        }
      }

    } catch (error) {
      console.log(chalk.yellow('   ⚠️  Failed to execute install_requirements.sh'));
      console.log(chalk.gray(`   Error: ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.gray('   You can install dependencies manually: juno-kanban, roundtable-ai'));
    }
  }

  private printNextSteps(targetDirectory: string, editor: string): void {
    console.log(chalk.blue('\n🎯 Next Steps:'));
    console.log(chalk.white(`   cd ${targetDirectory}`));
    console.log(chalk.white('   juno-task start           # Start task execution'));
    console.log(chalk.white(`   juno-task -s ${editor}       # Quick execution with ${editor}`));
    console.log(chalk.gray('\n💡 Tips:'));
    console.log(chalk.gray('   - Edit .juno_task/prompt.md to modify your main task'));
    console.log(chalk.gray('   - Use "juno-task --help" to see all available commands'));
    console.log(chalk.gray('   - Run .juno_task/scripts/clean_logs_folder.sh to archive old logs'));
  }

  /**
   * Initialize Git repository and set up remote if Git URL is provided
   */
  private async setupGitRepository(): Promise<void> {
    if (!this.context.gitUrl) {
      return; // No Git URL provided, skip Git setup
    }

    const { targetDirectory } = this.context;

    try {
      console.log(chalk.blue('🔧 Setting up Git repository...'));

      // Check if git is available
      const { execSync } = await import('child_process');

      try {
        execSync('git --version', { stdio: 'ignore' });
      } catch (error) {
        console.log(chalk.yellow('   ⚠️  Git not found, skipping repository setup'));
        console.log(chalk.gray('   Install Git to enable repository initialization'));
        return;
      }

      // Initialize git repository
      try {
        execSync('git init', { cwd: targetDirectory, stdio: 'ignore' });
        console.log(chalk.green('   ✓ Initialized Git repository'));
      } catch (error) {
        // Git repository might already exist, that's okay
        console.log(chalk.yellow('   ⚠️  Git repository already exists or initialization failed'));
      }

      // Add remote if URL is provided
      if (this.context.gitUrl) {
        try {
          // Check if remote already exists
          const remotes = execSync('git remote -v', {
            cwd: targetDirectory,
            encoding: 'utf8'
          });

          if (remotes.includes('origin')) {
            console.log(chalk.yellow('   ⚠️  Git remote "origin" already exists'));
          } else {
            // Add origin remote
            execSync(`git remote add origin "${this.context.gitUrl}"`, {
              cwd: targetDirectory,
              stdio: 'ignore'
            });
            console.log(chalk.green(`   ✓ Added remote origin: ${this.context.gitUrl}`));
          }
        } catch (error) {
          console.log(chalk.yellow('   ⚠️  Failed to add Git remote'));
        }
      }

      // Create initial commit if repository has no commits
      try {
        const commitCount = execSync('git rev-list --count HEAD', {
          cwd: targetDirectory,
          encoding: 'utf8'
        }).trim();

        if (commitCount === '0') {
          // Add all files and create initial commit
          execSync('git add .', { cwd: targetDirectory, stdio: 'ignore' });

          const commitMessage = `Initial commit: ${this.context.task || 'Project initialization'}\n\n🤖 Generated with juno-task using ${this.context.subagent} subagent\n🎯 Main Task: ${this.context.task}\n\n🚀 Generated with [juno-task](https://github.com/owner/juno-task-ts)\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;

          execSync(`git commit -m "${commitMessage}"`, {
            cwd: targetDirectory,
            stdio: 'ignore'
          });
          console.log(chalk.green('   ✓ Created initial commit'));
        } else {
          console.log(chalk.gray('   ℹ️  Repository already has commits'));
        }
      } catch (error) {
        console.log(chalk.yellow('   ⚠️  Failed to create initial commit'));
        console.log(chalk.gray('   You can commit manually later'));
      }

    } catch (error) {
      console.log(chalk.yellow('   ⚠️  Git setup failed'));
      console.log(chalk.gray(`   Error: ${error}`));
      console.log(chalk.gray('   You can set up Git manually later'));
    }
  }
}

/**
 * Headless initialization for automation (simplified)
 */
class SimpleHeadlessInit {
  constructor(private options: InitCommandOptions) {}

  async initialize(): Promise<InitializationContext> {
    const targetDirectory = path.resolve(this.options.directory || process.cwd());
    const task = this.options.task || 'Define your main task objective here';
    const gitUrl = this.options.gitUrl;

    // Use subagent from options or fallback to default
    const selectedSubagent = this.options.subagent || 'claude';

    // Create simple variables
    const variables = this.createSimpleVariables(targetDirectory, task, selectedSubagent, gitUrl);

    return {
      targetDirectory,
      task,
      subagent: selectedSubagent,
      gitUrl,
      variables,
      force: this.options.force || false,
      interactive: false
    };
  }

  private createSimpleVariables(
    targetDirectory: string,
    task: string,
    editor: string,
    gitUrl?: string
  ): TemplateVariables {
    const projectName = path.basename(targetDirectory);
    const currentDate = new Date().toISOString().split('T')[0];

    return {
      PROJECT_NAME: projectName,
      TASK: task,
      EDITOR: editor,
      CURRENT_DATE: currentDate,
      VERSION: '1.0.0',
      AUTHOR: 'Development Team',
      DESCRIPTION: task.substring(0, 200) + (task.length > 200 ? '...' : ''),
      GIT_URL: gitUrl || ''
    };
  }
}

/**
 * Main simplified init command handler
 */
export async function initCommandHandler(
  args: any,
  options: InitCommandOptions,
  command: Command
): Promise<void> {
  try {
    // Get global options from command's parent program
    const globalOptions = command.parent?.opts() || {};
    const allOptions = { ...options, ...globalOptions };

    console.log(chalk.blue.bold('🎯 Juno Task - Simplified Initialization'));

    let context: InitializationContext;

    // Default to interactive mode if no task is provided
    const shouldUseInteractive = options.interactive ||
      (!options.task && !process.env.CI) ||
      process.env.FORCE_INTERACTIVE === '1';

    if (shouldUseInteractive) {
      // Interactive mode with simplified TUI
      console.log(chalk.yellow('🚀 Starting simple interactive setup...'));
      const tui = new SimpleInitTUI();
      context = await tui.gather();
    } else {
      // Headless mode
      const headless = new SimpleHeadlessInit(allOptions);
      context = await headless.initialize();
    }

    // Generate project
    const generator = new SimpleProjectGenerator(context);
    await generator.generate();

    // Ensure the process exits cleanly after successful initialization to avoid
    // lingering interactive sessions waiting for manual quit keys.
    // This makes automated TUI runs finish without requiring 'q'.
    try {
      const { EXIT_CODES } = await import('../types.js');
      process.exit(EXIT_CODES.SUCCESS);
    } catch {
      // Fallback if import path changes; still attempt graceful exit
      process.exit(0);
    }

  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(chalk.red.bold('\n❌ Initialization Failed'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
    }

    // Unexpected error
    console.error(chalk.red.bold('\n❌ Unexpected Error'));
    console.error(chalk.red(`   ${error}`));

    if (options.verbose) {
      console.error('\n📍 Stack Trace:');
      console.error(error);
    }

    process.exit(99);
  }
}

/**
 * Configure the init command for Commander.js (simplified)
 */
export function configureInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize new juno-task project with simple setup')
    .argument('[directory]', 'Target directory (default: current directory)')
    .option('-f, --force', 'Force overwrite existing files')
    .option('-t, --task <description>', 'Main task description')
    .option('-g, --git-url <url>', 'Git repository URL')
    .option('-i, --interactive', 'Launch simple interactive setup')
    .action(async (directory, options, command) => {
      const initOptions: InitCommandOptions = {
        directory,
        force: options.force,
        task: options.task,
        gitUrl: options.gitUrl,
        subagent: options.subagent,
        interactive: options.interactive,
        // Global options
        verbose: options.verbose,
        quiet: options.quiet,
        config: options.config,
        logFile: options.logFile,
        logLevel: options.logLevel
      };

      await initCommandHandler([], initOptions, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task init                                    # Initialize in current directory
  $ juno-task init my-project                         # Initialize in ./my-project
  $ juno-task init --interactive                      # Use simple interactive setup

Simplified Interactive Flow:
  1. Project Root → Specify target directory
  2. Main Task → Multi-line description (no character limits)
  3. Subagent Selection → Choose from Claude, Codex, Gemini, Cursor
  4. Git Setup → Simple yes/no for Git configuration
  5. Save → Handle existing files with override/cancel options

Notes:
  - No prompt cost calculation or token counting
  - No character limits on task descriptions
  - Simple file structure with basic templates
  - Focus on quick project setup without complexity
    `);
}
