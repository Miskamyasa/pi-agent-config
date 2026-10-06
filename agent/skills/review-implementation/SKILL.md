---
name: review-implementation
description: Sends a completed implementation to the reviewer agent for validation against its approved plan. Use after implementation and checks are complete and the user requested an implementation review.
---

# Review Implementation

## Purpose

Verify through the reviewer agent that an executed implementation
matches its approved plan and introduces no regressions.

## Preconditions

- All planned steps are complete.
- All relevant checks ran and their outcomes are known.
- The user requested an implementation review.

## Context Package

Assemble these inputs for the reviewer:

- the problem statement from the planning phase;
- the plan: steps, scope, and acceptance criteria;
- the execution summary;
- the changed-files list;
- the check commands and their outcomes.

## Reviewer Task

Call the `subagent` tool with the agent `reviewer` and a task built
from this template:

```text
Review an EXECUTED IMPLEMENTATION (implementation-review mode).

## Goal
<main agent goal, in one or two sentences>

## Confirmed Scope
<approved plan scope>

## Constraints
<architecture boundaries and applicable `AGENTS.md` rules>

## Inputs
- Problem statement: <problem statement>
- Plan: <steps, scope, acceptance criteria>
- Execution summary: <summary of what was done>
- Changed files: <list>
- Checks: <commands run and their outcomes>

## Charter
- Plan fidelity: verify each planned step completed as specified,
  in scope and acceptance criteria.
- Omissions: find planned items not implemented or partly implemented.
- Drift: find changes not justified by the plan scope.
- Regressions: inspect the diff, touched files, call sites, error
  paths, state changes, and side effects.
- For each finding, propose a fix direction.

## Finding Rules
- Each finding states severity (p0/p1/p2) and evidence as
  <file>:<line>.

## Output
- Summary.
- Findings: severity, title, file:line, risk, why, suggested fix.
- Acceptance criteria check: met | not met | not verifiable.
- Verdict: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES.
```

## Post-Processing

- Treat the findings and the verdict as advice. The user decides the
  next step.
- For findings you accept, propose fixes. Limit them strictly to the
  review concerns. Do not introduce workarounds or incomplete fixes:

```markdown
## Proposed Fixes

- <fix for review finding 1>
- <fix for review finding 2>
```

- State the findings you reject, with reasons.
- When the user accepts the result, propose a commit message using
  the following rules:  
  A title, no more than 72 characters.  
  A body, with a bullet list of changes made after all steps and review.
  - Each bullet must be no more than 72 characters.
  - Do not include headings.
  - No more than 4-5 bullets.
  - Do not include verifications and tests you made.
  - Do not wrap with any symbols.
  - No empty lines between the title and body.
