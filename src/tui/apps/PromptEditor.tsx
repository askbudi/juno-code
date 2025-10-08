/**
 * TUI Prompt Editor for juno-task-ts
 *
 * Rich text editor for creating and editing prompts with syntax highlighting,
 * line numbers, and advanced editing features. Integrates with --interactive-prompt.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { TUIApp } from './TUIApp.js';
import { Input } from '../components/Input.js';
import { Dialog } from '../components/Dialog.js';
import { useTUIContext } from '../apps/TUIApp.js';
import { useKeyboard, useNavigationKeys } from '../hooks/useKeyboard.js';
import { useTUIState } from '../hooks/useTUIState.js';
import type {
  PromptEditorProps,
  PromptEditorState,
  TokenEstimate,
  PromptAnalysis
} from '../types.js';

// Import new utility modules
import {
  extractTemplateVariables,
  substituteTemplateVariables,
  validateTemplateVariables
} from '../utils/templateVariables.js';
import { estimateTokenCount, formatTokenDisplay } from '../utils/tokenEstimator.js';
import { analyzePrompt, formatAnalysisSummary } from '../utils/promptAnalyzer.js';
import { highlightLine, parseAllTokens } from '../utils/syntaxHighlighter.js';

/**
 * Internal prompt editor component that uses TUI context
 */
