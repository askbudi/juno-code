/**
 * MentionAutocomplete Component for juno-task-ts
 *
 * Provides @ symbol file/folder mention system with autocomplete functionality.
 * Triggers when users type @ in text inputs and provides fuzzy file/folder search.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import Fuse from 'fuse.js';
import { fileTypeFromFile } from 'file-type';

export interface MentionOption {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  isRelative: boolean;
}

export interface MentionAutocompleteProps {
  /** Current working directory for relative path resolution */
  workingDirectory: string;
  /** Text content up to cursor position */
  textBeforeCursor: string;
  /** Position where @ was typed */
  triggerPosition: number;
  /** Callback when user selects an option */
  onSelect: (option: MentionOption) => void;
  /** Callback when user cancels */
  onCancel: () => void;
  /** Maximum number of suggestions to show */
  maxSuggestions?: number;
  /** File patterns to include (e.g., ['*.md', '*.txt']) */
  includePatterns?: string[];
  /** Patterns to exclude (e.g., ['node_modules', '.git']) */
  excludePatterns?: string[];
  /** Maximum search depth */
  maxDepth?: number;
}

interface FileSystemItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: Date;
  extension?: string;
}

export const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  workingDirectory,
  textBeforeCursor,
  triggerPosition,
  onSelect,
  onCancel,
  maxSuggestions = 10,
  includePatterns = ['*'],
  excludePatterns = ['node_modules', '.git', '.DS_Store', 'dist', 'build'],
  maxDepth = 3
}) => {
  const [suggestions, setSuggestions] = useState<MentionOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Extract search query from text after @
  useEffect(() => {
    const textAfterAt = textBeforeCursor.slice(triggerPosition + 1);
    const match = textAfterAt.match(/^([^\s]*)/);
    setSearchQuery(match ? match[1] : '');
  }, [textBeforeCursor, triggerPosition]);

  // Scan file system and create suggestions
  const scanFileSystem = useCallback(async (query: string): Promise<FileSystemItem[]> => {
    const items: FileSystemItem[] = [];

    const scanDirectory = async (dirPath: string, depth: number = 0): Promise<void> => {
      if (depth > maxDepth) return;

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(workingDirectory, fullPath);

          // Skip excluded patterns
          if (excludePatterns.some(pattern => entry.name.includes(pattern) || relativePath.includes(pattern))) {
            continue;
          }

          try {
            const stats = await fs.stat(fullPath);

            if (entry.isDirectory()) {
              items.push({
                path: fullPath,
                name: entry.name,
                type: 'directory',
                size: 0,
                modified: stats.mtime
              });

              // Recursively scan subdirectories
              if (depth < maxDepth) {
                await scanDirectory(fullPath, depth + 1);
              }
            } else if (entry.isFile()) {
              const extension = path.extname(entry.name);

              // Check include patterns
              const shouldInclude = includePatterns.some(pattern => {
                if (pattern === '*') return true;
                if (pattern.startsWith('*.')) {
                  return extension === pattern.slice(1);
                }
                return entry.name.includes(pattern);
              });

              if (shouldInclude) {
                items.push({
                  path: fullPath,
                  name: entry.name,
                  type: 'file',
                  size: stats.size,
                  modified: stats.mtime,
                  extension: extension || undefined
                });
              }
            }
          } catch (statError) {
            // Skip files we can't stat (permission issues, etc.)
            continue;
          }
        }
      } catch (dirError) {
        // Skip directories we can't read
        return;
      }
    };

    // Start scanning from working directory
    await scanDirectory(workingDirectory);

    // Also include some parent directory files if query suggests it
    if (query.startsWith('../') || query.startsWith('./')) {
      const parentDir = path.dirname(workingDirectory);
      if (parentDir !== workingDirectory) {
        await scanDirectory(parentDir, 0);
      }
    }

    return items;
  }, [workingDirectory, maxDepth, includePatterns, excludePatterns]);

  // Create fuzzy search and filter suggestions
  const fuseOptions = useMemo(() => ({
    keys: ['name', 'path'],
    threshold: 0.4,
    distance: 100,
    includeScore: true
  }), []);

  useEffect(() => {
    const updateSuggestions = async () => {
      if (!searchQuery && searchQuery !== '') return;

      setIsLoading(true);
      try {
        const items = await scanFileSystem(searchQuery);

        if (searchQuery) {
          // Use fuzzy search for filtering
          const fuse = new Fuse(items, fuseOptions);
          const results = fuse.search(searchQuery);
          const filteredItems = results.map(result => result.item);

          const suggestions: MentionOption[] = filteredItems.slice(0, maxSuggestions).map(item => ({
            path: item.path,
            name: item.name,
            type: item.type,
            size: item.size,
            extension: item.extension,
            isRelative: !path.isAbsolute(item.path)
          }));

          setSuggestions(suggestions);
        } else {
          // Show recent/common files when no query
          const recentFiles = items
            .sort((a, b) => b.modified.getTime() - a.modified.getTime())
            .slice(0, maxSuggestions)
            .map(item => ({
              path: item.path,
              name: item.name,
              type: item.type,
              size: item.size,
              extension: item.extension,
              isRelative: !path.isAbsolute(item.path)
            }));

          setSuggestions(recentFiles);
        }

        setSelectedIndex(0);
      } catch (error) {
        console.error('Error scanning file system:', error);
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    };

    updateSuggestions();
  }, [searchQuery, scanFileSystem, fuseOptions, maxSuggestions]);

  // Handle keyboard input
  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex(prev => Math.min(suggestions.length - 1, prev + 1));
    } else if (key.return) {
      if (suggestions[selectedIndex]) {
        const selected = suggestions[selectedIndex];
        onSelect(selected);
      }
    } else if (key.escape) {
      onCancel();
    }
  });

  // Helper function to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round(bytes / Math.pow(1024, i) * 10) / 10} ${sizes[i]}`;
  };

  // Helper function to get file type icon
  const getFileIcon = (option: MentionOption): string => {
    if (option.type === 'directory') return '📁';

    const ext = option.extension?.toLowerCase();
    switch (ext) {
      case '.md': return '📝';
      case '.js': case '.ts': case '.jsx': case '.tsx': return '💻';
      case '.json': return '⚙️';
      case '.txt': return '📄';
      case '.png': case '.jpg': case '.jpeg': case '.gif': return '🖼️';
      case '.pdf': return '📕';
      default: return '📄';
    }
  };

  // Helper function to format path for display
  const formatDisplayPath = (option: MentionOption): string => {
    const relativePath = path.relative(workingDirectory, option.path);
    if (relativePath.startsWith('../')) {
      return relativePath;
    }
    return `./${relativePath}`;
  };

  if (suggestions.length === 0 && !isLoading) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1}>
        <Text color="gray">No files found matching "{searchQuery}"</Text>
        <Text color="dim">Press Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
      <Box marginBottom={1}>
        <Text color="blue" bold>📎 File/Folder Suggestions</Text>
        {isLoading && <Text color="yellow"> (Loading...)</Text>}
      </Box>

      {suggestions.map((option, index) => (
        <Box key={option.path} flexDirection="row" paddingLeft={1}>
          <Text
            color={index === selectedIndex ? 'black' : 'white'}
            backgroundColor={index === selectedIndex ? 'blue' : undefined}
          >
            {getFileIcon(option)} {option.name}
          </Text>
          <Text color="gray" marginLeft={1}>
            {formatDisplayPath(option)}
          </Text>
          {option.type === 'file' && option.size && (
            <Text color="dim" marginLeft={1}>
              ({formatFileSize(option.size)})
            </Text>
          )}
        </Box>
      ))}

      <Box marginTop={1} borderTopStyle="single" paddingTop={1}>
        <Text color="dim">
          ↑↓ Navigate • Enter Select • Esc Cancel
        </Text>
      </Box>
    </Box>
  );
};

export default MentionAutocomplete;