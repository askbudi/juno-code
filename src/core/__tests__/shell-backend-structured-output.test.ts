import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import os from 'node:os';

import { ShellBackend } from '../backends/shell-backend.js';
import type { ToolCallRequest, ProgressEvent } from '../../mcp/types.js';

const tempRoots: string[] = [];

const createStubClaudeService = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-shell-stdout-'));
  tempRoots.push(tempRoot);

  const servicesDir = path.join(tempRoot, 'services');
  await fs.ensureDir(servicesDir);

  const scriptPath = path.join(servicesDir, 'claude.py');
  const scriptContent = `#!/usr/bin/env python3
import json

print(json.dumps({"type": "assistant", "content": "thinking"}))
print(json.dumps({"type": "result", "result": "done", "usage": {"input_tokens": 1, "output_tokens": 2}}))
`;
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

  return { servicesDir, workingDir: tempRoot };
};

const createStubTextService = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-shell-text-'));
  tempRoots.push(tempRoot);

  const servicesDir = path.join(tempRoot, 'services');
  await fs.ensureDir(servicesDir);

  const scriptPath = path.join(servicesDir, 'codex.py');
  const scriptContent = `#!/usr/bin/env python3
lines = [
  "import Link from 'next/link';",
  "export interface HeaderProps {",
  "  onToggleSideMenu?: () => void;",
  "  sticky?: boolean;",
  "}",
  "export function Header() {",
  "  const enabled = true;",
  "\\tconst tabValue = enabled;",
  "    const nested = enabled;",
  "  return nested;",
  "\\t\\t",
  "    ",
  "}",
]

for line in lines:
  print(line)
`;
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

  return { servicesDir, workingDir: tempRoot };
};

const createStubGeminiService = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-shell-gemini-'));
  tempRoots.push(tempRoot);

  const servicesDir = path.join(tempRoot, 'services');
  await fs.ensureDir(servicesDir);

  const scriptPath = path.join(servicesDir, 'gemini.py');
  const scriptContent = `#!/usr/bin/env python3
import json
import os
import sys

payload = {
  "argv": sys.argv[1:],
  "output_format_env": os.environ.get("GEMINI_OUTPUT_FORMAT")
}

print(json.dumps({"type": "result", "content": json.dumps(payload)}))
`;
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

  return { servicesDir, workingDir: tempRoot };
};

afterEach(async () => {
  await Promise.all(tempRoots.map(dir => fs.remove(dir)));
  tempRoots.length = 0;
});

describe('ShellBackend structured output', () => {
  it('emits JSON-parsable stdout even when capture file is absent', async () => {
    const { servicesDir, workingDir } = await createStubClaudeService();

    const backend = new ShellBackend();
    backend.configure({
      workingDirectory: workingDir,
      servicesPath: servicesDir,
      enableJsonStreaming: true,
      outputRawJson: true
    });
    await backend.initialize();

    const progressEvents: ProgressEvent[] = [];
    const request: ToolCallRequest = {
      toolName: 'claude_subagent',
      arguments: {
        instruction: 'Return stub data',
        project_path: workingDir
      },
      timeout: 15000,
      priority: 'normal',
      metadata: {
        sessionId: 'test-session',
        iterationNumber: 1
      },
      progressCallback: async (event) => {
        progressEvents.push(event);
      }
    };

    const result = await backend.execute(request);

    const parsed = JSON.parse(result.content);
    expect(parsed.type).toBe('result');
    expect(parsed.is_error).toBe(false);
    expect(parsed.result).toContain('done');
    expect(parsed.sub_agent_response).toBeTruthy();

    const metadata = result.metadata as any;
    expect(metadata?.structuredOutput).toBe(true);
    expect(metadata?.rawOutput).toContain('"result": "done"');
  });

  it('preserves leading whitespace for text streaming outputs', async () => {
    const { servicesDir, workingDir } = await createStubTextService();

    const backend = new ShellBackend();
    backend.configure({
      workingDirectory: workingDir,
      servicesPath: servicesDir,
      enableJsonStreaming: true
    });
    await backend.initialize();

    const progressEvents: ProgressEvent[] = [];
    const dispose = backend.onProgress(async (event) => {
      progressEvents.push(event);
    });

    const request: ToolCallRequest = {
      toolName: 'codex_subagent',
      arguments: {
        project_path: workingDir
      },
      timeout: 15000,
      priority: 'normal',
      metadata: {
        sessionId: 'test-session',
        iterationNumber: 1
      }
    };

    await backend.execute(request);
    dispose();

    const thinkingLines = progressEvents
      .filter(event => event.type === 'thinking')
      .map(event => event.content);

    expect(thinkingLines).toContain('  onToggleSideMenu?: () => void;');
    expect(thinkingLines).toContain('  sticky?: boolean;');
    expect(thinkingLines).toContain('\tconst tabValue = enabled;');
    expect(thinkingLines).toContain('    const nested = enabled;');
    expect(thinkingLines).toContain('  return nested;');
    expect(thinkingLines).toContain('\t\t');
    expect(thinkingLines).toContain('    ');
  });

  it('forces stream-json output format when invoking gemini service scripts', async () => {
    const originalOutputFormat = process.env.GEMINI_OUTPUT_FORMAT;
    delete process.env.GEMINI_OUTPUT_FORMAT;

    try {
      const { servicesDir, workingDir } = await createStubGeminiService();

      const backend = new ShellBackend();
      backend.configure({
        workingDirectory: workingDir,
        servicesPath: servicesDir,
        enableJsonStreaming: true
      });
      await backend.initialize();

      const request: ToolCallRequest = {
        toolName: 'gemini_subagent',
        arguments: {
          instruction: 'Show args',
          model: 'gemini-2.5-pro',
          project_path: workingDir
        },
        timeout: 15000,
        priority: 'normal',
        metadata: {
          sessionId: 'test-session',
          iterationNumber: 1
        }
      };

      const result = await backend.execute(request);
      const firstLine = result.content.trim().split('\n')[0];
      const parsed = JSON.parse(firstLine);
      const payload = JSON.parse(parsed.content);

      expect(payload.argv).toContain('--output-format');
      expect(payload.argv).toContain('stream-json');
      expect(payload.output_format_env).toBe('stream-json');
    } finally {
      if (originalOutputFormat !== undefined) {
        process.env.GEMINI_OUTPUT_FORMAT = originalOutputFormat;
      } else {
        delete process.env.GEMINI_OUTPUT_FORMAT;
      }
    }
  });
});
