// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

/**
 * Wave 1 (7djT8N) environment opt-in probe: the suite default is Node; files
 * that genuinely need a browser environment declare the docblock above and
 * receive one. This probe proves the opt-in path keeps working so Node-only
 * runs never load happy-dom implicitly.
 */
describe('happy-dom opt-in probe', () => {
  it('receives a DOM only through the explicit docblock', () => {
    expect(typeof globalThis.document).toBe('object');
    expect(globalThis.document).not.toBeNull();
  });
});
