---
name: plan
description: Discovers and plans an implementation safely in two stages - an approved discovery report, then a dependency-ordered implementation plan validated by the reviewer agent. Use when a non-trivial task needs a reviewed plan.
---

# Plan

## Required Sources

- Read every applicable `AGENTS.md` before proceeding.
- Read every reference provided in the input.
- Treat higher-priority instructions and architecture boundaries as
  constraints, not assumptions.

## Stage Selection

- If the conversation has no user-approved discovery for this input,
  run Stage 1 only.
- If the user approved discovery and resolved its blockers, run Stage 2.

## Stage 1 — Discovery

1. Run an architecture scout across the whole repository before
   targeted scouts.
2. Map each requirement to its owner, existing mechanism, and
   integration boundary.
3. Identify source conflicts, missing contracts, inaccessible
   references, and unsupported assumptions.
4. Return at most 30 lines. Do not include implementation steps.
5. Wait for user approval.

Report `Blocked` and halt if required context or ownership is missing.

### Discovery Output

```markdown
## Problem

_One short paragraph_

## Ownership and Boundaries

- _requirement → owner → existing mechanism_

## Conflicts or Missing Context

- _blocking items, or `None`_

## Readiness

`Ready for planning` or `Blocked`
```

## Stage 2 — Implementation Plan

1. Use the approved discovery as a hard constraint.
2. Run targeted scouts only for confirmed owners and scope.
3. Reuse existing architecture and mechanisms. Follow KISS and YAGNI.
4. Draft a dependency-ordered plan from small utilities and components
   to full flows.
5. When the draft is ready, validate it through the reviewer agent.
   Use the `review-plan` skill when it is available.

### Plan Rules

- Ground every step in the approved sources and code. Do not speculate.
- Keep assumptions explicit and minimal. They must not override an
  architecture boundary.
- Give each step an exact dependency prerequisite.
- Name at least one changed file, function, type, or configuration value
  per step.
- Do not include dead-code or no-op steps.
- End with a clean-up step that removes specific obsolete implementation
  artifacts.

### Plan Output

```markdown
## Missing Context

_List blockers and halt, or omit this section_

## Problem Statement

_One short paragraph_

## Assumptions

- _minimal assumptions_

## Plan Summary

_Dependency chains and rationale_

## Implementation Steps

### Step: S1

Title: Specific action
Intent: What changes and why
Dependencies: Exact prerequisites

#### Scope

- _files, functions, types, or config_

#### Acceptance Criteria

- _short, verifiable outcomes_
```
