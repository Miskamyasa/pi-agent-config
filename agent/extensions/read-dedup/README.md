# read-dedup

Stops pi from paying tokens twice for the same file content.

The extension replaces the result of a repeated `read` with a short notice
when the file has not changed since an earlier read in the same conversation.
The earlier result is still in the model context, so a second copy adds
nothing.

## How it works

1. The model calls `read`.
2. The extension compares the new result with earlier `read` results on the
   active branch.
3. When one result has the same resolved path and the same text, and the model
   still sees it, the extension replaces the new result with a notice:

   ```
   [read-dedup] /path/to/file.ts is unchanged since your earlier read of the
   whole file. That content is still in your context, so this result was not
   repeated.
   ```

4. A third read of the same file matches the original read again, so it does
   not restore a second copy.

## When it returns the real content

- The file changed.
- The model asks for a different range. A read of lines 100-200 and a read of
  lines 120-180 both stay in the conversation.
- The earlier result left the model context, for example after compaction.
- The result is an image or has more than one content block.
- The earlier read failed.

The extension does not change files, the session entries, or the `read` tool
itself. It only rewrites the result of the current call.

## Status line

The footer shows the net tokens saved on the active branch:

```
≈12.4k 󰈶
```

The value is the estimated size of the real result minus the notice. It comes
from pi's own chars/4 estimate, so it is approximate and it is not a billing
figure. The footer slot follows extension load order, because pi places status
keys in insertion order.

The count is read from the saved `details` of the replaced tool results, so it
survives `/reload`, restarts, and `/tree` navigation. It follows the active
branch: work on an abandoned branch is not counted.

## Configuration

None. The extension has no config file and no command. Remove the folder to
turn it off.

## Notes

- The `read` tool still reads the file; the extension only avoids sending the
  content to the model a second time.
- Run `/reload` after you change `index.ts`.
