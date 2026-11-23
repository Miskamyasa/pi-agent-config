# read-sidebar

`/files` toggles a persistent sidebar overlay on the right side of the
terminal. It lists files with successful `read` results retained in the
current context, largest token estimate first. Files mentioned only in a
compaction summary are not included.

- The sidebar covers 40% of the terminal height, sticks to the top, and
  stays visible while you keep typing; it never takes keyboard focus, so the
  prompt bar stays usable.
- Tracks successful `read` tool calls. The token estimate comes from the read
  result content (via pi's `estimateTokens`); repeated reads keep the highest
  estimate among retained results. A dedup notice from `read-dedup` does not
  shrink the estimate while the earlier result remains in context. Very
  large files show the estimate of the truncated read result.
- Rows show the file name with extension, a read count when the file was
  read more than once, and the token estimate. When several files share a
  name, the parent folder is appended, e.g. `index.ts (utils)`. The header
  shows the file count and the total. When the list exceeds the height, the
  footer shows how many more there are.
- The list rebuilds from pi's current context projection on start, resume,
  fork, tree navigation, and successful manual or automatic compaction.
  Counts and token estimates reflect retained results, not session history.
  Failed or cancelled compaction does not trigger a rebuild.
- The sidebar hides itself on terminals narrower than 70 columns and is
  removed on session shutdown.

No config file. State is in memory only.
