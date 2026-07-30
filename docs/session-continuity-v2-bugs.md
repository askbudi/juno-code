# Session continuity v2 implementation bugs

Bugs were recorded before their production fixes during `ly52u5` TDD:

1. **Lost updates and split truth:** branch mutations used a locked `session_branches.json`, while completion and branch switching separately rewrote unlocked `.env.juno` session/settings pairs. Concurrent writers could lose scopes or leave the active branch and automatic continuation disagreeing.
2. **Malformed state acceptance:** the workflow runner repaired malformed branch JSON into an empty object and wrote over it. Settings accepted arbitrary JSON objects without size, key, array, or string bounds.
3. **Workflow routing bypass:** Python workflow code directly read/wrote env snapshots and branch JSON, bypassing the TypeScript state API and duplicating lock/atomic-write behavior.
4. **Custom metadata split:** custom env paths controlled continuity snapshots while branch state used session metadata, producing two locations and two precedence rules.
5. **Status dual reader:** `continue-scope` discovered finished sessions from inherited env keys even after child-boundary filtering, so status and `yy cc` could disagree with branch metadata.

Regression coverage now exercises concurrent writers, malformed/version-invalid documents, stale lock recovery, bounded settings, custom metadata routing, shell/project isolation, branch switching/cloning, explicit resume, workflow handoff, and compiled `continue-scope`/`yy cc` behavior. The backing implementation matters because assertions alone cannot serialize read-modify-write operations; routing tests matter because an atomic file alone does not prove every caller uses it.

## Continuity maintenance bugs recorded before the `68vo3l` fixes

1. **No safe one-cut migration:** v2 stopped writing `.env.juno`, but had no reviewed inventory/apply path to import and remove legacy pairs. Manual deletion could lose the current pane or silently disagree with v2 metadata.
2. **No reversible cleanup:** there was no mode-600 backup, redacted receipt, stale-plan check, exact-byte rewrite, readback, or hash-guarded rollback for default/custom env files.
3. **No retention controls:** timestamps and `pinned` existed in the schema, but no doctor, bounded 30-day/128-scope plan, or public pin/unpin operation made the approved policy operable.
4. **Atomic durability gap:** the metadata helper renamed a temporary file but did not fsync it or verify readback; destructive multi-file transitions therefore had no durable, concurrency-checked transaction boundary.
5. **Compiled isolation regression fixture lost routing:** the binary scope-conflict case replaced the complete fixture environment when injecting retired env keys, accidentally dropping the isolated metadata-directory route and testing “not found” instead of proving the retired reader stayed absent.
