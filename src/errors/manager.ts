/**
 * Error Manager - Central error handling and reporting
 */

import type { JunoTaskError } from './base';
import type { ErrorCategory } from './categories';
import { errorRecoveryManager } from './recovery';

export class ErrorManager {
  private errorHistory: JunoTaskError[] = [];

  public handleError(error: JunoTaskError): void {
    this.errorHistory.push(error);
    // Additional error handling logic here
  }

  public getErrorHistory(): readonly JunoTaskError[] {
    return this.errorHistory;
  }

  public getErrorsByCategory(category: ErrorCategory): readonly JunoTaskError[] {
    return this.errorHistory.filter(error => error.category === category);
  }
}

export const errorManager = new ErrorManager();