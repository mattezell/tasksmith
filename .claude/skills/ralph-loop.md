---
name: ralph-loop
description: Execute a task with validation-retry loop (Ralph Loop pattern)
---

# Task

Execute this task and ensure it passes validation.

## Instructions

$ARGUMENTS

## Validation

After completing the work, run the validation command to verify your changes.
If validation fails, analyze the error output, fix the issues, and retry.

## Rules

- Read existing code and tests before changing anything
- Follow the project's existing patterns and conventions
- Minimal, targeted changes — don't refactor unrelated code
- Document anything ambiguous
- If validation keeps failing with the same error, investigate the root cause rather than making cosmetic changes
