# Native Records aggregate acceptance (6Uf5mO)

Date: 2026-08-28  
Verdict: **REFUSE / migration gate closed**

This is a review artifact, not a release authorization. It reviews the frozen parent
candidate `78a32c36f959ed99acc9bdbc740e0993846b9de1` and Ledger gitlink
`71fbfe4ad0fb0472d3d88f9847d1d77a3d42dcd1`. The source versions are
`yylo-ledger 0.2.0` and `@yylo/cli 0.2.0`.

PASS is refused because the full Ledger suite has six failures, the declared 14k
benchmark fails before producing a receipt, the installed-package verifier cannot
run in the admitted worktree, the live controller Task/cold-pack corpus is outside
the frozen task-worktree authority, and the canonical responses for `12hQ6l`,
`51WmGY`, and `tE7svl` contain no persisted evidence. Focused process success is
not treated as semantic acceptance.

## Candidate and delivery inventory

| Wave | Exact Ledger commit(s) | Changed paths | Review state |
|---|---|---|---|
| 1 | `6f593237ed816ea1d864252d07484f49d8cc37f4` | Record model/storage/CLI/tests | Focused code present; aggregate gate closed |
| 2A | `fb7ab37b0c83f32c0c397b671f2779fd4ad59337`, reconciliation `39fddfd5d4280fa58066d243760c82b71cd3b2de` | documents, profiles, front matter, workflow YAML, tests | Focused acceptance present; aggregate gate closed |
| 2B | `585d946152a9c2b115d7317164752050ece0f9a5` | artifacts/content objects/tests | Focused acceptance present; aggregate gate closed |
| 3 | `5493876b1bbed25b2bad9530130889f5747081ef`, `1107967d9729385f9d33b06f315b90c9bf9c18dc`, merge `ad9a27f9da74cd10fa39ebce185e872db832147d` | record search, archive, cache/storage/tests | **Not complete:** full-suite archive regressions |
| 4 | `ca2dc4e9377af6b18dd821d7b23bb80d8c479a4e`, `54c4dff8f5ed7d193735f6b4aaa08bf0f338587c` | typed CLI, hosting, README/tests | Focused security tests pass; installed gate unavailable |
| 5P | `d78903c79a1cb3f0664815079f6e7e15bb4fb990` | `git_creation.py`, Record/storage/create paths, tests | Focused tests pass; end-to-end evidence incomplete |
| 5A | `a7ea15076402db1894a40986f379d3e5bae55252`, repairs `3f1457ae6068766e4e2334209c0450e53bc7f4e0` and `249689d816a838bf3c64f1ea53fb703bcd837062` | `tests/acceptance/test_record_storage_invariants.py` plus narrow repairs | 8 acceptance tests pass; full suite fails |
| 5B | `7fb902bc6271358e96f87aab08221e4ddad5f8f3`, merge `71fbfe4ad0fb0472d3d88f9847d1d77a3d42dcd1` | `tests/acceptance/test_public_record_surfaces.py` | 5 acceptance tests pass; scale/install evidence incomplete |

Canonical task responses supplied to this review are empty. Commits therefore do
not substitute for the required response-bound command, artifact, and disposition
evidence.

## PDR requirement matrix

