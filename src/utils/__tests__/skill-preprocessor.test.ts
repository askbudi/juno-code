/**
 * Tests for juno-skill-preprocessor Pi extension.
 *
 * Tests the exported utility functions (substituteArgs, processShellDirectives,
 * parseCommandArgs, parseFrontmatter, findSkillFile) that power the extension.
 *
 * Why: The preprocessor is the bridge between Claude-style dynamic skills and Pi's
 * static skill expansion. Without it, Pi skills lose variable substitution and
 * shell directive execution — breaking write-once, deploy-everywhere skills.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the preprocessor functions directly from the template source
import {
  findSkillFile,
  parseCommandArgs,
  parseFrontmatter,
  processShellDirectives,
  substituteArgs,
} from '../../templates/extensions/pi/juno-skill-preprocessor.js';

// ---------------------------------------------------------------------------
// substituteArgs
// ---------------------------------------------------------------------------
describe('substituteArgs', () => {
  it('should substitute $1 and $2 with positional args', () => {
    expect(substituteArgs('Hello $1, welcome to $2', ['Alice', 'Wonderland'])).toBe(
      'Hello Alice, welcome to Wonderland',
    );
  });

  it('should replace unmatched positional args with empty string', () => {
    expect(substituteArgs('$1 and $2 and $3', ['only-one'])).toBe('only-one and  and ');
  });

  it('should substitute $ARGUMENTS with all args joined', () => {
    expect(substituteArgs('Args: $ARGUMENTS', ['a', 'b', 'c'])).toBe('Args: a b c');
  });

  it('should substitute $@ with all args joined', () => {
    expect(substituteArgs('All: $@', ['x', 'y'])).toBe('All: x y');
  });

  it('should substitute ${@:N} — args from Nth position', () => {
    expect(substituteArgs('Rest: ${@:2}', ['a', 'b', 'c', 'd'])).toBe('Rest: b c d');
  });

  it('should substitute ${@:N:L} — L args from position N', () => {
    expect(substituteArgs('Slice: ${@:2:2}', ['a', 'b', 'c', 'd'])).toBe('Slice: b c');
  });

  it('should handle ${@:0} as ${@:1} (bash convention)', () => {
    expect(substituteArgs('${@:0}', ['a', 'b'])).toBe('a b');
  });

  it('should handle empty args', () => {
    expect(substituteArgs('$1 $ARGUMENTS', [])).toBe(' ');
  });

  it('should handle no placeholders', () => {
    expect(substituteArgs('plain text', ['arg'])).toBe('plain text');
  });

  it('should handle multiple occurrences of the same variable', () => {
    expect(substituteArgs('$1 then $1 again', ['hello'])).toBe('hello then hello again');
  });

  it('should not re-substitute values containing $ patterns', () => {
    // If $1 resolves to "$2", that "$2" should NOT be substituted again
    expect(substituteArgs('$1 $2', ['$2', 'world'])).toBe('$2 world');
  });
});

// ---------------------------------------------------------------------------
// parseCommandArgs
// ---------------------------------------------------------------------------
describe('parseCommandArgs', () => {
  it('should split simple space-separated args', () => {
    expect(parseCommandArgs('hello world')).toEqual(['hello', 'world']);
  });

  it('should handle double-quoted strings', () => {
    expect(parseCommandArgs('"hello world" foo')).toEqual(['hello world', 'foo']);
  });

  it('should handle single-quoted strings', () => {
    expect(parseCommandArgs("'hello world' bar")).toEqual(['hello world', 'bar']);
  });

  it('should handle escaped characters', () => {
    expect(parseCommandArgs('hello\\ world')).toEqual(['hello world']);
  });

  it('should handle empty input', () => {
    expect(parseCommandArgs('')).toEqual([]);
    expect(parseCommandArgs('   ')).toEqual([]);
  });

  it('should handle mixed quotes', () => {
    expect(parseCommandArgs('"one two" \'three four\' five')).toEqual([
      'one two',
      'three four',
      'five',
    ]);
  });

  it('should handle multiple spaces between args', () => {
    expect(parseCommandArgs('a   b    c')).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------
describe('parseFrontmatter', () => {
  it('should parse YAML frontmatter', () => {
    const content = '---\nname: test-skill\ndescription: A test\n---\nBody content here';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('test-skill');
    expect(frontmatter.description).toBe('A test');
    expect(body).toBe('Body content here');
  });

  it('should parse boolean values', () => {
    const content = '---\nenable-shell-directives: true\ndisabled: false\n---\nBody';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter['enable-shell-directives']).toBe(true);
    expect(frontmatter['disabled']).toBe(false);
  });

  it('should handle content without frontmatter', () => {
    const content = 'Just plain body text';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just plain body text');
  });

  it('should handle empty body after frontmatter', () => {
    const content = '---\nname: empty\n---\n';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('empty');
    expect(body).toBe('');
  });

  it('should handle multi-line body', () => {
    const content = '---\nname: multi\n---\nLine 1\nLine 2\nLine 3';
    const { body } = parseFrontmatter(content);
    expect(body).toBe('Line 1\nLine 2\nLine 3');
  });
});

// ---------------------------------------------------------------------------
// processShellDirectives
// ---------------------------------------------------------------------------
describe('processShellDirectives', () => {
  it('should execute simple commands', () => {
    const result = processShellDirectives('Output: !`echo hello`', process.cwd());
    expect(result).toBe('Output: hello');
  });

  it('should handle multiple directives', () => {
    const result = processShellDirectives('!`echo a` and !`echo b`', process.cwd());
    expect(result).toBe('a and b');
  });

  it('should handle failed commands gracefully', () => {
    const result = processShellDirectives(
      '!`nonexistent_command_xyz_12345`',
      process.cwd(),
    );
    expect(result).toBe('[Error executing: nonexistent_command_xyz_12345]');
  });

  it('should not process text without shell directives', () => {
    const text = 'Plain text with `code blocks` and backticks';
    expect(processShellDirectives(text, process.cwd())).toBe(text);
  });

  it('should trim output', () => {
    const result = processShellDirectives('!`echo "  spaced  "`', process.cwd());
    expect(result).toBe('spaced');
  });

  it('should handle command with pipes', () => {
    const result = processShellDirectives('!`echo "hello world" | tr "h" "H"`', process.cwd());
    expect(result).toBe('Hello world');
  });

  it('should respect timeout', () => {
    // Use a very short timeout with a sleeping command
    const result = processShellDirectives('!`sleep 10`', process.cwd(), 100);
    expect(result).toBe('[Error executing: sleep 10]');
  });
});

// ---------------------------------------------------------------------------
// findSkillFile
// ---------------------------------------------------------------------------
describe('findSkillFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find skill in .pi/skills/{name}/SKILL.md', () => {
    const skillDir = path.join(tmpDir, '.pi', 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\n---\nBody');

    const result = findSkillFile('test-skill', tmpDir);
    expect(result).toBe(path.join(skillDir, 'SKILL.md'));
  });

  it('should find skill in .claude/skills/{name}/SKILL.md', () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\nBody');

    const result = findSkillFile('my-skill', tmpDir);
    expect(result).toBe(path.join(skillDir, 'SKILL.md'));
  });

  it('should find .md file directly in skill dir', () => {
    const skillDir = path.join(tmpDir, '.pi', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'direct-skill.md'), '---\nname: direct-skill\n---\nBody');

    const result = findSkillFile('direct-skill', tmpDir);
    expect(result).toBe(path.join(skillDir, 'direct-skill.md'));
  });

  it('should prefer .pi/skills over .claude/skills', () => {
    // Create in both locations
    const piDir = path.join(tmpDir, '.pi', 'skills', 'dual-skill');
    const claudeDir = path.join(tmpDir, '.claude', 'skills', 'dual-skill');
    fs.mkdirSync(piDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, 'SKILL.md'), 'pi version');
    fs.writeFileSync(path.join(claudeDir, 'SKILL.md'), 'claude version');

    const result = findSkillFile('dual-skill', tmpDir);
    expect(result).toBe(path.join(piDir, 'SKILL.md'));
  });

  it('should return null for unknown skill', () => {
    expect(findSkillFile('nonexistent-skill', tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: full skill preprocessing flow
// ---------------------------------------------------------------------------
describe('skill preprocessing integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skill-integ-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should substitute variables and process shell directives end-to-end', () => {
    // Create a skill with variables and shell directives
    const skillDir = path.join(tmpDir, '.pi', 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: test-skill',
        'description: Test skill',
        'enable-shell-directives: true',
        '---',
        '',
        '## Task: $1',
        '',
        'Current dir: !`echo test-output`',
        '',
        'All args: $ARGUMENTS',
      ].join('\n'),
    );

    // Find the skill
    const skillPath = findSkillFile('test-skill', tmpDir);
    expect(skillPath).not.toBeNull();

    // Read and parse
    const content = fs.readFileSync(skillPath!, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Substitute args
    const args = parseCommandArgs('"build the app" "no breaking changes"');
    let processed = substituteArgs(body.trim(), args);

    // Process shell directives
    if (frontmatter['enable-shell-directives'] === true) {
      processed = processShellDirectives(processed, tmpDir);
    }

    expect(processed).toContain('## Task: build the app');
    expect(processed).toContain('Current dir: test-output');
    expect(processed).toContain('All args: build the app no breaking changes');
  });

  it('should NOT process shell directives when frontmatter opt-in is missing', () => {
    const skillDir = path.join(tmpDir, '.pi', 'skills', 'no-shell');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      ['---', 'name: no-shell', 'description: No shell directives', '---', '', '!`echo should-not-run`'].join('\n'),
    );

    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    let processed = body.trim();

    // Shell directives should NOT be processed
    if (frontmatter['enable-shell-directives'] === true) {
      processed = processShellDirectives(processed, tmpDir);
    }

    expect(processed).toBe('!`echo should-not-run`');
  });

  it('should handle skills with no arguments gracefully', () => {
    const content = '---\nname: simple\n---\nNo variables here, just text.';
    const { body } = parseFrontmatter(content);
    const processed = substituteArgs(body.trim(), []);
    expect(processed).toBe('No variables here, just text.');
  });
});
