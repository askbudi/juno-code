# Lifecycle evidence reuse dogfood (v9Jcwn)

Date: 2026-09-01

Verdict: **PASS — focused validation-only matrix**

This report replays the preserved `95o3PJ`/`rbr4z1` evidence work from base
`39c1b37b5230dc6368b7ea7842de7e03349a2034`. It changes no lifecycle production
behavior and grants no merge, release, publication, deployment, or cleanup
authority.

## Test-first evidence and parity

The managed `yy task run v9Jcwn` invocation first witnessed the exact focused
command fail RED with exit 2 because the requirement-specific template test did
not exist. After replay, the identical command passed 4/4 in 120 ms wall time.
`docs/evidence/v9Jcwn/focused-matrix-receipt.json` binds that command, base,
output digest, predecessor commits, and artifact hashes.

The template/runtime test pair is byte-identical, as is the fixture pair. Both
pairs are declared in `src/templates/managed-assets.json`, recorded in the root
managed inventory with matching source/installed hashes, and covered by the
script-installer inventory test.

## Historical topology and concurrency

The fixture independently addresses Benchmark source, Benchmark config/lock,
and the Juno-code Benchmark fixture. During 25 snapshot compilations, a
concurrent writer changes an unrelated root README, generated skill, task, PDR,
and wiki. The 25 identities remain equal and do not invalidate admitted inputs.

Relevant source, config/lock, and fixture movement reruns only its validation
shard. Policy drift reruns risk; prompt drift reruns review; active-document
drift reruns documentation and dependent review; managed-output drift reruns
integration. Target refresh is conservatively classified
`candidate_or_target_drift`.

## Reuse and recovery aggregate

The committed matrix compares against the observed **12 commands / 265,000 ms**
historical baseline and covers task-standing-to-merge reuse plus exact-candidate
resume.

| Metric | Result |
|---|---:|
| Reuse-eligible boundaries | 2 |
| Reused boundaries | 2 (100%) |
| Avoided commands | 24 |
| Baseline-normalized wall time avoided | 530,000 ms |
| Phase reruns | 8 |
| Conservative whole-tree fallbacks | 1 |
| False reuse | **0** |
| Duplicate receipt/metric/mutation on resume | **0** |

Decision distribution is `hit=2`, `cold_miss=1`, `input_changed=2`,
`policy_changed=1`, `runtime_changed=1`, `authority_changed=4`,
`write_collision=1`, `malformed_evidence=2`, and `closure_unknown=1`.
Withdrawal, blocker, FIFO, and ownership races stop before execution as
`authority_changed`; the managed destination race stops as `write_collision`.
Malformed/tampered evidence and unknown closure never reuse. Derived hits retain
the complete immutable source lineage.

The avoided wall time is baseline-normalized avoided work, not a claim that the
focused fixture executed the historical command set.

## Proportional readback

The focused matrix passed 4/4, operation snapshots 8/8, risk policy 20/20, and
script installer 35/35. Full suites, typecheck, build, integration-owner
readback, finish, and merge are intentionally not claimed here; those remain
policy-selected lifecycle admission checks outside this focused implementation
boundary.
