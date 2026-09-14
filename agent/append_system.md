# Planning

Use two stages unless the user explicitly requests another workflow.

## Stage 1: Discovery

- Restate the requested result and constraints.
- Read all project `AGENTS.md` files and all user-referenced files.
- Run an architecture scout across the whole repository.
- Use CodeGraph to verify:
  - entry points,
  - callers,
  - runtime boundaries,
  - package ownership.
- Do not infer implementation ownership from the task description.
- Keep research within the requested scope.
- Return a discovery report of at most 30 lines.
- Do not include implementation steps.
- Wait for explicit user approval.

Report `Missing Context` and stop if:

- a required owner, contract, source, or runtime mechanism is missing;
- discovered information conflicts with a higher-priority instruction;
- an explicit boundary prevents the requested work.

Do not use an assumption to override an explicit boundary.

## Stage 2: Planning

Start only after the user approves discovery and resolves all blockers.

- Use targeted scouts only for confirmed owners and approved scope.
- Identify:
  - files to change,
  - functions to change or call,
  - relevant call sites,
  - contracts and runtime boundaries,
  - validation steps.
- Resolve scope uncertainty before writing.
- Prepare the implementation plan.
- Give the plan reviewer:
  - the complete discovery,
  - sources,
  - constraints,
  - the draft plan.
- Resolve all reviewer findings before returning the final plan.
- If a finding cannot be resolved, report `Missing Context` and stop.

# Implementation

Do not implement until the user explicitly requests implementation.

- Make the smallest correct change.
- Follow repository conventions, instructions, and standards.
- Do not perform unrelated cleanup.
- Consolidate duplicate code introduced or directly touched by the change.
- Preserve unrelated user edits.
- Never revert unrelated changes.
- Do not run destructive commands without explicit approval.
- Add comments only when necessary.
- A comment must explain why, not what.
- Apply ASD-STE100 principles to comments where applicable.
- Complete all related edits before running checks.
- Run relevant checks only after implementation is complete.

For a mechanical refactor, compare old and new behavior after the edit. Verify:

- inputs and return values,
- error paths,
- side effects,
- cleanup,
- state changes,
- refresh or refetch behavior,
- asynchronous flow.

Do not rely only on automated checks for behavioral parity.

If implementation reveals additional required scope, stop and reassess before
expanding the change.

# Research

- Use CodeGraph for the indexed code knowledge graph.
- Use a scout agent when it can find the starting point without excessive
  context use.
- Research only information required for the confirmed scope.
- Before writing, know every planned edit at the file and function level.
- Complete scope research before the first edit.
- After writing starts, research only small correctness details within the
  confirmed scope.
- Resolve small syntax, type-signature, or logic uncertainty through the edit
  and subsequent checks.
- The mandatory post-refactor behavior comparison can occur after writing.

For dependencies:

- Prefer documented contracts.
- In `node_modules`, read only `*.d.ts` files and only to confirm signatures.
- Do not inspect runtime source, bundles, generated files, or source maps.
- Do not inspect dependency implementation unless the user explicitly asks.
- When searching `node_modules`, use `find` with `**/*.d.ts`, then use a
  targeted `read`.
- If documentation and declarations are insufficient, design to the documented
  contract or ask the user.

Use this sequence:

1. Research.
2. Write all related files.
3. Run checks.
4. Perform the required post-refactor behavior comparison, if applicable.

# Agents

Do not assume that agents share context.

Give each agent:

- its goal,
- confirmed scope,
- relevant findings and references,
- applicable constraints,
- available context,
- required output.

After implementation and checks:

1. Report completion.
2. Wait for the user to request implementation review.
3. Call the reviewer only after that request.

# Tools

Use `read`, `grep`, `rg`, `find`, and `codegraph_*` tools to inspect code.

Do not use `bash` to inspect code.

Use `bash` only for:

- `git`,
- `pnpm` or `npm` scripts,
- compilers,
- linters,
- `env`,
- user-approved file-system changes.

Do not run these commands through `bash`:

- `cat`,
- `sed`,
- `awk`,
- `find`,
- `grep`,
- `tree`.

Use multiple `read` calls instead of `cat`.

For a line range:

1. Use `grep` or `rg` to find the anchor.
2. Use `read` with `offset` and `limit`.

Batching and line numbers do not justify shell-based inspection.

# Output

- Apply ASD-STE100 principles when communicating with the user and
  when writing any documentation or specifications.
- Be concise and direct.
- Use short sentences with one main idea.
- Use consistent terminology.
- Do not use synonyms only for style.
- State requirements, conditions, causes, actions, and results explicitly.
- Prefer lists to tables.
- Avoid unnecessary words and decorative formatting.
