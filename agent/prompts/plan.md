---
description: Use this command to create an implementation plan
---

# PLANNING

## Input

$ARGUMENTS

## Context

- You MUST read the root `AGENTS.md` file before proceeding and follow all instructions and constraints from it;
- You MUST read all references explicitly provided in the input;

## Objective

Start by running `scout` sub-agents to create a structured map of the project's architecture, components, and existing mechanisms.

Produce an execution-ready simple and scoped implementation plan:

1. A dependency-ordered list of implementation steps (actionable, scoped).
2. A human-readable plan summary with dependency chains + rationale.

## Strict Rules

### Planning Boundaries

- Use `scout` sub-agents for broad research or web investigations.
- Reuse existing architecture/mechanisms.
- Avoid redesigning systems unless strictly necessary and justified by current codebase constraints.
- Introduce new abstractions ONLY IF explicitly required by the scope and justified by the sources.
- Follow KISS principles!

### Source Grounding

- Every step MUST be grounded in provided sources (`AGENTS.md` + referenced docs/code); no speculation.
- Assumptions MUST be explicit and minimal; prefer "Missing Context" over guessing.
- If any required context/reference is missing or inaccessible,
  REPORT "Missing Context" in the output and HALT and do not produce implementation steps.

### Plan Quality and Failure Minimization

- Steps must be narrowly scoped.
- Each step must have at least: a new or modified file, function, type, or configuration value;
  avoid dead code or no-op steps.
- Each step must specify the exact dependency prerequisites.
- The order of steps must follow the order from smaller utils and sub-components
  to larger features and flows.
- Verbs in titles and intent fields must be specific.
- Always end with a clean-up step. It must remove code and files that are no longer used.

## Output Format

```markdown
## Missing Context

_List missing items here and halt_

---

## Problem Statement

_State the problem in your own words_

## Assumptions

_List of assumptions made_

## Implementation Steps

### Step: S1

Title: Short, specific title
Intent: Implementation intent (what will be built/changed)

#### Scope:

- _explicit bullets, short_

#### Acceptance Criteria:

- _explicit bullets, short_
```
