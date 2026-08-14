# Portable tmux best practices

Use tmux as an observation and transport surface, never as the source of truth.
The producing command must write bounded durable logs and terminal evidence;
scrollback alone is not completion evidence.

- Give sessions stable, shell-safe names and quote every interpolated path.
- Keep secrets out of pane titles, command lines, scrollback, and captured logs.
- Prefer attached producers with detached observer panes. A tmux server surviving
  does not prove its child producer is alive.
- Observe with bounded tails and read the process exit/footer before deciding a
  run completed, failed, timed out, or was interrupted.
- Preserve the exact log/artifact path and session identifier in handoffs.
- Stop or remove sessions only with explicit cleanup authority.

Product-specific hosts, production paths, thresholds, and recovery commands stay
in project runbooks rather than this portable controller page.
