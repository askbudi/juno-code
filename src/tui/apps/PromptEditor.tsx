/**
 * TUI Prompt Editor for juno-task-ts
 *
 * Rich text editor for creating and editing prompts with syntax highlighting,
 * line numbers, and advanced editing features. Integrates with --interactive-prompt.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import { TUIApp } from './TUIApp.js';
import { Input } from '../components/Input.js';
import { Dialog } from '../components/Dialog.js';
import { useTUIContext } from '../apps/TUIApp.js';
import { useKeyboard, useNavigationKeys } from '../hooks/useKeyboard.js';
import { useTUIState } from '../hooks/useTUIState.js';
import type { PromptEditorProps, PromptEditorState } from '../types.js';

/**
 * Advanced prompt editor with rich features
 */
export const PromptEditor: React.FC<PromptEditorProps> = ({
  initialValue = '',
  onSubmit,
  onCancel,
  showHelp = true,
  enableSyntaxHighlighting = false,
  maxLength = 10000,
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

  // Calculate editor dimensions
  const editorHeight = dimensions.height - 8; // Leave space for header, footer, etc.
  const editorWidth = dimensions.width - 4; // Leave space for borders

  // Split text into lines
  const lines = text.split('\n');
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
        insertText('\n');
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
          if (showingHelp) {
            setShowingHelp(false);
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
        key: 'ctrl+s',
        handler: () => {
          if (text.trim()) {
            onSubmit(text);
          }
        }
      },
      {
        key: 'ctrl+return',
        handler: () => {
          if (text.trim()) {
            onSubmit(text);
          }
        }
      }
    ]
  });

  // Render visible lines
  const visibleLines = lines.slice(viewportStart, viewportStart + editorHeight);
  const lineNumberWidth = String(lines.length).length + 1;

  return (
    <TUIApp
      title="Prompt Editor"
      exitOnEscape={false}
      testId={testId}
    >
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text color={theme.text}>
            Line {currentLineIndex + 1}, Column {currentColumnIndex + 1}
          </Text>
        </Box>
        <Box>
          <Text color={isDirty ? theme.warning : theme.muted}>
            {isDirty ? '(modified)' : '(saved)'}
          </Text>
          <Text color={theme.muted}> | </Text>
          <Text color={theme.muted}>
            {text.length}/{maxLength} chars
          </Text>
        </Box>
      </Box>

      {/* Editor area */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.primary}
        width="100%"
        height={editorHeight + 2}
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
            <Box key={actualLineIndex}>
              {/* Line number */}
              <Text color={theme.muted} width={lineNumberWidth}>
                {String(actualLineIndex + 1).padStart(lineNumberWidth - 1, ' ')}
              </Text>

              {/* Line content */}
              <Text color={isCurrentLine ? theme.text : theme.muted}>
                {enableSyntaxHighlighting ? highlightSyntax(displayLine) : displayLine}
                {isCurrentLine && (
                  <Text inverse>{cursorChar}</Text>
                )}
              </Text>
            </Box>
          );
        })}

        {/* Empty editor message */}
        {lines.length === 1 && lines[0] === '' && (
          <Box justifyContent="center" alignItems="center" height={editorHeight}>
            <Text color={theme.muted}>Start typing your prompt...</Text>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} justifyContent="space-between">
        <Box>
          <Text color={theme.muted}>
            Ctrl+S or Ctrl+Enter to submit • ESC to cancel • F1 for help
          </Text>
        </Box>
        <Box>
          <Text color={theme.muted}>
            {showingHelp ? 'Help mode' : 'Edit mode'}
          </Text>
        </Box>
      </Box>

      {/* Help dialog */}
      {showHelp && (
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

function highlightSyntax(text: string): string {
  // Basic syntax highlighting for prompts
  // This is a simple implementation - can be enhanced

  // Highlight URLs
  text = text.replace(
    /(https?:\/\/[^\s]+)/g,
    '\x1b[34m$1\x1b[39m' // Blue
  );

  // Highlight file paths
  text = text.replace(
    /(\/[^\s]*|[A-Za-z]:[^\s]*)/g,
    '\x1b[33m$1\x1b[39m' // Yellow
  );

  // Highlight code blocks (simple)
  text = text.replace(
    /(`[^`]+`)/g,
    '\x1b[32m$1\x1b[39m' // Green
  );

  return text;
}

function getHelpText(): string {
  return `
Prompt Editor Help:

Navigation:
• Arrow keys - Move cursor
• Home/End - Start/end of line
• Ctrl+Home/End - Start/end of document
• Page Up/Down - Scroll page

Editing:
• Type normally to insert text
• Backspace/Delete - Remove characters
• Tab - Insert spaces (indentation)
• Enter - New line

Commands:
• Ctrl+S - Save and submit
• Ctrl+Enter - Save and submit
• ESC - Cancel (warns if unsaved)
• F1 - Show this help

The editor supports multi-line prompts with unlimited length.
Your prompt will be used as the instruction for the selected subagent.
  `.trim();
}

export default PromptEditor;