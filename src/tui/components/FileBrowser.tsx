/**
 * FileBrowser Component for juno-task-ts
 *
 * Interactive file system browser component with tree view navigation.
 * Provides keyboard navigation, file type indicators, and quick search.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { fileTypeFromFile } from 'file-type';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: Date;
  children?: FileNode[];
  isExpanded?: boolean;
  parent?: FileNode;
}

export interface FileBrowserProps {
  /** Starting directory path */
  currentPath: string;
  /** Currently selected file/directory path */
  selectedPath?: string;
  /** Show hidden files (starting with .) */
  showHidden?: boolean;
  /** File filter function */
  fileFilter?: (path: string) => boolean;
  /** Callback when user selects a file/directory */
  onSelect: (path: string, node: FileNode) => void;
  /** Callback when user cancels */
  onCancel: () => void;
  /** Maximum depth to scan initially */
  maxDepth?: number;
  /** Show file sizes */
  showSizes?: boolean;
  /** Show file previews for small files */
  showPreview?: boolean;
  /** Maximum lines for file preview */
  previewLines?: number;
}

interface TreeState {
  nodes: FileNode[];
  selectedIndex: number;
  searchQuery: string;
  filteredNodes: FileNode[];
  expandedPaths: Set<string>;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  currentPath,
  selectedPath,
  showHidden = false,
  fileFilter,
  onSelect,
  onCancel,
  maxDepth = 2,
  showSizes = true,
  showPreview = false,
  previewLines = 5
}) => {
  const [treeState, setTreeState] = useState<TreeState>({
    nodes: [],
    selectedIndex: 0,
    searchQuery: '',
    filteredNodes: [],
    expandedPaths: new Set([currentPath])
  });
  const [isLoading, setIsLoading] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);

  // Scan file system and build tree
  const scanFileSystem = useCallback(async (rootPath: string, depth: number = 0): Promise<FileNode[]> => {
    if (depth > maxDepth) return [];

    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      const nodes: FileNode[] = [];

      for (const entry of entries) {
        // Skip hidden files if not showing them
        if (!showHidden && entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(rootPath, entry.name);

        // Apply file filter if provided
        if (fileFilter && !fileFilter(fullPath)) {
          continue;
        }

        try {
          const stats = await fs.stat(fullPath);
          const node: FileNode = {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime,
            isExpanded: false
          };

          // Recursively scan directories
          if (entry.isDirectory() && depth < maxDepth) {
            node.children = await scanFileSystem(fullPath, depth + 1);
            // Set parent references
            node.children.forEach(child => {
              child.parent = node;
            });
          }

          nodes.push(node);
        } catch (statError) {
          // Skip files we can't stat
          continue;
        }
      }

      // Sort: directories first, then files, both alphabetically
      return nodes.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      console.error(`Error scanning directory ${rootPath}:`, error);
      return [];
    }
  }, [maxDepth, showHidden, fileFilter]);

  // Flatten tree for display and navigation
  const flattenTree = useCallback((nodes: FileNode[], expandedPaths: Set<string>): FileNode[] => {
    const flattened: FileNode[] = [];

    const addNode = (node: FileNode, depth: number = 0) => {
      // Add current node
      flattened.push({ ...node, depth } as FileNode & { depth: number });

      // Add children if directory is expanded
      if (node.type === 'directory' && expandedPaths.has(node.path) && node.children) {
        node.children.forEach(child => addNode(child, depth + 1));
      }
    };

    nodes.forEach(node => addNode(node));
    return flattened;
  }, []);

  // Filter nodes based on search query
  const filterNodes = useCallback((nodes: FileNode[], query: string): FileNode[] => {
    if (!query) return nodes;

    return nodes.filter(node =>
      node.name.toLowerCase().includes(query.toLowerCase()) ||
      node.path.toLowerCase().includes(query.toLowerCase())
    );
  }, []);

  // Initialize file system scan
  useEffect(() => {
    const initializeTree = async () => {
      setIsLoading(true);
      try {
        const nodes = await scanFileSystem(currentPath);
        setTreeState(prev => ({
          ...prev,
          nodes,
          filteredNodes: filterNodes(flattenTree(nodes, prev.expandedPaths), prev.searchQuery)
        }));
      } catch (error) {
        console.error('Error initializing file browser:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeTree();
  }, [currentPath, scanFileSystem, flattenTree, filterNodes]);

  // Update filtered nodes when search query or tree changes
  useEffect(() => {
    const flattened = flattenTree(treeState.nodes, treeState.expandedPaths);
    const filtered = filterNodes(flattened, treeState.searchQuery);

    setTreeState(prev => ({
      ...prev,
      filteredNodes: filtered,
      selectedIndex: Math.min(prev.selectedIndex, Math.max(0, filtered.length - 1))
    }));
  }, [treeState.nodes, treeState.expandedPaths, treeState.searchQuery, flattenTree, filterNodes]);

  // Load file preview
  const loadPreview = useCallback(async (filePath: string) => {
    if (!showPreview) return;

    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 10000) { // Don't preview large files
        setPreview('File too large for preview');
        return;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, previewLines);
      setPreview(lines.join('\n'));
    } catch (error) {
      setPreview('Cannot preview this file');
    }
  }, [showPreview, previewLines]);

  // Update preview when selection changes
  useEffect(() => {
    const selectedNode = treeState.filteredNodes[treeState.selectedIndex];
    if (selectedNode && selectedNode.type === 'file') {
      loadPreview(selectedNode.path);
    } else {
      setPreview(null);
    }
  }, [treeState.selectedIndex, treeState.filteredNodes, loadPreview]);

  // Handle keyboard input
  useInput((input, key) => {
    // Handle search input
    if (input && !key.ctrl && !key.meta && !key.alt && !key.return && !key.escape) {
      setTreeState(prev => ({
        ...prev,
        searchQuery: prev.searchQuery + input
      }));
      return;
    }

    // Handle backspace in search
    if (key.backspace && treeState.searchQuery) {
      setTreeState(prev => ({
        ...prev,
        searchQuery: prev.searchQuery.slice(0, -1)
      }));
      return;
    }

    // Handle navigation
    if (key.upArrow) {
      setTreeState(prev => ({
        ...prev,
        selectedIndex: Math.max(0, prev.selectedIndex - 1)
      }));
      return;
    }

    if (key.downArrow) {
      setTreeState(prev => ({
        ...prev,
        selectedIndex: Math.min(prev.filteredNodes.length - 1, prev.selectedIndex + 1)
      }));
      return;
    }

    // Handle selection
    if (key.return) {
      const selectedNode = treeState.filteredNodes[treeState.selectedIndex];
      if (selectedNode) {
        if (selectedNode.type === 'directory') {
          // Toggle directory expansion
          setTreeState(prev => {
            const newExpandedPaths = new Set(prev.expandedPaths);
            if (newExpandedPaths.has(selectedNode.path)) {
              newExpandedPaths.delete(selectedNode.path);
            } else {
              newExpandedPaths.add(selectedNode.path);
            }
            return { ...prev, expandedPaths: newExpandedPaths };
          });
        } else {
          // Select file
          onSelect(selectedNode.path, selectedNode);
        }
      }
      return;
    }

    // Handle cancel
    if (key.escape) {
      onCancel();
      return;
    }

    // Handle clear search
    if (key.ctrl && input === 'c') {
      setTreeState(prev => ({ ...prev, searchQuery: '' }));
      return;
    }
  });

  // Helper function to get file type icon
  const getFileIcon = (node: FileNode): string => {
    if (node.type === 'directory') {
      return (treeState.expandedPaths.has(node.path) ? '📂' : '📁');
    }

    const ext = path.extname(node.name).toLowerCase();
    switch (ext) {
      case '.md': return '📝';
      case '.js': case '.ts': case '.jsx': case '.tsx': return '💻';
      case '.json': return '⚙️';
      case '.txt': return '📄';
      case '.png': case '.jpg': case '.jpeg': case '.gif': return '🖼️';
      case '.pdf': return '📕';
      case '.zip': case '.tar': case '.gz': return '📦';
      case '.css': case '.scss': case '.sass': return '🎨';
      case '.html': case '.htm': return '🌐';
      case '.py': return '🐍';
      case '.go': return '🐹';
      case '.rs': return '🦀';
      default: return '📄';
    }
  };

  // Helper function to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round(bytes / Math.pow(1024, i) * 10) / 10} ${sizes[i]}`;
  };

  // Helper function to get indentation for tree structure
  const getIndentation = (node: FileNode & { depth?: number }): string => {
    const depth = node.depth || 0;
    return '  '.repeat(depth);
  };

  if (isLoading) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
        <Text color="blue" bold>📁 File Browser</Text>
        <Text color="yellow">Loading file system...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height={20}>
      {/* File tree */}
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="blue" padding={1}>
        <Box marginBottom={1}>
          <Text color="blue" bold>📁 File Browser</Text>
          {treeState.searchQuery && (
            <Text color="yellow" marginLeft={1}>
              Filter: "{treeState.searchQuery}"
            </Text>
          )}
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          {treeState.filteredNodes.length === 0 ? (
            <Text color="dim">No files found</Text>
          ) : (
            treeState.filteredNodes.map((node, index) => {
              const isSelected = index === treeState.selectedIndex;
              const nodeWithDepth = node as FileNode & { depth?: number };

              return (
                <Box key={node.path} flexDirection="row">
                  <Text
                    color={isSelected ? 'black' : 'white'}
                    backgroundColor={isSelected ? 'blue' : undefined}
                  >
                    {getIndentation(nodeWithDepth)}
                    {getFileIcon(node)} {node.name}
                  </Text>
                  {showSizes && node.type === 'file' && (
                    <Text color="dim" marginLeft={1}>
                      ({formatFileSize(node.size)})
                    </Text>
                  )}
                </Box>
              );
            })
          )}
        </Box>

        <Box marginTop={1} borderTopStyle="single" paddingTop={1}>
          <Text color="dim">
            ↑↓ Navigate • Enter Select/Expand • Esc Cancel • Type to filter
          </Text>
        </Box>
      </Box>

      {/* File preview */}
      {showPreview && preview && (
        <Box
          flexDirection="column"
          marginLeft={1}
          borderStyle="round"
          borderColor="gray"
          padding={1}
          width={40}
        >
          <Text color="gray" bold>Preview</Text>
          <Text>{preview}</Text>
        </Box>
      )}
    </Box>
  );
};

export default FileBrowser;