/**
 * Bounded environment-name migration for the YYLO 0.1 RC cutover.
 *
 * Legacy names are accepted as input only. Canonical names always win when
 * equal, and conflicting mixed installations/configurations fail closed.
 * Remove this adapter after the documented RC migration window.
 */
export function migrateLegacyEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const [legacyName, legacyValue] of Object.entries(environment)) {
    if (!legacyName.startsWith('JUNO_CODE_') || legacyValue === undefined) continue;
    const canonicalName = `YYLO_${legacyName.slice('JUNO_CODE_'.length)}`;
    const canonicalValue = environment[canonicalName];
    // Explicit canonical configuration takes precedence. This keeps inherited
    // legacy telemetry from overriding task-local YYLO values.
    if (canonicalValue === undefined) environment[canonicalName] = legacyValue;
  }
}
