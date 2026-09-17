// Pure helpers for detecting the grep CLI in a bash command string.
//
// The detector is a static tokenizer, not a shell interpreter. It answers one
// question: is a grep variant in command position? It understands command
// position, a fixed wrapper list, and quote state.
//
// Known limitations (deliberate, out of scope):
// - `sh -c 'grep ...'` and `xargs sh -c 'grep ...'` hide grep in a quoted
//   payload that is not parsed as a second shell command.
// - Wrapper options with separate arguments (`sudo -u user grep`) are not
//   resolved, because the option table is not modeled.
// - Aliases, functions, and variable command names are not resolved.

export interface ShellToken {
  value: string;
  operator: boolean;
}

const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep"]);

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

const OPERATOR_CHARS = new Set([";", "&", "|", "(", ")", "`"]);

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

function basename(value: string): string {
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

export function findGrepCommand(command: string): string | null {
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

    if (GREP_COMMANDS.has(name)) {
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

    if (WRAPPERS.has(name)) continue;

    // A real command leaves command position, so `git grep` is allowed.
    expectCommand = false;
  }

  return null;
}