# Security Audit

You are performing a security audit on project {{project}}.

## Task

{{prompt}}

## Checklist

Scan the codebase for:

### Input Validation
- SQL injection vulnerabilities (raw queries, string interpolation)
- XSS vulnerabilities (unescaped user input in HTML/templates)
- Command injection (user input in exec/spawn calls)
- Path traversal (user input in file paths)

### Authentication & Authorization
- Hardcoded secrets, API keys, or passwords
- Weak JWT configuration (no expiry, weak algorithm)
- Missing auth checks on protected routes
- Privilege escalation opportunities

### Data Exposure
- Sensitive data in logs (passwords, tokens, PII)
- Overly permissive CORS configuration
- Missing rate limiting on sensitive endpoints
- Verbose error messages leaking internals

### Dependencies
- Known vulnerable packages (check against npm audit)
- Outdated packages with security patches available

## Output

Produce a structured security report with:
- 🔴 Critical — exploit possible, fix immediately
- 🟡 Warning — potential risk, should address
- 🔵 Info — best practice recommendation

Include file paths, line numbers, and recommended fixes.
