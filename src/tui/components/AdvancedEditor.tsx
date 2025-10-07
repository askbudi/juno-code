/**
 * AdvancedEditor Component for juno-task-ts
 *
 * Enhanced multiline text editor with sophisticated keyboard shortcuts.
 * Provides advanced editing capabilities like Ctrl+J, Ctrl+K, Ctrl+U, etc.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

export interface Position {
  line: number;
  column: number;
}

export interface Selection {
  start: Position;
  end: Position;
}

export interface AdvancedEditorProps {
  /** Current text value */
  value: string;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Callback when text changes */
  onChange: (value: string, cursor: Position) => void;
  /** Callback when Enter is pressed (without Ctrl) */
  onSubmit?: (value: string) => void;
  /** Whether the editor is focused */
  focus?: boolean;
  /** Number of spaces for tab indentation */
  tabSize?: number;
  /** Show line numbers */
  showLineNumbers?: boolean;
  /** Maximum number of lines to display */
  maxLines?: number;
  /** Minimum number of lines to display */
  minLines?: number;
}

export const AdvancedEditor: React.FC<AdvancedEditorProps> = ({
  value,
  placeholder = 'Type your text...',
  onChange,
  onSubmit,
  focus = true,
  tabSize = 2,
  showLineNumbers = false,
  maxLines = 20,
  minLines = 3
}) => {
  const [cursorPosition, setCursorPosition] = useState<Position>({ line: 0, column: 0 });
  const [selection, setSelection] = useState<Selection | null>(null);

  // Split text into lines for easier manipulation
  const lines = useMemo(() => value.split('\n'), [value]);

  // Calculate cursor position from flat string position
  const getCursorFromPosition = useCallback((pos: number): Position => {
    let currentPos = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineLength = lines[lineIndex].length;
      if (currentPos + lineLength >= pos) {
        return { line: lineIndex, column: pos - currentPos };
      }
      currentPos += lineLength + 1; // +1 for newline character
    }
    return { line: lines.length - 1, column: lines[lines.length - 1]?.length || 0 };
  }, [lines]);

  // Calculate flat string position from cursor position
  const getPositionFromCursor = useCallback((cursor: Position): number => {
    let position = 0;
    for (let i = 0; i < cursor.line && i < lines.length; i++) {
      position += lines[i].length + 1; // +1 for newline
    }
    position += Math.min(cursor.column, lines[cursor.line]?.length || 0);
    return position;
  }, [lines]);

  // Update cursor position when value changes externally
  useEffect(() => {
    const maxLine = Math.max(0, lines.length - 1);
    const maxColumn = lines[cursorPosition.line]?.length || 0;

    if (cursorPosition.line > maxLine || cursorPosition.column > maxColumn) {
      const newCursor = {
        line: Math.min(cursorPosition.line, maxLine),
        column: Math.min(cursorPosition.column, maxColumn)
      };
      setCursorPosition(newCursor);
    }
  }, [value, lines, cursorPosition]);

  // Insert text at current cursor position
  const insertText = useCallback((text: string) => {
    const position = getPositionFromCursor(cursorPosition);
    const newValue = value.slice(0, position) + text + value.slice(position);
    const newCursor = getCursorFromPosition(position + text.length);

    setCursorPosition(newCursor);
    onChange(newValue, newCursor);
  }, [value, cursorPosition, getPositionFromCursor, getCursorFromPosition, onChange]);

  // Delete text in range
  const deleteText = useCallback((start: number, end: number) => {
    const newValue = value.slice(0, start) + value.slice(end);
    const newCursor = getCursorFromPosition(start);

    setCursorPosition(newCursor);
    onChange(newValue, newCursor);
  }, [value, getCursorFromPosition, onChange]);

  // Get current line text
  const getCurrentLine = useCallback(() => {
    return lines[cursorPosition.line] || '';
  }, [lines, cursorPosition.line]);

  // Move cursor by offset
  const moveCursor = useCallback((deltaLine: number, deltaColumn?: number) => {
    const newLine = Math.max(0, Math.min(lines.length - 1, cursorPosition.line + deltaLine));
    const targetLine = lines[newLine] || '';
    const newColumn = deltaColumn !== undefined
      ? Math.max(0, Math.min(targetLine.length, deltaColumn))
      : Math.max(0, Math.min(targetLine.length, cursorPosition.column));

    const newCursor = { line: newLine, column: newColumn };
    setCursorPosition(newCursor);
    onChange(value, newCursor);
  }, [lines, cursorPosition, value, onChange]);

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (!focus) return;

    // Handle regular character input
    if (input && !key.ctrl && !key.meta && !key.alt) {
      // Clear selection if exists
      if (selection) {
        const startPos = getPositionFromCursor(selection.start);
        const endPos = getPositionFromCursor(selection.end);
        deleteText(Math.min(startPos, endPos), Math.max(startPos, endPos));
        setSelection(null);
      } else {
        insertText(input);
      }
      return;
    }

    // Handle special keys
    if (key.return) {
      if (key.ctrl) {
        // Ctrl+Enter: Insert newline without submitting
        insertText('\n');
      } else {
        // Enter: Submit if onSubmit is provided
        if (onSubmit) {
          onSubmit(value);
        } else {
          insertText('\n');
        }
      }
      return;
    }

    // Handle Ctrl+J: Insert newline (don't submit)
    if (key.ctrl && input === 'j') {
      insertText('\n');
      return;
    }

    // Handle Ctrl+K: Delete from cursor to end of line
    if (key.ctrl && input === 'k') {
      const currentLine = getCurrentLine();
      const lineStart = getPositionFromCursor({ line: cursorPosition.line, column: 0 });
      const lineEnd = lineStart + currentLine.length;
      const cursorPos = getPositionFromCursor(cursorPosition);

      deleteText(cursorPos, lineEnd);
      return;
    }

    // Handle Ctrl+U: Delete from cursor to beginning of line
    if (key.ctrl && input === 'u') {
      const lineStart = getPositionFromCursor({ line: cursorPosition.line, column: 0 });
      const cursorPos = getPositionFromCursor(cursorPosition);

      deleteText(lineStart, cursorPos);
      return;
    }

    // Handle Ctrl+A: Select all
    if (key.ctrl && input === 'a') {
      setSelection({
        start: { line: 0, column: 0 },
        end: { line: lines.length - 1, column: lines[lines.length - 1]?.length || 0 }
      });
      return;
    }

    // Handle Ctrl+D: Duplicate current line
    if (key.ctrl && input === 'd') {
      const currentLine = getCurrentLine();
      const lineEnd = getPositionFromCursor({
        line: cursorPosition.line,
        column: currentLine.length
      });

      insertText('\n' + currentLine);
      return;
    }

    // Handle Tab: Insert spaces or indent
    if (key.tab && !key.shift) {
      const indent = ' '.repeat(tabSize);
      insertText(indent);
      return;
    }

    // Handle Shift+Tab: Unindent
    if (key.tab && key.shift) {
      const currentLine = getCurrentLine();
      const leadingSpaces = currentLine.match(/^ */)?.[0] || '';
      const spacesToRemove = Math.min(leadingSpaces.length, tabSize);

      if (spacesToRemove > 0) {
        const lineStart = getPositionFromCursor({ line: cursorPosition.line, column: 0 });
        deleteText(lineStart, lineStart + spacesToRemove);
      }
      return;
    }

    // Handle arrow keys
    if (key.leftArrow) {
      if (cursorPosition.column > 0) {
        moveCursor(0, cursorPosition.column - 1);
      } else if (cursorPosition.line > 0) {
        moveCursor(-1, lines[cursorPosition.line - 1]?.length || 0);
      }
      return;
    }

    if (key.rightArrow) {
      const currentLine = getCurrentLine();
      if (cursorPosition.column < currentLine.length) {
        moveCursor(0, cursorPosition.column + 1);
      } else if (cursorPosition.line < lines.length - 1) {
        moveCursor(1, 0);
      }
      return;
    }

    if (key.upArrow) {
      if (cursorPosition.line > 0) {
        moveCursor(-1);
      }
      return;
    }

    if (key.downArrow) {
      if (cursorPosition.line < lines.length - 1) {
        moveCursor(1);
      }
      return;
    }

    // Handle backspace
    if (key.backspace) {
      if (selection) {
        const startPos = getPositionFromCursor(selection.start);
        const endPos = getPositionFromCursor(selection.end);
        deleteText(Math.min(startPos, endPos), Math.max(startPos, endPos));
        setSelection(null);
      } else {
        const cursorPos = getPositionFromCursor(cursorPosition);
        if (cursorPos > 0) {
          deleteText(cursorPos - 1, cursorPos);
        }
      }
      return;
    }

    // Handle delete
    if (key.delete) {
      if (selection) {
        const startPos = getPositionFromCursor(selection.start);
        const endPos = getPositionFromCursor(selection.end);
        deleteText(Math.min(startPos, endPos), Math.max(startPos, endPos));
        setSelection(null);
      } else {
        const cursorPos = getPositionFromCursor(cursorPosition);
        if (cursorPos < value.length) {
          deleteText(cursorPos, cursorPos + 1);
        }
      }
      return;
    }
  });

  // Helper function to render cursor
  const renderCursor = useCallback((lineIndex: number, columnIndex: number): string => {
    if (lineIndex === cursorPosition.line && columnIndex === cursorPosition.column) {
      return '█'; // Block cursor
    }
    return '';
  }, [cursorPosition]);

  // Helper function to check if position is selected
  const isSelected = useCallback((lineIndex: number, columnIndex: number): boolean => {
    if (!selection) return false;

    const pos = { line: lineIndex, column: columnIndex };
    const startPos = getPositionFromCursor(selection.start);
    const endPos = getPositionFromCursor(selection.end);
    const currentPos = getPositionFromCursor(pos);

    return currentPos >= Math.min(startPos, endPos) && currentPos < Math.max(startPos, endPos);
  }, [selection, getPositionFromCursor]);

  // Render empty state
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return (
      <Box flexDirection="column" minHeight={minLines}>
        <Box>
          {showLineNumbers && <Text color="dim">1 </Text>}
          <Text color="dim">{placeholder}</Text>
          {cursorPosition.line === 0 && cursorPosition.column === 0 && (
            <Text color="blue">█</Text>
          )}
        </Box>
      </Box>
    );
  }

  // Render lines with cursor and selection
  const displayLines = lines.slice(0, maxLines);
  const totalLines = Math.max(displayLines.length, minLines);

  return (
    <Box flexDirection="column" minHeight={totalLines}>
      {Array.from({ length: totalLines }).map((_, lineIndex) => {
        const line = displayLines[lineIndex] || '';
        const lineNumber = lineIndex + 1;

        return (
          <Box key={lineIndex} flexDirection="row">
            {showLineNumbers && (
              <Text color="dim" marginRight={1}>
                {lineNumber.toString().padStart(2, ' ')}
              </Text>
            )}
            <Box>
              {line.length === 0 ? (
                // Empty line
                <Text>
                  {renderCursor(lineIndex, 0)}
                </Text>
              ) : (
                // Line with content
                line.split('').map((char, charIndex) => (
                  <Text
                    key={charIndex}
                    backgroundColor={isSelected(lineIndex, charIndex) ? 'blue' : undefined}
                    color={isSelected(lineIndex, charIndex) ? 'white' : undefined}
                  >
                    {char}
                    {renderCursor(lineIndex, charIndex + 1)}
                  </Text>
                ))
              )}
              {/* Cursor at end of line */}
              {cursorPosition.line === lineIndex && cursorPosition.column === line.length && (
                <Text color="blue">█</Text>
              )}
            </Box>
          </Box>
        );
      })}

      {/* Help text */}
      <Box marginTop={1} borderTopStyle="single" paddingTop={1}>
        <Text color="dim">
          Ctrl+J New line • Ctrl+K Delete to end • Ctrl+U Delete to start • Ctrl+A Select all • Tab/Shift+Tab Indent
        </Text>
      </Box>
    </Box>
  );
};

export default AdvancedEditor;