---
wiki_contract:
  line_limit: 180
  purpose: "Choose the smallest validation loop that directly proves the changed behavior and its release boundary."
  failure_mode_prevented: "Running expensive real-Git suites for trivial changes or shipping stateful lifecycle defects with mock-only evidence."
  runtime_contract_enforced: "Validation depth follows behavioral boundary and failure impact, not lines changed."
  validation_gate: "npm run build && npm run test:managed-assets"
  related_sots:
    - "effective_lifecycle_field_guide.md"
    - "git_worktree_lifecycle.md"
---

# Validation depth by risk

## Core rule

The number of changed lines is a poor proxy for validation depth. A one-line
change to ref movement, worktree admission, inventory migration, or receipt
identity may require a focused real-Git regression. A large prose or isolated
pure-function change may require only static checks and unit tests.

Choose tests by answering:

1. What observable contract changed?
2. Which system boundary could make a unit test lie?
3. What is the smallest test that crosses that boundary?
4. What release or installed-package check proves users receive the same bytes?

## Practical matrix

| Change | Minimum useful evidence | Usually unnecessary |
| --- | --- | --- |
| Markdown only | formatting/link/wiki lint, byte parity if managed | real-Git lifecycle suite |
| Manifest or packaged asset | schema check, build/copy, packed-artifact byte parity | broad product tests |
| Pure parser/formatter | focused unit tests and typecheck | worktrees or subprocess canaries |
| CLI routing/argument guard | focused command test; built-binary canary when dist wiring matters | full real-Git suite |
| Shell/process transport | focused subprocess test with real exit/stdout/stderr behavior | repository topology fixtures |
| Runtime inventory/migration | focused unit tests plus one existing-inventory real-Git fixture | every migration scenario |
| Ref/CAS/worktree/submodule logic | focused real-Git regression for success and relevant refusal | unrelated application suites |
| Release/package behavior | build, pack/install canary, version/parity checks | deployment without authority |
| Consumer compatibility | exact installed release in the real consumer controller | conclusions from source tests alone |

## When real Git is justified

Use a focused real-Git test when correctness depends on behavior mocks commonly
miss:

- symbolic and detached HEAD state;
- ref compare-and-swap or target movement;
- linked worktree registration and shared common directories;
- sparse checkout or index state;
- staged, tracked, untracked, ignored, or submodule dirt distinctions;
- submodule gitlinks and object availability;
- commit ancestry, tree identity, or merge composition;
- rollback/resume after partial mutation;
- compatibility with an existing managed inventory or receipt on disk.

Keep the fixture narrow. One real repository scenario that reproduces the
contract is more useful than a broad slow suite with weak assertions.

## When real Git is not justified

Do not add or run real-Git tests merely because a change uses a Git-shaped name.
Unit or static checks are normally sufficient when the code only formats an
already-resolved SHA, renders help, edits documentation, transforms an isolated
JSON value, or selects a route with no repository state dependency.

Avoid rerunning the full suite after every edit. Run focused validation during
implementation, then the broader gate once on the frozen integrated candidate
when project policy requires it.

## Evidence quality

- Assert the user-visible result and the safety refusal, not only internal calls.
- Bind evidence to the exact candidate SHA and runtime/package version.
- Preserve the first failure and explain why a later run supersedes it.
- A mock test proves control flow under the mock. It does not prove Git,
  filesystem, subprocess, package, or consumer semantics unless it crosses that
  real boundary.
- Installed-package checks catch omissions that source-tree tests cannot, such
  as missing templates, stale `dist`, wrong executable routing, or mismatched
  version metadata.

## Fast decision examples

- Adding this wiki: build/copy plus managed source/dist/tarball parity; no
  real-Git lifecycle fixture.
- Adding one supported `yy task` subcommand route: focused wrapper/CLI regression
  and a built command canary; real Git only if the command's behavior itself
  depends on repository state.
- Advancing `packageVersion` in an existing managed inventory: focused value
  tests plus one real-Git bootstrap fixture, because acceptance depends on
  historical on-disk state and subsequent task admission.
- Changing expected-SHA target advancement: focused real-Git success, moved-ref
  refusal, and readback tests, even if the production diff is one line.

