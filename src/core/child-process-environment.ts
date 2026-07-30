/**
 * Child-process environment boundary for continuity hygiene.
 *
 * Continuation is resolved by the parent and passed through typed request fields.
 * Children retain credentials, user configuration, controller routing, and explicit
 * dispatch overrides, but never inherit the historical scoped continuity map.
 */
export type ChildEnvironment = Readonly<NodeJS.ProcessEnv>;

const LEGACY_CONTINUITY_KEYS = new Set([
  'JUNO_CODE_LAST_SESSION_ID',
  'JUNO_CODE_LAST_EXECUTION_SETTINGS',
]);
const SCOPED_CONTINUITY_KEY =
  /^JUNO_CODE_LAST_(?:SESSION_ID|EXECUTION_SETTINGS)_SCOPE_[A-F0-9]{16}$/;

export function isContinuityEnvironmentKey(name: string): boolean {
  return LEGACY_CONTINUITY_KEYS.has(name) || SCOPED_CONTINUITY_KEY.test(name);
}

export function buildChildProcessEnvironment(
  base: ChildEnvironment = process.env,
  overrides: ChildEnvironment = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries({ ...base, ...overrides })) {
    if (!isContinuityEnvironmentKey(name)) {
      environment[name] = value;
    }
  }
  return environment;
}