| Requirement | Exact evidence inspected | Result |
|---|---|---|
| Immutable ID, slug/aliases, kinds, envelope, provenance and ID relations | `records.py`; foundation/document/artifact tests; full suite | **BLOCKED**: focused coverage exists, but aggregate suite is red |
| Slug inputs resolve once to ID; stale/ambiguous inputs fail closed; renames retain aliases | `test_record_foundation.py`, `test_record_cli.py`, public acceptance | Focused PASS; aggregate PASS not granted |
| Revision-event provenance remains authoritative | foundation tests and Record history implementations | Focused PASS; no response-bound corpus proof |
| Automatic role-bound full Git HEAD capture on all creates | `git_creation.py`; 6 Git-context unit tests; both acceptance files | Focused PASS |
| Shared/distinct repositories, detached/clean/dirty/non-Git and strict refusal | Git-context unit and acceptance tests | Focused PASS; no persisted Wave 5 response evidence |
| Creation context immutable and separate from Task completion `commit_hash` | model validation and creation-context tests | Focused PASS; live legacy corpus not inspected |
| No paths, credentials, environment, diffs, names, dirty bytes in Git context | allowlisted model plus public/storage acceptance | Focused PASS |
| Recorded clean HEAD can be checked out; dirty means committed HEAD only | `test_dirty_git_context_reconstructs_head_but_not_uncommitted_bytes` | PASS for fixture. If `worktree_dirty=true`, **only committed HEAD is reproducible; uncommitted bytes are not** |
| Compare-and-replace only; absent/ambiguous/stale failures preserve bytes/history/cache | foundation tests; concurrent acceptance | Focused PASS |
| Wiki/workflow round trip, validation and safe projections; no workflow execution | document/public acceptance; source inventory | Focused PASS; no installed E2E proof |
| Artifact backends/integrity/immutability and explicit-only capture | artifact tests and public acceptance | Focused PASS |
| No automatic run/transcript capture; no secrets or internal reasoning storage | public acceptance checks no runtime directory; artifact policy/source review | Focused PASS, but broad semantic corpus scan unavailable |
| No Record remove API; archived records cannot reopen/mutate | CLI/help source and archive tests | **FAIL**: `test_archived_ids_are_reserved_and_every_mutation_is_refused` fails before reaching the expected archive refusal |
| Cold seal/readback/hot removal and SQLite is disposable, never sole truth | storage acceptance passes; archive/cache suites inspected | **FAIL**: full-suite archive mutation regression; current cold corpus unavailable |
| Legacy Task/archive/pack compatibility and lossless rollback | migration/rollback focused selection: 48 passed | **BLOCKED**: full suite has legacy archive and receipt regressions; no live corpus proof |
| Unified typed search, scopes, canonical verification, cursors, redaction and bounds | public search acceptance | Fixture PASS: 241 records; 30-record pages; 32,000-byte cap; rebuild/query under 5 s. **BLOCKED**: declared benchmark receipt absent |
| Safe read-only HTTP and no host mutation | public HTTP acceptance | Fixture PASS: 4,096-byte host cap, 4-byte range cap, CSP/escaping, 405/400/416/403/406 refusals, byte-identical before/after |
| Declarative profiles only; no arbitrary executable plugin | profiles/source inventory | PASS by inspected product paths |
| No SQLite-only truth, blind update, slug-based internal mutation, run capture, workflow execution, unsafe host behavior | source/path inventory and focused tests | No contrary focused evidence, but **not accepted** while mandatory aggregate evidence is red/missing |

## Executed validation

| Command / evidence | Outcome |
|---|---|
| `YYLO_LEDGER_INVOCATION_ROOT=/tmp ...python3 -m pytest -q` in `juno_kanban` | **FAIL**: 703 passed, 6 failed, 1 skipped in 230.98 s |
| Focused migration/rollback/creation/Record/search/host selection | PASS: 48 passed, 10 deselected in 32.40 s |
| Wave 5 acceptance files as part of full suite | PASS: 13 tests |
| `PYTHONPATH=src ... scripts/benchmark_git_native.py --tasks 14000 --report ...` | **FAIL** before receipt: cold rebuild reports task ID/path mismatch for `tasks/T0/T00000.md` |
| Focused `juno-code` Ledger delegation/runtime tests | PASS: 3 files, 14 tests |
| `npm run typecheck` and `npm run build` in `juno-code` | PASS |
| `npm pack --ignore-scripts --json` inspection | PASS: `@yylo/cli 0.2.0`, 157 files, 3,723,005-byte tarball, 14,654,248 bytes unpacked |
| `npm run test:ledger-release-artifacts` | **UNAVAILABLE/FAIL**: expected `juno_kanban/.venv/bin/python` is absent |
| Ledger package metadata inspection | Source says `0.2.0`; `setup.py --version` unavailable because admitted Python lacks `setuptools` |
| Doctor | Fixture doctors pass in focused tests; **live candidate corpus doctor unproven** because controller-private corpus/cold packs are excluded from this worktree |
| Migration/rollback canary | Focused test selection passes; **rollout canary unproven** without installed fixture/live corpus and with full-suite failures |

The six Ledger failures are:

1. archived-ID mutation refusal returns `SYSTEM_METADATA_RESERVED` instead of the expected archive refusal;
2. complete CLI mutation receipt lacks `operation`;
3. positional legacy archive returns no archived-status Task;
4. project-registry disabled-state source differs (`default` vs `project-config`);
5. project add is refused despite the fixture's opt-in expectation;
6. two-project routing is refused as disabled.

These are blocking findings requiring separately authorized repair tasks and fresh
validation; this review intentionally changes no product code and creates no task.

## Security, migration, doctor, and disposition

Security fixture verdict is **focused PASS, aggregate NOT ACCEPTED**. Search
redaction and HTTP safety checks pass, including canonical stale-index refusal,
restricted title/payload redaction, script escaping, unsafe redirect refusal,
bounded ranges/output, structured errors, and read-only byte equality. This does
not override missing installed and full-suite evidence.

Compatibility/migration verdict is **NO ROLLOUT**. Current Task and cold-pack
losslessness cannot be asserted from an admitted worktree that intentionally omits
the controller-private corpus. Doctor is likewise not asserted from fixture-only
success. The benchmark emitted no valid artifact; `/tmp` command outputs are
ephemeral and not product inputs. This Markdown matrix is the sole committed review
artifact.

No release, tag, push, publication, deployment, production archive/mutation,
external task mutation, lifecycle cleanup, or product repair was performed.
