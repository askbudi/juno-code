/**
 * Child-process environment boundary for continuity hygiene.
 *
 * Continuation is resolved by the parent and passed through typed request fields.
 * Children retain credentials, user configuration, controller routing, and explicit
 * dispatch overrides, but never inherit the historical scoped continuity map.
 */
export type ChildEnvironment = Readonly<NodeJS.ProcessEnv>;

const LEGACY_CONTINUITY_KEYS = new Set([
  'YYLO_LAST_SESSION_ID',
  'YYLO_LAST_EXECUTION_SETTINGS',
]);
const SCOPED_CONTINUITY_KEY_PREFIXES = [
  'YYLO_LAST_SESSION_ID_SCOPE_',
  'YYLO_LAST_EXECUTION_SETTINGS_SCOPE_',
] as const;

export function isContinuityEnvironmentKey(name: string): boolean {
  return (
    LEGACY_CONTINUITY_KEYS.has(name) ||
    SCOPED_CONTINUITY_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
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
