/**
 * Minimal type declarations for @mariozechner/pi-coding-agent
 * The actual package is not a direct dependency — this extension file
 * is shipped to Pi's extensions directory at runtime.
 */
declare module '@mariozechner/pi-coding-agent' {
  export interface InputEvent {
    text: string | unknown;
    [key: string]: unknown;
  }

  export type InputEventResult =
    | { action: 'continue' }
    | { action: 'transform'; text: string }
    | { action: 'stop' };

  export interface ExtensionAPI {
    on(event: 'input', handler: (event: InputEvent) => InputEventResult): void;
    [key: string]: unknown;
  }
}
