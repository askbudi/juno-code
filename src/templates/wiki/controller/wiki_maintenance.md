# Controller wiki maintenance

The canonical wiki root is the registered controller's `.juno_task/wiki` tree.
Run `yy wiki` for the human inventory and `yy wiki --path` for scripts, then use
ordinary `rg`, `find`, editors, relative Markdown links, and wiki lint.

Portable Juno/controller pages live under `controller/`. Project and domain pages
retain their established relative paths under the same root. Do not add secrets,
logs, task artifacts, workflow attempts, caches, session transcripts, or bulky
generated evidence.

Package-owned pages use reviewed generation/checksum migration. Project-owned
pages coexist and must not be deleted by routine package updates. Before moving an
older page, classify it as `keep-project-path`, `move-controller`, `split`,
`retire`, or `unresolved`, preserving its source hash and resolving conflicts.
