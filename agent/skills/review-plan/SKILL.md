---
name: review-plan
description: Sends a draft implementation plan to the reviewer agent for validation before the plan is presented as final. Use when a draft plan exists after user-approved discovery and the planning stage requires independent review.
---

# Review Plan

## Purpose

Validate a draft implementation plan through the reviewer agent.
No implementation exists yet. The reviewer verifies the plan against
its cited sources. The reviewer does not review code style.

## Preconditions

- The user approved the discovery and resolved its blockers.
- The plan satisfies the plan rules:
  - every step is grounded in cited sources or the approved discovery;
  - assumptions are explicit, minimal, and do not override an
    architecture boundary;
  - steps are dependency-ordered and each names an exact prerequisite;
  - each step names at least one changed file, function, type, or
    configuration value;
  - no step is dead code or a no-op;
  - the plan ends with a clean-up step when implementation makes
    artifacts obsolete.

## Context Package

Assemble these inputs for the reviewer:

- the approved discovery;
- sources: the file paths the plan cites;
- constraints: architecture boundaries and applicable `AGENTS.md` rules;
- assumptions;
- the draft plan: steps, scope, and acceptance criteria.

## Reviewer Task

Call the `subagent` tool with the agent `reviewer` and a task built
from this template:

```text
Validate an implementation PLAN (plan-review mode). No implementation
exists yet. Do not review code style. Verify the plan against the
cited sources.

## Goal
<main agent goal, in one or two sentences>

## Confirmed Scope
<scope and user decisions that bound the plan>

## Approved Discovery
<the approved discovery report>

## Constraints
<architecture boundaries and applicable `AGENTS.md` rules>

## Assumptions
<assumptions the plan makes>

## Sources
<file paths the reviewer must read>

## Draft Plan
<the complete draft plan>

## Charter
- Grounding: every step traces to a cited source or the approved
  discovery.
- Boundaries: no step crosses an architecture boundary or overrides
  a higher-priority instruction.
- Dependencies: step order is correct; prerequisites are exact; no
  step is missing or circular.
- Completeness: no requirement from the discovery is dropped; no step
  exceeds the confirmed scope.
- Assumptions: explicit, minimal, and safe.
- Acceptance criteria: each step states a verifiable outcome.
- Risks: the plan addresses error paths, state changes, and migration
  concerns that touch the scope.

## Finding Rules
- Evidence comes from the cited sources, not from test output.
- Each finding states severity (p0/p1/p2), the plan section or step,
  and evidence as <source-path>:<line>.
- If you cannot locate line evidence for a required source, report
  "Missing Context" and halt.

## Output
- Summary.
- Findings: severity, title, location (<plan section>;
  <source-path>:<line>), risk, why, suggested direction.
- Acceptance criteria check: met | not met | not verifiable.
- Verdict: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES.
```

## Post-Processing

- Treat the findings and the verdict as advice, not as a gate.
- Fix the findings you accept. State the findings you reject, with reasons.
- If you change the plan materially, run the review again with the updated
  plan.
- Present the final plan to the user together with the reviewer findings
  and your dispositions.