const PromptEditorInternal: React.FC<PromptEditorProps> = ({
  initialValue = '',
  onSubmit,
  onCancel,
  showHelp = true,
  enableSyntaxHighlighting = false,
  maxLength = 10000,
  templateVariables = {},
  showPreview = false,
  showTokenCount = true,
  targetModel = 'gpt-4',
  showAnalysis = false,
  testId
}) => {
  const { theme, dimensions } = useTUIContext();

  // Editor state
  const {
    value: text,
    setValue: setText,
    isDirty
  } = useTUIState(initialValue, {
    validate: (value: string) => {
      if (value.length > maxLength) {
        return `Prompt too long (${value.length}/${maxLength} characters)`;
      }
      return null;
    }
  });

  const [cursorPosition, setCursorPosition] = useState(initialValue.length);
  const [showingHelp, setShowingHelp] = useState(false);
  const [showConfirmExit, setShowConfirmExit] = useState(false);
  const [viewportStart, setViewportStart] = useState(0);
  const [showingPreview, setShowingPreview] = useState(false);
  const [showingAnalysis, setShowingAnalysis] = useState(false);
  const [showingVariables, setShowingVariables] = useState(false);

  // Advanced features state
  const tokenEstimate = useMemo(() => {
    if (!showTokenCount) return undefined;
    return estimateTokenCount(text, targetModel);
  }, [text, targetModel, showTokenCount]);

  const promptAnalysis = useMemo(() => {
    if (!showAnalysis) return undefined;
    return analyzePrompt(text);
  }, [text, showAnalysis]);

  const previewText = useMemo(() => {
    if (!showPreview) return undefined;
    return substituteTemplateVariables(text, templateVariables);
  }, [text, templateVariables, showPreview]);

  const templateVariableErrors = useMemo(() => {
    return validateTemplateVariables(text, templateVariables);
  }, [text, templateVariables]);

  // Split text into lines
  const lines = text.split('\n');

  // Calculate editor dimensions - start with 5 lines, grow with content
  const minHeight = 5;
  const maxHeight = dimensions.height - 8; // Leave space for header, footer, etc.
  const contentHeight = Math.max(lines.length, minHeight);
  const editorHeight = Math.min(contentHeight, maxHeight);
  const editorWidth = dimensions.width - 4; // Leave space for borders
  const currentLineIndex = getCurrentLineIndex(text, cursorPosition);
  const currentColumnIndex = getCurrentColumnIndex(text, cursorPosition);

  // Viewport management
  useEffect(() => {
    // Auto-scroll to keep cursor visible
    if (currentLineIndex < viewportStart) {
      setViewportStart(currentLineIndex);
    } else if (currentLineIndex >= viewportStart + editorHeight) {
      setViewportStart(currentLineIndex - editorHeight + 1);
    }
  }, [currentLineIndex, viewportStart, editorHeight]);

  // Handle text insertion
  const insertText = useCallback((insertedText: string) => {
    const newText = text.slice(0, cursorPosition) + insertedText + text.slice(cursorPosition);
    setText(newText);
    setCursorPosition(cursorPosition + insertedText.length);
  }, [text, cursorPosition, setText]);

  // Handle text deletion
  const deleteText = useCallback((deleteCount: number, direction: 'backward' | 'forward' = 'backward') => {
    let startPos: number;
    let endPos: number;

    if (direction === 'backward') {
      startPos = Math.max(0, cursorPosition - deleteCount);
      endPos = cursorPosition;
      setCursorPosition(startPos);
    } else {
      startPos = cursorPosition;
      endPos = Math.min(text.length, cursorPosition + deleteCount);
    }

    const newText = text.slice(0, startPos) + text.slice(endPos);
    setText(newText);
  }, [text, cursorPosition, setText]);

  // Navigation handlers
  const moveCursor = useCallback((newPosition: number) => {
    setCursorPosition(Math.max(0, Math.min(text.length, newPosition)));
  }, [text.length]);

  const moveCursorByLines = useCallback((lineOffset: number) => {
    const targetLine = Math.max(0, Math.min(lines.length - 1, currentLineIndex + lineOffset));
    const targetLineLength = lines[targetLine]?.length || 0;
    const targetColumn = Math.min(currentColumnIndex, targetLineLength);

    const newPosition = getPositionFromLineColumn(text, targetLine, targetColumn);
    moveCursor(newPosition);
  }, [text, lines, currentLineIndex, currentColumnIndex, moveCursor]);

  // Keyboard handling
  useKeyboard({
    onKey: (event) => {
      // Don't handle keys if showing help or confirm dialog
      if (showingHelp || showConfirmExit) return;

      const { key, ctrl, meta, shift, alt } = event;

      // Handle special keys
      if (key === 'return') {
        // Enter submits the prompt (user-friendly behavior)
        if (text.trim()) {
          onSubmit(text);
        }
        return;
      }

      if (key === 'tab') {
        insertText('  '); // Insert 2 spaces for tab
        return;
      }

      if (key === 'backspace') {
        if (cursorPosition > 0) {
          deleteText(1, 'backward');
        }
        return;
      }

      if (key === 'delete') {
        if (cursorPosition < text.length) {
          deleteText(1, 'forward');
        }
        return;
      }

      // Navigation keys
      if (key === 'leftArrow') {
        moveCursor(cursorPosition - 1);
        return;
      }

      if (key === 'rightArrow') {
        moveCursor(cursorPosition + 1);
        return;
      }

      if (key === 'upArrow') {
        moveCursorByLines(-1);
        return;
      }

      if (key === 'downArrow') {
        moveCursorByLines(1);
        return;
      }

      if (key === 'home') {
        const lineStart = getLineStartPosition(text, cursorPosition);
        moveCursor(lineStart);
        return;
      }

      if (key === 'end') {
        const lineEnd = getLineEndPosition(text, cursorPosition);
        moveCursor(lineEnd);
        return;
      }

      if (key === 'pageUp') {
        moveCursorByLines(-editorHeight);
        return;
      }

      if (key === 'pageDown') {
        moveCursorByLines(editorHeight);
        return;
      }

      // Ctrl shortcuts
      if (ctrl) {
        switch (key) {
          case 'a': // Select all (move to end for now)
            moveCursor(text.length);
            return;
          case 'home': // Go to document start
            moveCursor(0);
            return;
          case 'end': // Go to document end
            moveCursor(text.length);
            return;
          case 'j': // Ctrl+J adds new line (alternative method)
            insertText('\n');
            return;
          case 'z': // Undo (not implemented yet)
            return;
          case 'y': // Redo (not implemented yet)
            return;
        }
      }

      // Regular character input
      if (key.length === 1 && !ctrl && !meta && !alt) {
        insertText(key);
        return;
      }
    }
  });

  // Global shortcuts
  useKeyboard({
    bindings: [
      {
        key: 'escape',
        handler: () => {
          if (showingHelp || showingPreview || showingAnalysis || showingVariables) {
            setShowingHelp(false);
            setShowingPreview(false);
            setShowingAnalysis(false);
            setShowingVariables(false);
          } else if (isDirty) {
            setShowConfirmExit(true);
          } else {
            onCancel();
          }
        }
      },
      {
        key: 'f1',
        handler: () => setShowingHelp(true)
      },
      {
        key: 'f2',
        handler: () => showPreview && setShowingPreview(!showingPreview)
      },
      {
        key: 'f3',
        handler: () => showAnalysis && setShowingAnalysis(!showingAnalysis)
      },
      {
        key: 'f4',
        handler: () => setShowingVariables(!showingVariables)
      },
      {
        key: 'ctrl+s',
        handler: () => {
          if (text.trim()) {
            onSubmit(text);
          }
        }
      }
    ]
  });

  // Render visible lines - ensure we always show at least 5 lines for proper editing
  const visibleLines = lines.slice(viewportStart, viewportStart + editorHeight);

  // Pad with empty lines if we have fewer than the minimum height
  while (visibleLines.length < minHeight && viewportStart + visibleLines.length < lines.length + minHeight) {
    visibleLines.push('');
  }

  const lineNumberWidth = Math.max(String(lines.length).length + 1, 3);

  return (
    <>
      {/* Modern Header */}
      <Box
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
        paddingY={1}
        borderStyle="round"
        borderColor={theme.primary}
      >
        <Box justifyContent="space-between" marginBottom={1}>
          <Box flexDirection="row" gap={2}>
            <Text color={theme.primary} bold>📝 Prompt Editor</Text>
            <Text color={theme.muted}>
              {currentLineIndex + 1}:{currentColumnIndex + 1}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color={isDirty ? theme.warning : theme.success}>
              {isDirty ? '● UNSAVED' : '✓ SAVED'}
            </Text>
          </Box>
        </Box>

        <Box justifyContent="space-between">
          <Box flexDirection="row" gap={2}>
            {templateVariableErrors.length > 0 && (
              <Text color={theme.error}>
                ⚠ {templateVariableErrors.length} variable error{templateVariableErrors.length > 1 ? 's' : ''}
              </Text>
            )}
            {tokenEstimate && (
              <Text color={theme.muted}>
                {formatTokenDisplay(tokenEstimate)}
              </Text>
            )}
            {promptAnalysis && (
              <Text color={promptAnalysis.qualityScore >= 80 ? theme.success :
                            promptAnalysis.qualityScore >= 60 ? theme.warning : theme.error}>
                Quality: {promptAnalysis.qualityScore}%
              </Text>
            )}
          </Box>
          <Text color={theme.muted}>
            {text.length}/{maxLength} characters
          </Text>
        </Box>
      </Box>

      {/* Editor area */}
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={isDirty ? theme.warning : theme.primary}
        width="100%"
        minHeight={editorHeight + 2}
        paddingX={1}
        backgroundColor={undefined}
      >
        {visibleLines.map((line, index) => {
          const actualLineIndex = viewportStart + index;
          const isCurrentLine = actualLineIndex === currentLineIndex;

          // Calculate cursor position for current line
          let displayLine = line;
          let cursorChar = '';

          if (isCurrentLine) {
            const lineStartPos = getLineStartPosition(text, cursorPosition);
            const relativeCursorPos = cursorPosition - lineStartPos;

            if (relativeCursorPos <= line.length) {
              const beforeCursor = line.slice(0, relativeCursorPos);
              const atCursor = line[relativeCursorPos] || ' ';
              const afterCursor = line.slice(relativeCursorPos + 1);

              displayLine = beforeCursor + afterCursor;
              cursorChar = atCursor;
            }
          }

          return (
            <Box key={actualLineIndex} marginY={0}>
              {/* Line number with modern styling */}
              <Text
                color={isCurrentLine ? theme.primary : theme.muted}
                width={lineNumberWidth}
                backgroundColor={isCurrentLine ? undefined : undefined}
              >
                {String(actualLineIndex + 1).padStart(lineNumberWidth - 1, ' ')}
                {isCurrentLine ? '►' : ' '}
              </Text>

              {/* Line content with enhanced styling */}
              <Text
                color={isCurrentLine ? theme.text : theme.muted}
                backgroundColor={isCurrentLine ? undefined : undefined}
              >
                {enableSyntaxHighlighting ?
                  highlightLine(displayLine, 0, templateVariables) :
                  displayLine}
                {isCurrentLine && (
                  <Text inverse backgroundColor={theme.primary}>{cursorChar}</Text>
                )}
              </Text>
            </Box>
          );
        })}

        {/* Empty editor message - only show if no lines are displayed */}
        {visibleLines.length === 0 && (
          <Box justifyContent="center" alignItems="center" height={Math.max(5, editorHeight)} flexDirection="column">
            <Text color={theme.primary} bold>✨ Ready to Create</Text>
            <Text color={theme.muted}>Start typing your prompt here...</Text>
            <Text color={theme.muted}>Press <Text color={theme.success}>Enter</Text> to submit or <Text color={theme.success}>Ctrl+J</Text> for new lines</Text>
          </Box>
        )}
      </Box>

      {/* Modern Footer */}
      <Box
        marginTop={1}
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        borderColor={theme.muted}
        justifyContent="space-between"
      >
        <Box flexDirection="column">
          <Text color={theme.primary} bold>Quick Keys:</Text>
          <Text color={theme.muted}>
            <Text color={theme.success}>Enter</Text> submit • <Text color={theme.success}>Ctrl+J</Text> new line • <Text color={theme.success}>Ctrl+S</Text> save • <Text color={theme.success}>ESC</Text> cancel
          </Text>
          {(showPreview || showAnalysis) && (
            <Text color={theme.muted}>
              {showPreview && <><Text color={theme.success}>F2</Text> preview</>}
              {showPreview && showAnalysis && ' • '}
              {showAnalysis && <><Text color={theme.success}>F3</Text> analysis</>}
              {' • '}<Text color={theme.success}>F4</Text> variables • <Text color={theme.success}>F1</Text> help
            </Text>
          )}
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color={theme.primary} bold>
            {showingHelp ? '📖 Help' :
             showingPreview ? '👁  Preview' :
             showingAnalysis ? '🔍 Analysis' :
             showingVariables ? '🔧 Variables' : '✏️  Editor'}
          </Text>
          <Text color={theme.muted}>
            Mode
          </Text>
        </Box>
      </Box>

      {/* Preview dialog */}
      {showPreview && showingPreview && previewText && (
        <Dialog
          title="Template Preview"
          message={`Preview with substituted variables:\n\n${previewText}`}
          isVisible={showingPreview}
          onClose={() => setShowingPreview(false)}
          type="info"
        />
      )}

      {/* Analysis dialog */}
      {showAnalysis && showingAnalysis && promptAnalysis && (
        <Dialog
          title="Prompt Quality Analysis"
          message={getAnalysisText(promptAnalysis)}
          isVisible={showingAnalysis}
          onClose={() => setShowingAnalysis(false)}
          type={promptAnalysis.qualityScore >= 60 ? "info" : "warning"}
        />
      )}

      {/* Variables dialog */}
      {showingVariables && (
        <Dialog
          title="Template Variables"
          message={getVariablesText(templateVariables, templateVariableErrors)}
          isVisible={showingVariables}
          onClose={() => setShowingVariables(false)}
          type={templateVariableErrors.length > 0 ? "warning" : "info"}
        />
      )}

      {/* Help dialog */}
      {showHelp && showingHelp && (
        <Dialog
          title="Prompt Editor Help"
          message={getHelpText()}
          isVisible={showingHelp}
          onClose={() => setShowingHelp(false)}
          type="info"
        />
      )}

      {/* Confirm exit dialog */}
      <Dialog
        title="Confirm Exit"
        message="You have unsaved changes. Are you sure you want to exit without saving?"
        isVisible={showConfirmExit}
        onClose={() => setShowConfirmExit(false)}
        buttons={[
          {
            label: 'Save & Exit',
            action: () => {
              if (text.trim()) {
                onSubmit(text);
              } else {
                onCancel();
              }
            },
            variant: 'primary',
            isDefault: true
          },
          {
            label: 'Exit Without Saving',
            action: onCancel,
            variant: 'warning'
          },
          {
            label: 'Cancel',
            action: () => setShowConfirmExit(false),
            variant: 'secondary'
          }
        ]}
        type="warning"
      />
    </>
  );
};

