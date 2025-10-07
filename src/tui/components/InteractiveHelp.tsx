/**
 * Interactive Help System TUI Component for juno-task-ts
 *
 * Comprehensive help system with contextual assistance, tutorials,
 * and examples. Provides rich navigation and search capabilities.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { RichFormatter } from '../../cli/utils/rich-formatter.js';

// ============================================================================
// Help Content Interfaces
// ============================================================================

export interface HelpTopic {
  id: string;
  title: string;
  description: string;
  content: string;
  category: HelpCategory;
  keywords: string[];
  examples?: HelpExample[];
  relatedTopics?: string[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}

export interface HelpExample {
  title: string;
  description: string;
  command: string;
  output?: string;
}

export enum HelpCategory {
  GETTING_STARTED = 'Getting Started',
  COMMANDS = 'Commands',
  CONFIGURATION = 'Configuration',
  MCP_INTEGRATION = 'MCP Integration',
  SESSIONS = 'Session Management',
  TEMPLATES = 'Templates',
  TROUBLESHOOTING = 'Troubleshooting',
  ADVANCED = 'Advanced Usage'
}

export interface InteractiveHelpProps {
  onClose?: () => void;
  initialTopic?: string;
  showSearch?: boolean;
  showTutorial?: boolean;
}

// ============================================================================
// Help Content Database
// ============================================================================

const HELP_TOPICS: HelpTopic[] = [
  // Getting Started
  {
    id: 'quickstart',
    title: 'Quick Start Guide',
    description: 'Get up and running with juno-task in 5 minutes',
    category: HelpCategory.GETTING_STARTED,
    difficulty: 'beginner',
    keywords: ['start', 'begin', 'tutorial', 'first', 'quick'],
    content: `# Quick Start Guide

Welcome to juno-task! This guide will get you productive in 5 minutes.

## Step 1: Initialize a Project
\`\`\`bash
juno-task init
\`\`\`

This creates a .juno_task directory with:
- init.md - Your task description
- prompt.md - Additional context
- plan.md - Project plan

## Step 2: Edit Your Task
Edit .juno_task/init.md with your task description:
\`\`\`markdown
# My Task
Analyze this codebase and suggest improvements.
Focus on TypeScript best practices.
\`\`\`

## Step 3: Start Execution
\`\`\`bash
juno-task start
\`\`\`

That's it! juno-task will connect to your MCP server and execute the task.

## Next Steps
- Explore different subagents: claude, cursor, codex, gemini
- Learn about session management
- Customize configuration
`,
    examples: [
      {
        title: 'Initialize with interactive prompts',
        description: 'Use interactive mode for guided setup',
        command: 'juno-task init --interactive'
      },
      {
        title: 'Start with specific model',
        description: 'Override default model for execution',
        command: 'juno-task start --model sonnet-4'
      }
    ],
    relatedTopics: ['commands-init', 'commands-start', 'configuration']
  },

  // Commands
  {
    id: 'commands-init',
    title: 'Init Command',
    description: 'Initialize new projects and configure templates',
    category: HelpCategory.COMMANDS,
    difficulty: 'beginner',
    keywords: ['init', 'initialize', 'create', 'new', 'project', 'template'],
    content: `# Init Command

The init command creates a new juno-task project with all necessary files.

## Basic Usage
\`\`\`bash
juno-task init [options]
\`\`\`

## Options
- \`--interactive\` - Interactive setup with prompts
- \`--template <name>\` - Use specific template
- \`--force\` - Overwrite existing files
- \`--variables key=value\` - Set template variables

## Project Structure
After initialization, you'll have:

\`\`\`
.juno_task/
├── init.md          # Main task description
├── prompt.md        # Additional context
├── plan.md          # Project plan
└── config.json      # Local configuration
\`\`\`

## Templates
Available templates:
- \`basic\` - Simple task template (default)
- \`analysis\` - Code analysis template
- \`development\` - Development task template
- \`review\` - Code review template

## Interactive Mode
Interactive mode guides you through:
1. Task description
2. Subagent selection
3. Configuration options
4. Template variables
`,
    examples: [
      {
        title: 'Basic initialization',
        description: 'Create new project with defaults',
        command: 'juno-task init'
      },
      {
        title: 'Interactive setup',
        description: 'Guided project creation',
        command: 'juno-task init --interactive'
      },
      {
        title: 'Use specific template',
        description: 'Initialize with analysis template',
        command: 'juno-task init --template analysis'
      }
    ],
    relatedTopics: ['templates', 'configuration', 'quickstart']
  },

  {
    id: 'commands-start',
    title: 'Start Command',
    description: 'Execute tasks using .juno_task/init.md as prompt',
    category: HelpCategory.COMMANDS,
    difficulty: 'beginner',
    keywords: ['start', 'execute', 'run', 'task', 'mcp'],
    content: `# Start Command

The start command executes your task using the MCP server connection.

## Basic Usage
\`\`\`bash
juno-task start [options]
\`\`\`

## Options
- \`--max-iterations <number>\` - Limit execution iterations
- \`--model <name>\` - Override default model
- \`--directory <path>\` - Project directory
- \`--show-metrics\` - Display performance metrics
- \`--show-dashboard\` - Interactive performance dashboard
- \`--save-metrics [file]\` - Save metrics to file

## Execution Flow
1. Load configuration
2. Connect to MCP server
3. Create execution session
4. Process task iteratively
5. Display results and metrics

## Performance Monitoring
Monitor execution with:
- \`--show-metrics\` - Console metrics summary
- \`--show-dashboard\` - Interactive TUI dashboard
- \`--show-trends\` - Historical performance data

## Session Management
Each execution creates a session:
- Unique session ID
- Complete execution history
- Performance metrics
- Error logging
`,
    examples: [
      {
        title: 'Basic execution',
        description: 'Start task in current directory',
        command: 'juno-task start'
      },
      {
        title: 'Limited iterations',
        description: 'Restrict to 5 iterations max',
        command: 'juno-task start --max-iterations 5'
      },
      {
        title: 'With performance metrics',
        description: 'Show detailed performance data',
        command: 'juno-task start --show-metrics --save-metrics'
      }
    ],
    relatedTopics: ['mcp-integration', 'sessions', 'performance']
  },

  {
    id: 'commands-logs',
    title: 'Logs Command',
    description: 'View and manage application logs with filtering',
    category: HelpCategory.COMMANDS,
    difficulty: 'intermediate',
    keywords: ['logs', 'debug', 'error', 'filter', 'export'],
    content: `# Logs Command

The logs command provides comprehensive log viewing and management.

## Basic Usage
\`\`\`bash
juno-task logs [options]
\`\`\`

## Viewing Options
- \`--interactive\` - Interactive log viewer
- \`--tail <number>\` - Show recent entries
- \`--follow\` - Follow logs in real-time
- \`--format <format>\` - Output format (simple, detailed, json, rich)

## Filtering
- \`--level <level>\` - Filter by log level
- \`--context <context>\` - Filter by context
- \`--search <term>\` - Search in messages

## Log Levels
1. TRACE - Very detailed debugging
2. DEBUG - Debug information
3. INFO - General information
4. WARN - Warning messages
5. ERROR - Error messages
6. FATAL - Critical errors

## Contexts
- CLI - Command-line operations
- MCP - Protocol operations
- ENGINE - Execution engine
- SESSION - Session management
- PERFORMANCE - Performance monitoring

## Interactive Viewer
Navigate with:
- ↑↓ or j/k - Move selection
- 1-6 - Filter by level
- c - Cycle contexts
- d - Toggle details
- f - Toggle filters panel
- q - Quit
`,
    examples: [
      {
        title: 'Interactive viewer',
        description: 'Launch full-featured log viewer',
        command: 'juno-task logs --interactive'
      },
      {
        title: 'Error logs only',
        description: 'Show only error and fatal messages',
        command: 'juno-task logs --level error'
      },
      {
        title: 'Export logs',
        description: 'Export filtered logs to JSON file',
        command: 'juno-task logs --export debug.json --context mcp'
      }
    ],
    relatedTopics: ['troubleshooting', 'debugging']
  },

  // Configuration
  {
    id: 'configuration',
    title: 'Configuration Guide',
    description: 'Configure juno-task for your environment',
    category: HelpCategory.CONFIGURATION,
    difficulty: 'intermediate',
    keywords: ['config', 'settings', 'environment', 'setup'],
    content: `# Configuration Guide

juno-task supports multiple configuration methods with priority order.

## Configuration Priority
1. Command line arguments (highest)
2. Environment variables
3. Configuration files
4. Built-in defaults (lowest)

## Configuration Files
Supported formats:
- \`.juno_task/config.json\`
- \`.juno_task/config.toml\`
- \`pyproject.toml\` (juno-task section)

## Environment Variables
- \`JUNO_TASK_SUBAGENT\` - Default subagent
- \`JUNO_TASK_MCP_SERVER_PATH\` - MCP server path
- \`JUNO_TASK_CONFIG\` - Config file path
- \`JUNO_TASK_VERBOSE\` - Enable verbose output
- \`NO_COLOR\` - Disable colors

## Sample Configuration
\`\`\`json
{
  "defaultSubagent": "claude",
  "mcpServerPath": "/path/to/mcp-server",
  "defaultMaxIterations": 10,
  "mcpTimeout": 30000,
  "logLevel": "info",
  "templates": {
    "analysis": "./templates/analysis.md"
  }
}
\`\`\`

## MCP Server Setup
1. Install MCP server (e.g., roundtable-mcp-server)
2. Set path in configuration
3. Test connection with \`juno-task start --verbose\`
`,
    examples: [
      {
        title: 'Create config file',
        description: 'Initialize with custom config',
        command: 'juno-task init --config custom.json'
      },
      {
        title: 'Environment override',
        description: 'Override subagent via environment',
        command: 'JUNO_TASK_SUBAGENT=cursor juno-task start'
      }
    ],
    relatedTopics: ['mcp-integration', 'templates']
  },

  // Troubleshooting
  {
    id: 'troubleshooting',
    title: 'Troubleshooting Guide',
    description: 'Common issues and solutions',
    category: HelpCategory.TROUBLESHOOTING,
    difficulty: 'intermediate',
    keywords: ['error', 'problem', 'fix', 'debug', 'issue'],
    content: `# Troubleshooting Guide

Common issues and their solutions.

## MCP Connection Issues

### Error: "Failed to connect to MCP server"
**Cause**: MCP server path not configured or server not running
**Solution**:
1. Check MCP server installation
2. Verify path in configuration
3. Test with \`--verbose\` flag

### Error: "MCP timeout"
**Cause**: Server taking too long to respond
**Solution**:
1. Increase timeout in config
2. Check server performance
3. Use fewer iterations

## File System Issues

### Error: "init.md not found"
**Cause**: No project initialized in directory
**Solution**: Run \`juno-task init\` first

### Error: "Permission denied"
**Cause**: Insufficient file permissions
**Solution**: Check directory permissions

## Performance Issues

### Slow execution
**Causes & Solutions**:
- Large files: Use .gitignore patterns
- Complex tasks: Break into smaller tasks
- Server overload: Reduce iterations

## Debug Information
Get detailed debug info:
\`\`\`bash
juno-task start --verbose --log-level debug
juno-task logs --level debug --context mcp
\`\`\`

## Getting Help
1. Check logs: \`juno-task logs --interactive\`
2. Export logs: \`juno-task logs --export debug.json\`
3. Include logs when reporting issues
`,
    examples: [
      {
        title: 'Debug MCP connection',
        description: 'Verbose execution with MCP debugging',
        command: 'juno-task start --verbose --log-level debug'
      },
      {
        title: 'View error logs',
        description: 'Filter and export error logs',
        command: 'juno-task logs --level error --export errors.json'
      }
    ],
    relatedTopics: ['commands-logs', 'mcp-integration', 'configuration']
  }
];

// ============================================================================
// Help Navigation Components
// ============================================================================

const CategoryList: React.FC<{
  categories: HelpCategory[];
  selectedCategory: HelpCategory | null;
  onSelect: (category: HelpCategory) => void;
}> = ({ categories, selectedCategory, onSelect }) => {
  return (
    <Box flexDirection="column">
      <Text bold color="blue">📚 Categories</Text>
      <Box marginTop={1} flexDirection="column">
        {categories.map(category => (
          <Box key={category}>
            <Text color={selectedCategory === category ? 'blue' : 'gray'}>
              {selectedCategory === category ? '❯ ' : '  '}
              {category}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const TopicList: React.FC<{
  topics: HelpTopic[];
  selectedTopic: string | null;
  onSelect: (topicId: string) => void;
}> = ({ topics, selectedTopic, onSelect }) => {
  const getDifficultyIcon = (difficulty: string) => {
    switch (difficulty) {
      case 'beginner': return '🟢';
      case 'intermediate': return '🟡';
      case 'advanced': return '🔴';
      default: return '⚪';
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold color="blue">📖 Topics</Text>
      <Box marginTop={1} flexDirection="column">
        {topics.map(topic => (
          <Box key={topic.id} marginBottom={0}>
            <Text color={selectedTopic === topic.id ? 'blue' : 'gray'}>
              {selectedTopic === topic.id ? '❯ ' : '  '}
              {getDifficultyIcon(topic.difficulty)} {topic.title}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const HelpContent: React.FC<{
  topic: HelpTopic;
  formatter: RichFormatter;
}> = ({ topic, formatter }) => {
  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'beginner': return 'green';
      case 'intermediate': return 'yellow';
      case 'advanced': return 'red';
      default: return 'gray';
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="blue">{topic.title}</Text>
        <Text color="gray"> | </Text>
        <Text color={getDifficultyColor(topic.difficulty)}>{topic.difficulty}</Text>
        <Text color="gray"> | </Text>
        <Text color="cyan">{topic.category}</Text>
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text color="gray">{topic.description}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>{topic.content}</Text>
      </Box>

      {/* Examples */}
      {topic.examples && topic.examples.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">💡 Examples</Text>
          {topic.examples.map((example, index) => (
            <Box key={index} flexDirection="column" marginLeft={2} marginTop={1}>
              <Text bold color="green">{example.title}</Text>
              <Text color="gray">{example.description}</Text>
              <Text color="cyan">$ {example.command}</Text>
              {example.output && (
                <Text color="gray">{example.output}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Related Topics */}
      {topic.relatedTopics && topic.relatedTopics.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">🔗 Related Topics</Text>
          <Box flexDirection="row" marginLeft={2}>
            {topic.relatedTopics.map((relatedId, index) => (
              <React.Fragment key={relatedId}>
                <Text color="blue">{relatedId}</Text>
                {index < topic.relatedTopics!.length - 1 && <Text color="gray"> | </Text>}
              </React.Fragment>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
};

const SearchResults: React.FC<{
  results: HelpTopic[];
  searchTerm: string;
  selectedIndex: number;
  onSelect: (topicId: string) => void;
}> = ({ results, searchTerm, selectedIndex, onSelect }) => {
  if (results.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No results found for "{searchTerm}"</Text>
        <Text color="gray">Try different keywords or browse categories</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="blue">🔍 Search Results ({results.length})</Text>
      <Box marginTop={1} flexDirection="column">
        {results.map((topic, index) => (
          <Box key={topic.id}>
            <Text color={selectedIndex === index ? 'blue' : 'gray'}>
              {selectedIndex === index ? '❯ ' : '  '}
              {topic.title} - {topic.description}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

// ============================================================================
// Main Interactive Help Component
// ============================================================================

export const InteractiveHelp: React.FC<InteractiveHelpProps> = ({
  onClose,
  initialTopic,
  showSearch = true,
  showTutorial = false
}) => {
  const [viewMode, setViewMode] = useState<'categories' | 'topics' | 'content' | 'search'>('categories');
  const [selectedCategory, setSelectedCategory] = useState<HelpCategory | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(initialTopic || null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [searchResults, setSearchResults] = useState<HelpTopic[]>([]);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState<number>(0);

  const formatter = new RichFormatter();

  // Get unique categories
  const categories = useMemo(() => {
    return Array.from(new Set(HELP_TOPICS.map(topic => topic.category)));
  }, []);

  // Get topics for selected category
  const categoryTopics = useMemo(() => {
    if (!selectedCategory) return [];
    return HELP_TOPICS.filter(topic => topic.category === selectedCategory);
  }, [selectedCategory]);

  // Get selected topic
  const selectedTopic = useMemo(() => {
    if (!selectedTopicId) return null;
    return HELP_TOPICS.find(topic => topic.id === selectedTopicId) || null;
  }, [selectedTopicId]);

  // Search functionality
  const performSearch = (term: string) => {
    if (!term.trim()) {
      setSearchResults([]);
      return;
    }

    const results = HELP_TOPICS.filter(topic => {
      const searchLower = term.toLowerCase();
      return (
        topic.title.toLowerCase().includes(searchLower) ||
        topic.description.toLowerCase().includes(searchLower) ||
        topic.content.toLowerCase().includes(searchLower) ||
        topic.keywords.some(keyword => keyword.toLowerCase().includes(searchLower))
      );
    });

    setSearchResults(results);
    setSelectedSearchIndex(0);
  };

  // Handle keyboard input
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose?.();
      return;
    }

    switch (viewMode) {
      case 'categories':
        if (key.upArrow || input === 'k') {
          const currentIndex = selectedCategory ? categories.indexOf(selectedCategory) : 0;
          const newIndex = Math.max(0, currentIndex - 1);
          setSelectedCategory(categories[newIndex]);
        } else if (key.downArrow || input === 'j') {
          const currentIndex = selectedCategory ? categories.indexOf(selectedCategory) : -1;
          const newIndex = Math.min(categories.length - 1, currentIndex + 1);
          setSelectedCategory(categories[newIndex]);
        } else if (key.return && selectedCategory) {
          setViewMode('topics');
        } else if (input === 's' && showSearch) {
          setViewMode('search');
        }
        break;

      case 'topics':
        if (key.upArrow || input === 'k') {
          const currentIndex = selectedTopicId ? categoryTopics.findIndex(t => t.id === selectedTopicId) : 0;
          const newIndex = Math.max(0, currentIndex - 1);
          setSelectedTopicId(categoryTopics[newIndex]?.id || null);
        } else if (key.downArrow || input === 'j') {
          const currentIndex = selectedTopicId ? categoryTopics.findIndex(t => t.id === selectedTopicId) : -1;
          const newIndex = Math.min(categoryTopics.length - 1, currentIndex + 1);
          setSelectedTopicId(categoryTopics[newIndex]?.id || null);
        } else if (key.return && selectedTopicId) {
          setViewMode('content');
        } else if (key.leftArrow || input === 'h') {
          setViewMode('categories');
        }
        break;

      case 'content':
        if (key.leftArrow || input === 'h') {
          setViewMode('topics');
        } else if (input === 'c') {
          setViewMode('categories');
        }
        break;

      case 'search':
        if (key.upArrow || input === 'k') {
          setSelectedSearchIndex(Math.max(0, selectedSearchIndex - 1));
        } else if (key.downArrow || input === 'j') {
          setSelectedSearchIndex(Math.min(searchResults.length - 1, selectedSearchIndex + 1));
        } else if (key.return && searchResults[selectedSearchIndex]) {
          setSelectedTopicId(searchResults[selectedSearchIndex].id);
          setViewMode('content');
        } else if (key.leftArrow || input === 'h') {
          setViewMode('categories');
        }
        break;
    }
  });

  // Auto-select first category
  useEffect(() => {
    if (!selectedCategory && categories.length > 0) {
      setSelectedCategory(categories[0]);
    }
  }, [categories, selectedCategory]);

  // Auto-select first topic
  useEffect(() => {
    if (!selectedTopicId && categoryTopics.length > 0) {
      setSelectedTopicId(categoryTopics[0].id);
    }
  }, [categoryTopics, selectedTopicId]);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="blue">🆘 Interactive Help System</Text>
        <Text color="gray"> | Mode: {viewMode}</Text>
      </Box>

      {/* Main content */}
      <Box flexGrow={1}>
        {viewMode === 'categories' && (
          <CategoryList
            categories={categories}
            selectedCategory={selectedCategory}
            onSelect={setSelectedCategory}
          />
        )}

        {viewMode === 'topics' && (
          <TopicList
            topics={categoryTopics}
            selectedTopic={selectedTopicId}
            onSelect={setSelectedTopicId}
          />
        )}

        {viewMode === 'content' && selectedTopic && (
          <HelpContent topic={selectedTopic} formatter={formatter} />
        )}

        {viewMode === 'search' && (
          <SearchResults
            results={searchResults}
            searchTerm={searchTerm}
            selectedIndex={selectedSearchIndex}
            onSelect={setSelectedTopicId}
          />
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color="gray">
          Navigation: ↑↓/jk | Enter: select | h: back | c: categories | s: search | q: quit
        </Text>
      </Box>
    </Box>
  );
};

export default InteractiveHelp;