# Discovery

Before any work, restate the requested result and constraints.

- On session start, use scout findings as a high-level repository map.
- Keep research within the requested scope.
- Return a discovery report of at most 30 lines.
- Do not include implementation steps.
- Do not infer implementation ownership from the task description.
- Wait for explicit user approval.

Report `Missing Context` and stop if you cannot resolve:

- a required owner, contract, source, or runtime mechanism is missing.
- discovered information conflicts with a higher-priority instruction.
- an explicit boundary prevents the requested work.

Do not use an assumption to override an explicit boundary.

# Research

- Use scouts only if the session context is not enough.
- Do not research speculative edge cases.
- Do not inspect runtime source, bundles, generated files, or source maps.
- Do not inspect dependency implementation unless the user explicitly asks.
- In `node_modules`, read only `*.d.ts` files and only to confirm signatures.
- When searching `node_modules`, use `find` with `**/*.d.ts`, then use a
  targeted `read`.
- If documentation and declarations are insufficient ask the user.

Use this sequence:

1. Research.
2. Write all related files.
3. Run checks.
4. Perform the required post-refactor behavior comparison, if applicable.

# Implementation

Do not implement until the user explicitly requests implementation.

- Make the smallest correct change.
- Follow current repository conventions, instructions, and standards.
- Choose syntax and naming within scope. Do not decide unspecified
  behavior, contracts, state changes, or architecture.
- Consolidate duplicate code introduced or directly touched by the change.
- Preserve unrelated user edits.
- Never revert unrelated changes.
- Add comments only when necessary. A comment must explain why, not what.
- Apply ASD-STE100 principles to any human readable text where applicable.
- Run relevant checks only after implementation is complete.
- Fix check failures only if caused by this task and fixable within
  scope. Otherwise, skip and report only.

If implementation reveals additional required scope, stop and reassess before
expanding the change.

After implementation and checks:

1. Report completion.
2. Wait for the user to request implementation review.
3. Call the reviewer only after that request.

# Agents

Do not assume that agents share your context. Their context is empty on start.

Give each agent:

- its goal,
- confirmed scope,
- relevant findings and references,
- applicable constraints,
- available context,
- required output.

# Tools

Use available `read`, `grep`, `find`, and `ls` tools to inspect code.

Batching does not justify shell-based inspection. Read files with multiple
`read` calls. Do not use `cat`, `sed -n`, `head`, `tail`, `nl`, or shell `grep`
for file content or searches.

Use `write` and `edit` tools for file modifications.

Use `bash` only for:

- `git`,
- `mise`, `pnpm`, `npm` scripts,
- compilers,
- linters,
- `rm`,
- `env`.

The agent never commits, stages, or pushes; the user performs all git commit
actions personally. Agent, never drop a database or make any destructive,
non-reversible actions on any database, even with user approval.

# Output

- Use consistent terminology.
- Be concise and direct. Use clear, everyday language and ASD-STE100 principles.
- Do not use synonyms only for style.
- Prefer lists over tables.
- Do not overexplain the problem. Propose a solution instead.
- Apply ASD-STE100 principles when writing any documentation or specifications.
