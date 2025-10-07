/**
 * Rich Formatting System for juno-task-ts
 *
 * Enhanced terminal formatting to match Python Rich library aesthetics.
 * Provides tables, panels, trees, and sophisticated styling.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import supportsColor from 'supports-color';

// ============================================================================
// Core Interfaces
// ============================================================================

export interface TableData {
  headers?: string[];
  rows: string[][];
}

export interface TableOptions {
  title?: string;
  headers?: string[];
  borders?: 'ascii' | 'rounded' | 'double' | 'heavy' | 'minimal';
  style?: 'default' | 'minimal' | 'markdown' | 'grid';
  width?: number;
  columnWidths?: number[];
  align?: ('left' | 'center' | 'right')[];
  colors?: {
    headers?: string;
    border?: string;
    title?: string;
  };
}

export interface PanelOptions {
  title?: string;
  border?: 'rounded' | 'square' | 'double' | 'heavy' | 'minimal';
  padding?: number;
  width?: number;
  style?: 'default' | 'info' | 'warning' | 'error' | 'success';
  align?: 'left' | 'center' | 'right';
  colors?: {
    border?: string;
    title?: string;
    content?: string;
  };
}

export interface TreeData {
  name: string;
  children?: TreeData[];
  metadata?: Record<string, any>;
  icon?: string;
  style?: string;
}

export interface TreeOptions {
  showFiles?: boolean;
  showMetadata?: boolean;
  maxDepth?: number;
  icons?: boolean;
  colors?: {
    directory?: string;
    file?: string;
    metadata?: string;
  };
}

export interface ProgressBarOptions {
  width?: number;
  completed?: string;
  incomplete?: string;
  showPercentage?: boolean;
  showBar?: boolean;
  style?: 'bar' | 'blocks' | 'dots' | 'gradient';
  colors?: {
    completed?: string;
    incomplete?: string;
    percentage?: string;
  };
}

// ============================================================================
// Rich Formatter Class
// ============================================================================

export class RichFormatter {
  private colorSupport: boolean;
  private terminalWidth: number;

  constructor() {
    this.colorSupport = supportsColor.stdout ? true : false;
    this.terminalWidth = process.stdout.columns || 80;
  }

  /**
   * Create a rich table with styling and borders
   */
  table(data: TableData, options: TableOptions = {}): string {
    const table = new Table(this.getTableConfig(options));

    // Add headers if provided
    if (options.headers || data.headers) {
      const headers = options.headers || data.headers || [];
      if (options.colors?.headers && this.colorSupport) {
        const coloredHeaders = headers.map(header =>
          chalk.keyword(options.colors!.headers!)(header)
        );
        table.push(coloredHeaders);
      }
    }

    // Add data rows
    data.rows.forEach(row => {
      table.push(row);
    });

    let result = table.toString();

    // Add title if provided
    if (options.title) {
      const titleColor = options.colors?.title || 'blue';
      const coloredTitle = this.colorSupport
        ? chalk.keyword(titleColor).bold(options.title)
        : options.title;

      const titleLine = this.centerText(coloredTitle, this.getTableWidth(options));
      result = titleLine + '\n' + result;
    }

    return result;
  }

  /**
   * Create a rich panel with borders and styling
   */
  panel(content: string, options: PanelOptions = {}): string {
    const {
      title,
      border = 'rounded',
      padding = 1,
      width = this.terminalWidth - 4,
      style = 'default',
      align = 'left'
    } = options;

    const borderChars = this.getBorderChars(border);
    const styleColors = this.getStyleColors(style);

    // Process content
    const lines = content.split('\n');
    const contentWidth = width - (padding * 2) - 2; // -2 for left/right borders

    const processedLines = lines.flatMap(line => this.wrapText(line, contentWidth));

    // Build panel
    const panelLines: string[] = [];

    // Top border
    const topBorder = borderChars.topLeft +
                     borderChars.horizontal.repeat(width - 2) +
                     borderChars.topRight;
    panelLines.push(this.colorize(topBorder, styleColors.border));

    // Title (if provided)
    if (title) {
      const titleLine = borderChars.vertical +
                       this.centerText(title, width - 2) +
                       borderChars.vertical;
      panelLines.push(this.colorize(titleLine, styleColors.border));

      // Title separator
      const separator = borderChars.left +
                       borderChars.horizontal.repeat(width - 2) +
                       borderChars.right;
      panelLines.push(this.colorize(separator, styleColors.border));
    }

    // Padding (top)
    for (let i = 0; i < padding; i++) {
      const paddingLine = borderChars.vertical +
                         ' '.repeat(width - 2) +
                         borderChars.vertical;
      panelLines.push(this.colorize(paddingLine, styleColors.border));
    }

    // Content lines
    processedLines.forEach(line => {
      const alignedContent = this.alignText(line, contentWidth, align);
      const paddedContent = ' '.repeat(padding) + alignedContent + ' '.repeat(padding);
      const contentLine = borderChars.vertical +
                         paddedContent +
                         borderChars.vertical;

      const coloredContent = this.colorize(borderChars.vertical, styleColors.border) +
                            this.colorize(paddedContent, styleColors.content) +
                            this.colorize(borderChars.vertical, styleColors.border);

      panelLines.push(coloredContent);
    });

    // Padding (bottom)
    for (let i = 0; i < padding; i++) {
      const paddingLine = borderChars.vertical +
                         ' '.repeat(width - 2) +
                         borderChars.vertical;
      panelLines.push(this.colorize(paddingLine, styleColors.border));
    }

    // Bottom border
    const bottomBorder = borderChars.bottomLeft +
                        borderChars.horizontal.repeat(width - 2) +
                        borderChars.bottomRight;
    panelLines.push(this.colorize(bottomBorder, styleColors.border));

    return panelLines.join('\n');
  }

  /**
   * Create a tree view display
   */
  tree(data: TreeData, options: TreeOptions = {}): string {
    const {
      showFiles = true,
      showMetadata = false,
      maxDepth = 10,
      icons = true,
      colors = {
        directory: 'blue',
        file: 'white',
        metadata: 'gray'
      }
    } = options;

    return this.renderTreeNode(data, 0, '', options, true);
  }

  /**
   * Create a progress bar
   */
  progressBar(progress: number, options: ProgressBarOptions = {}): string {
    const {
      width = 40,
      completed = '█',
      incomplete = '░',
      showPercentage = true,
      showBar = true,
      style = 'bar',
      colors = {
        completed: 'green',
        incomplete: 'gray',
        percentage: 'blue'
      }
    } = options;

    progress = Math.max(0, Math.min(100, progress));
    const completedWidth = Math.round((progress / 100) * width);
    const incompleteWidth = width - completedWidth;

    let bar = '';

    if (showBar) {
      const completedPart = this.colorize(completed.repeat(completedWidth), colors.completed);
      const incompletePart = this.colorize(incomplete.repeat(incompleteWidth), colors.incomplete);
      bar = completedPart + incompletePart;
    }

    if (showPercentage) {
      const percentage = this.colorize(`${progress.toFixed(1)}%`, colors.percentage);
      return showBar ? `${bar} ${percentage}` : percentage;
    }

    return bar;
  }

  /**
   * Format markup text with basic styling
   */
  markup(text: string): string {
    if (!this.colorSupport) {
      return text.replace(/\[\/?\w+\]/g, ''); // Remove markup tags
    }

    return text
      .replace(/\[bold\](.*?)\[\/bold\]/g, (_, content) => chalk.bold(content))
      .replace(/\[italic\](.*?)\[\/italic\]/g, (_, content) => chalk.italic(content))
      .replace(/\[underline\](.*?)\[\/underline\]/g, (_, content) => chalk.underline(content))
      .replace(/\[red\](.*?)\[\/red\]/g, (_, content) => chalk.red(content))
      .replace(/\[green\](.*?)\[\/green\]/g, (_, content) => chalk.green(content))
      .replace(/\[blue\](.*?)\[\/blue\]/g, (_, content) => chalk.blue(content))
      .replace(/\[yellow\](.*?)\[\/yellow\]/g, (_, content) => chalk.yellow(content))
      .replace(/\[cyan\](.*?)\[\/cyan\]/g, (_, content) => chalk.cyan(content))
      .replace(/\[magenta\](.*?)\[\/magenta\]/g, (_, content) => chalk.magenta(content))
      .replace(/\[dim\](.*?)\[\/dim\]/g, (_, content) => chalk.dim(content));
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private getTableConfig(options: TableOptions): any {
    const borders = this.getTableBorders(options.borders || 'rounded');

    return {
      chars: borders,
      style: {
        'padding-left': 1,
        'padding-right': 1,
        head: options.colors?.headers ? [options.colors.headers] : ['blue'],
        border: options.colors?.border ? [options.colors.border] : ['gray']
      },
      colWidths: options.columnWidths,
      colAligns: options.align,
      wordWrap: true
    };
  }

  private getTableBorders(style: string): any {
    switch (style) {
      case 'rounded':
        return {
          'top': '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮',
          'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '╰', 'bottom-right': '╯',
          'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
          'right': '│', 'right-mid': '┤', 'middle': '│'
        };
      case 'double':
        return {
          'top': '═', 'top-mid': '╦', 'top-left': '╔', 'top-right': '╗',
          'bottom': '═', 'bottom-mid': '╩', 'bottom-left': '╚', 'bottom-right': '╝',
          'left': '║', 'left-mid': '╠', 'mid': '═', 'mid-mid': '╬',
          'right': '║', 'right-mid': '╣', 'middle': '║'
        };
      case 'heavy':
        return {
          'top': '━', 'top-mid': '┳', 'top-left': '┏', 'top-right': '┓',
          'bottom': '━', 'bottom-mid': '┻', 'bottom-left': '┗', 'bottom-right': '┛',
          'left': '┃', 'left-mid': '┣', 'mid': '━', 'mid-mid': '╋',
          'right': '┃', 'right-mid': '┫', 'middle': '┃'
        };
      case 'minimal':
        return {
          'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
          'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
          'left': '', 'left-mid': '', 'mid': '', 'mid-mid': '',
          'right': '', 'right-mid': '', 'middle': ' '
        };
      default: // ascii
        return {
          'top': '-', 'top-mid': '+', 'top-left': '+', 'top-right': '+',
          'bottom': '-', 'bottom-mid': '+', 'bottom-left': '+', 'bottom-right': '+',
          'left': '|', 'left-mid': '+', 'mid': '-', 'mid-mid': '+',
          'right': '|', 'right-mid': '+', 'middle': '|'
        };
    }
  }

  private getBorderChars(style: string): any {
    switch (style) {
      case 'rounded':
        return {
          topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
          horizontal: '─', vertical: '│', left: '├', right: '┤'
        };
      case 'double':
        return {
          topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝',
          horizontal: '═', vertical: '║', left: '╠', right: '╣'
        };
      case 'heavy':
        return {
          topLeft: '┏', topRight: '┓', bottomLeft: '┗', bottomRight: '┛',
          horizontal: '━', vertical: '┃', left: '┣', right: '┫'
        };
      case 'minimal':
        return {
          topLeft: ' ', topRight: ' ', bottomLeft: ' ', bottomRight: ' ',
          horizontal: ' ', vertical: ' ', left: ' ', right: ' '
        };
      default: // square
        return {
          topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
          horizontal: '─', vertical: '│', left: '├', right: '┤'
        };
    }
  }

  private getStyleColors(style: string): any {
    switch (style) {
      case 'info':
        return { border: 'blue', content: 'white' };
      case 'warning':
        return { border: 'yellow', content: 'yellow' };
      case 'error':
        return { border: 'red', content: 'red' };
      case 'success':
        return { border: 'green', content: 'green' };
      default:
        return { border: 'gray', content: 'white' };
    }
  }

  private colorize(text: string, color?: string): string {
    if (!this.colorSupport || !color) return text;
    return (chalk as any).keyword(color)(text);
  }

  private centerText(text: string, width: number): string {
    const plainText = stripAnsi(text);
    const padding = Math.max(0, width - plainText.length);
    const leftPadding = Math.floor(padding / 2);
    const rightPadding = padding - leftPadding;

    return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
  }

  private alignText(text: string, width: number, align: string): string {
    const plainText = stripAnsi(text);
    const padding = Math.max(0, width - plainText.length);

    switch (align) {
      case 'center':
        return this.centerText(text, width);
      case 'right':
        return ' '.repeat(padding) + text;
      default: // left
        return text + ' '.repeat(padding);
    }
  }

  private wrapText(text: string, width: number): string[] {
    if (stripAnsi(text).length <= width) return [text];

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (stripAnsi(testLine).length <= width) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
    return lines;
  }

  private getTableWidth(options: TableOptions): number {
    return options.width || this.terminalWidth;
  }

  private renderTreeNode(
    node: TreeData,
    depth: number,
    prefix: string,
    options: TreeOptions,
    isLast: boolean = false
  ): string {
    if (depth > (options.maxDepth || 10)) return '';

    const { icons = true, colors = {} } = options;
    const lines: string[] = [];

    // Current node
    const connector = isLast ? '└── ' : '├── ';
    const icon = icons && node.icon ? `${node.icon} ` : '';
    const nameColor = node.children ? colors.directory : colors.file;
    const coloredName = this.colorize(node.name, nameColor);

    lines.push(prefix + connector + icon + coloredName);

    // Metadata
    if (options.showMetadata && node.metadata) {
      const metadataStr = Object.entries(node.metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      const metadataLine = prefix + (isLast ? '    ' : '│   ') +
                          this.colorize(`(${metadataStr})`, colors.metadata);
      lines.push(metadataLine);
    }

    // Children
    if (node.children && node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      node.children.forEach((child, index) => {
        const isLastChild = index === node.children!.length - 1;
        lines.push(this.renderTreeNode(child, depth + 1, childPrefix, options, isLastChild));
      });
    }

    return lines.join('\n');
  }
}

export default RichFormatter;