/**
 * Advanced prompt editor with rich features
 * This is the main component that wraps the internal editor in TUIApp
 */
export const PromptEditor: React.FC<PromptEditorProps> = (props) => {
  return (
    <TUIApp
      title="Prompt Editor"
      exitOnEscape={false}
      testId={props.testId}
    >
      <PromptEditorInternal {...props} />
    </TUIApp>
  );
};

/**
 * Simple prompt editor for basic use cases
 */
export const SimplePromptEditor: React.FC<{
  initialValue?: string;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
  placeholder?: string;
  testId?: string;
}> = ({
  initialValue = '',
  onSubmit,
  onCancel,
  placeholder = 'Enter your prompt...',
  testId
}) => {
  const [prompt, setPrompt] = useState(initialValue);

  return (
    <TUIApp title="Enter Prompt" testId={testId}>
      <Box flexDirection="column" padding={1}>
        <Input
          label="Prompt"
          value={prompt}
          onChange={setPrompt}
          onSubmit={onSubmit}
          placeholder={placeholder}
          multiline={true}
          autoFocus={true}
        />

        <Box marginTop={2} justifyContent="flex-end" gap={1}>
          <Text color="gray">Ctrl+Enter to submit • ESC to cancel</Text>
        </Box>
      </Box>
    </TUIApp>
  );
};

