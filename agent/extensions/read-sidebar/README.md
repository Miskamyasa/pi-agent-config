# read-sidebar

`/files` toggles a persistent sidebar overlay on the right side of the
terminal. It lists every file the agent read through the session, largest
token estimate first.

- The sidebar covers 80% of the terminal height, sticks to the top, and
  stays visible while you keep typing; it never takes keyboard focus, so the
  prompt bar stays usable.
- Tracks successful `read` tool calls. The token estimate comes from the read
  result content (via pi's `estimateTokens`); repeated reads keep the highest
  estimate, so a dedup notice from `read-dedup` never shrinks it. Very large
  files show the estimate of the truncated read result.
- Rows show the file name with extension, a read count when the file was
  read more than once, and the token estimate. When several files share a
  name, the parent folder is appended, e.g. `index.ts (utils)`. The header
  shows the file count and the total. When the list exceeds the height, the
  footer shows how many more there are.
- The list rebuilds from the session branch on start, resume, fork, and tree
  navigation, so restored sessions show their reads.
- The sidebar hides itself on terminals narrower than 70 columns and is
  removed on session shutdown.

No config file. State is in memory only.
