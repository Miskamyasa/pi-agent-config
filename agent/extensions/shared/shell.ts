// Pure helpers for detecting a command in command position inside a bash
// command string. Shared by the extensions that block a CLI in the bash tool.
//
// The detector is a static tokenizer, not a shell interpreter. It answers one
// question: is a blocked command in command position? It understands command
// position, a fixed wrapper list, quote state, and one level of nested shell
// payload (`sh -c '...'`, `eval '...'`).
//
// Known limitations (deliberate, out of scope):
// - Wrapper options with separate arguments (`sudo -u user grep`) are not
//   resolved, because the option table is not modeled.
// - Aliases, functions, and variable command names are not resolved, so
//   `sh -c "$cmd"` hides its payload.
// - A payload nested deeper than RECURSION_LIMIT shells is not parsed.

export interface ShellToken {
  value: string;
  operator: boolean;
}

// Commands that delegate to another command. The detector stays in command
// position after one of these, so `sudo grep` and `xargs grep` are detected.
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "env",
  "nohup",
  "nice",
  "time",
  "timeout",
  "stdbuf",
  "ionice",
  "xargs",
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "eval",
]);

// Shells that take a command string as an argument. Their payload is parsed as
// a separate command, so a blocked CLI cannot hide inside it.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "busybox"]);

const OPERATOR_CHARS = new Set([";", "&", "|", "(", ")", "`"]);

// Depth cap: a self-referential payload must not recurse without bound.
const RECURSION_LIMIT = 3;

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isOption(value: string): boolean {
  return value.startsWith("-");
}

// Wrapper arguments such as `timeout 5s` and `nice 10`.
function isNumericArg(value: string): boolean {
  return /^\d+[smhd]?$/.test(value);
}

// `-c`, and clustered forms such as `-lc` and `-ec`.
function isCommandStringOption(value: string): boolean {
  return /^-[A-Za-z]*c$/.test(value);
}

export function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let hasCurrent = false;
  let i = 0;
  const n = command.length;

  const pushCurrent = () => {
    if (hasCurrent) {
      tokens.push({ value: current, operator: false });
      current = "";
      hasCurrent = false;
    }
  };

  const pushOperator = (value: string) => {
    pushCurrent();
    tokens.push({ value, operator: true });
  };

  while (i < n) {
    const ch = command[i];

    if (ch === " " || ch === "\t" || ch === "\r") {
      pushCurrent();
      i++;
      continue;
    }

    if (ch === "\n") {
      pushOperator("\n");
      i++;
      continue;
    }

    // A comment starts at the beginning of a word.
    if (ch === "#" && !hasCurrent) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < n && command[i] !== "'") {
        current += command[i];
        hasCurrent = true;
        i++;
      }
      i++; // closing quote
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < n && command[i] !== '"') {
        const c = command[i];
        // Command substitution runs even inside double quotes.
        if (c === "$" && command[i + 1] === "(") {
          pushOperator("(");
          i += 2;
          break;
        }
        if (c === "`") {
          pushOperator("`");
          i++;
          break;
        }
        if (c === "\\" && i + 1 < n) {
          const next = command[i + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            current += next;
            hasCurrent = true;
            i += 2;
            continue;
          }
        }
        current += c;
        hasCurrent = true;
        i++;
      }
      if (i < n && command[i] === '"') i++; // closing quote
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < n) {
        current += command[i + 1];
        hasCurrent = true;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      pushOperator("(");
      i += 2;
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        pushOperator(ch + ch);
        i += 2;
      } else {
        pushOperator(ch);
        i++;
      }
      continue;
    }

    current += ch;
    hasCurrent = true;
    i++;
  }

  pushCurrent();
  return tokens;
}

/**
 * Return the name of the first blocked command in command position, or null.
 * `isBlocked` receives the basename of each candidate.
 */
export function findBlockedCommand(
  command: string,
  isBlocked: (name: string) => boolean,
  depth = 0,
): string | null {
  const tokens = tokenizeShell(command);
  let expectCommand = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.operator) {
      expectCommand = true;
      continue;
    }

    if (!expectCommand) continue;

    const value = token.value;
    if (isEnvAssignment(value) || isOption(value) || isNumericArg(value)) continue;

    const name = basename(value);

    // `command -v grep` looks up grep; it does not run it.
    if (name === "command" && (tokens[i + 1]?.value === "-v" || tokens[i + 1]?.value === "-V")) {
      expectCommand = false;
      continue;
    }

    if (isBlocked(name)) {
      // `grep() { ... }` defines a function; it does not run the CLI.
      if (
        tokens[i + 1]?.operator &&
        tokens[i + 1].value === "(" &&
        tokens[i + 2]?.operator &&
        tokens[i + 2].value === ")"
      ) {
        expectCommand = false;
        continue;
      }
      return name;
    }

    // `sh -c '<payload>'` and `eval '<payload>'` carry a command string that
    // the tokenizer keeps as one token. Parse each payload as its own command.
    if (depth < RECURSION_LIMIT && (SHELLS.has(name) || name === "eval")) {
      const payloads = SHELLS.has(name)
        ? commandStringPayloads(tokens, i)
        : payloadsUntilOperator(tokens, i + 1);
      for (const payload of payloads) {
        const nested = findBlockedCommand(payload, isBlocked, depth + 1);
        if (nested) return nested;
      }
    }

    if (WRAPPERS.has(name)) continue;

    // A real command leaves command position, so `git grep` is allowed.
    expectCommand = false;
  }

  return null;
}

/** Arguments of a `-c` option, up to the end of the current command. */
function commandStringPayloads(tokens: ShellToken[], shellIndex: number): string[] {
  for (let i = shellIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.operator) break;
    if (isCommandStringOption(token.value)) return payloadsUntilOperator(tokens, i + 1);
    if (!isOption(token.value)) break; // the script path, not a command string
  }
  return [];
}

/** Plain token values from `start` to the end of the current command. */
function payloadsUntilOperator(tokens: ShellToken[], start: number): string[] {
  const values: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].operator) break;
    values.push(tokens[i].value);
  }
  return values;
}