// ============================================================================
// Helper Functions
// ============================================================================

function getCurrentLineIndex(text: string, cursorPosition: number): number {
  return text.slice(0, cursorPosition).split('\n').length - 1;
}

function getCurrentColumnIndex(text: string, cursorPosition: number): number {
  const beforeCursor = text.slice(0, cursorPosition);
  const lines = beforeCursor.split('\n');
  return lines[lines.length - 1].length;
}

function getLineStartPosition(text: string, cursorPosition: number): number {
  const beforeCursor = text.slice(0, cursorPosition);
  const lastNewlineIndex = beforeCursor.lastIndexOf('\n');
  return lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
}

function getLineEndPosition(text: string, cursorPosition: number): number {
  const afterCursor = text.slice(cursorPosition);
  const nextNewlineIndex = afterCursor.indexOf('\n');
  return nextNewlineIndex === -1 ? text.length : cursorPosition + nextNewlineIndex;
}

function getPositionFromLineColumn(text: string, lineIndex: number, columnIndex: number): number {
  const lines = text.split('\n');
  let position = 0;

  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    position += lines[i].length + 1; // +1 for newline character
  }

  if (lineIndex < lines.length) {
    position += Math.min(columnIndex, lines[lineIndex].length);
  }

  return position;
}

function getAnalysisText(analysis: PromptAnalysis): string {
  const lines = [
    `Overall Quality Score: ${analysis.qualityScore}/100`,
    '',
    `Structure Analysis (${analysis.structure.score}/100):`,
    `• Clear Structure: ${analysis.structure.hasClearStructure ? 'Yes' : 'No'}`,
    `• Has Context: ${analysis.structure.hasContext ? 'Yes' : 'No'}`,
    `• Has Task Definition: ${analysis.structure.hasTask ? 'Yes' : 'No'}`,
    `• Has Constraints: ${analysis.structure.hasConstraints ? 'Yes' : 'No'}`,
    `• Has Examples: ${analysis.structure.hasExamples ? 'Yes' : 'No'}`,
    '',
    `Clarity Analysis (${analysis.clarity.clarityScore}/100):`,
    `• Average Sentence Length: ${Math.round(analysis.clarity.avgSentenceLength)} characters`,
    `• Ambiguous Words: ${analysis.clarity.ambiguousWordCount}`,
    `• Passive Voice Ratio: ${Math.round(analysis.clarity.passiveVoiceRatio * 100)}%`,
    '',
    `Completeness Analysis (${analysis.completeness.score}/100):`,
    `• Task Definition: ${analysis.completeness.hasTaskDefinition ? 'Yes' : 'No'}`,
    `• Context Provided: ${analysis.completeness.hasContext ? 'Yes' : 'No'}`,
    `• Output Format: ${analysis.completeness.hasOutputFormat ? 'Yes' : 'No'}`,
    `• Examples: ${analysis.completeness.hasExamples ? 'Yes' : 'No'}`
  ];

  if (analysis.suggestions.length > 0) {
    lines.push('', 'Optimization Suggestions:');
    analysis.suggestions.slice(0, 5).forEach((suggestion, index) => {
      lines.push(`${index + 1}. [${suggestion.priority.toUpperCase()}] ${suggestion.message}`);
      lines.push(`   ${suggestion.suggestion}`);
    });
  }

  return lines.join('\n');
}

