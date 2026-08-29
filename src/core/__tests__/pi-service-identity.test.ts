import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Pi service terminal identity', () => {
  it('retains the exact routed provider/model on success and failure capture events', () => {
    const services = path.resolve('src/templates/services');
    const source = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(services)})`,
      'from pi import PiService',
      'service = PiService()',
      'service.model_name = "zai/glm-5.3"',
      'service.session_id = "session-1"',
      'print(json.dumps([service._build_success_result_event("ok", {}), service._build_error_result_event("bad")]))',
    ].join('; ');
    const events = JSON.parse(execFileSync('python3', ['-c', source], { encoding: 'utf8' })) as Array<Record<string, unknown>>;
    expect(events).toEqual([
      expect.objectContaining({ provider: 'zai', model: 'glm-5.3', subtype: 'success' }),
      expect.objectContaining({ provider: 'zai', model: 'glm-5.3', subtype: 'error' }),
    ]);
  });
});
