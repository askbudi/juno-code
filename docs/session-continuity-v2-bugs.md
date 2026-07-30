# Session continuity v2 implementation bugs

Bugs were recorded before their production fixes during `ly52u5` TDD:

1. **Lost updates and split truth:** branch mutations used a locked `session_branches.json`, while completion and branch switching separately rewrote unlocked `.env.juno` session/settings pairs. Concurrent writers could lose scopes or leave the active branch and automatic continuation disagreeing.
2. **Malformed state acceptance:** the workflow runner repaired malformed branch JSON into an empty object and wrote over it. Settings accepted arbitrary JSON objects without size, key, array, or string bounds.
3. **Workflow routing bypass:** Python workflow code directly read/wrote env snapshots and branch JSON, bypassing the TypeScript state API and duplicating lock/atomic-write behavior.
4. **Custom metadata split:** custom env paths controlled continuity snapshots while branch state used session metadata, producing two locations and two precedence rules.
5. **Status dual reader:** `continue-scope` discovered finished sessions from inherited env keys even after child-boundary filtering, so status and `yy cc` could disagree with branch metadata.

Regression coverage now exercises concurrent writers, malformed/version-invalid documents, stale lock recovery, bounded settings, custom metadata routing, shell/project isolation, branch switching/cloning, explicit resume, workflow handoff, and compiled `continue-scope`/`yy cc` behavior. The backing implementation matters because assertions alone cannot serialize read-modify-write operations; routing tests matter because an atomic file alone does not prove every caller uses it.