function getVariablesText(
  templateVariables: Record<string, any>,
  errors: Array<{ variable: string; line: number; column: number; message: string }>
): string {
  const lines = [];

  // Show detected variables
  const detectedVars = Object.keys(templateVariables);
  if (detectedVars.length > 0) {
    lines.push('Template Variables:');
    detectedVars.forEach(varName => {
      const value = templateVariables[varName];
      lines.push(`• ${varName}: ${String(value)} (${typeof value})`);
    });
  } else {
    lines.push('No template variables defined.');
  }

  // Show errors
  if (errors.length > 0) {
    lines.push('', 'Variable Errors:');
    errors.forEach(error => {
      lines.push(`• Line ${error.line}, Column ${error.column}: ${error.message}`);
    });
  }

  lines.push('', 'Variable Syntax:');
  lines.push('• Standard: {VARIABLE_NAME}');
  lines.push('• Environment: $VAR or ${VAR}');
  lines.push('• Variables must be UPPERCASE with underscores');

  return lines.join('\n');
}

function getHelpText(): string {
  return `
Advanced Prompt Editor Help:

Navigation:
• Arrow keys - Move cursor
• Home/End - Start/end of line
• Ctrl+Home/End - Start/end of document
• Page Up/Down - Scroll page

Editing:
• Type normally to insert text
• Enter - Submit prompt
• Ctrl+J - New line (for multiline prompts)
• Backspace/Delete - Remove characters
• Tab - Insert spaces (indentation)

Commands:
• Enter/Ctrl+S - Save and submit
• ESC - Cancel (warns if unsaved)
• F1 - Show this help
• F2 - Toggle template preview (if enabled)
• F3 - Show prompt quality analysis (if enabled)
• F4 - Show template variables

Advanced Features:
• Syntax Highlighting - Highlights template variables, URLs, code, etc.
• Template Variables - Use {VARIABLE_NAME} syntax for substitution
• Token Counting - Real-time token estimation for AI models
• Quality Analysis - Automatic prompt structure and clarity analysis
• Real-time Preview - See how your prompt looks with variables substituted

Template Variables:
• Standard: {VARIABLE_NAME} - Must be UPPERCASE with underscores
• Environment: $VAR or ${VAR} - Access environment variables
• Variables are highlighted in green (valid) or red (undefined)

The editor supports multi-line prompts with advanced AI-specific features.
Your prompt will be optimized for the best AI interaction results.
  `.trim();
}

export default PromptEditor;