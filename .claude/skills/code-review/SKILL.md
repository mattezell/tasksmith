---
name: code-review
description: Review code for quality, security, and correctness
---

# Code Review

$ARGUMENTS

## Review Checklist

- Correctness: Does the code do what it claims?
- Security: Any injection, XSS, or OWASP top 10 vulnerabilities?
- Performance: Any obvious bottlenecks or N+1 patterns?
- Maintainability: Clear naming, reasonable abstractions, no dead code?
- Tests: Are edge cases covered? Do tests actually test the right thing?
- Error handling: Are failure modes handled gracefully?
