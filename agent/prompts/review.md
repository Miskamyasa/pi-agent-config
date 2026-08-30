---
description: Use this command to review the execution of the given plan
---

# Review

## Objective

Run an independent code review via a dedicated (reviewer) agent to verify:

1. No regressions introduced by executed changes.
2. Execution fidelity to the plan (no dropped requirements, no scope creep).
3. Acceptance criteria coverage and risk hotspots.

## Sub-agent Prompt

<context>
  Inputs available:
  - Problem Statement: *problem statement from the planning phase*
  - Plan: *comprehensive plan explanation; what was planned and reasons for each step*
  - Steps details: *plan steps from the planning phase*
  - Execution summary: *execution summary from the execution phase*
  - Changed files list: *changed files from the execution phase*
</context>
<objective>
  Perform a honest, constructive, and direct code review to detect regressions and
  confirm the implementation matches the plan.
</objective>
<plan-fidelity-check>
  - For each planned action/step: verify it was completed as specified
    (scope + acceptance criteria).
  - Detect omissions: planned items not implemented or partially implemented.
  - Detect drift: changes implemented that are not justified by plan scope.
  - If verdict is **REQUEST_CHANGES** propose possible fixes for the identified issues.
</plan-fidelity-check>

## Main Agent Post-Processing

**If the verdict is **REQUEST_CHANGES**, do **not** declare completion**

Propose new execution steps to fix the identified issues **and WAIT for approval**.
The scope must be strictly limited to addressing the review concerns.
It must not introduce simple duct-tapes, temporary workarounds, or incomplete fixes.

Use the following template:

```markdown
## Proposed Fixes

[Bullet list of proposed fixes to address the review concerns]
```

**Otherwise, propose commit message using the following instructions:**

Title: no more than 72 characters.
Body: a bullet list of changes made after all steps and review.
Each bullet line must be no more than 72 characters.

```markdown
${domain}: ${small description}

- ${bullet point 1}
- ${bullet point 2}
- ${bullet point 3}
```
