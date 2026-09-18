// Detection of a search CLI in a bash command string. The shell tokenizer and
// the command-position walk live in ../shared/shell.ts; this module only names
// the commands the rg tool replaces, plus rg itself.
import { findBlockedCommand } from "../shared/shell.ts";

const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep"]);

export function findSearchCommand(command: string): string | null {
  return findBlockedCommand(command, (name) => SEARCH_COMMANDS.has(name));
}
