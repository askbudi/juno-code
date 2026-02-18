/**
 * Error Reporter - Error reporting and analytics
 */

import type { JunoTaskError } from './base';

export class ErrorReporter {
  public report(error: JunoTaskError): void {
    // Error reporting logic here
    console.error('[ERROR]', error.toJSON());
  }
}

export const errorReporter = new ErrorReporter();