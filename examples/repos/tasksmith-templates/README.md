# TaskSmith Community Templates

Official and community-contributed task templates for TaskSmith.

## Installation

Copy any template folder into your templates directory:

```bash
# Global (available to all projects)
cp -r templates/api_scaffold ~/.tasksmith/templates/

# Project-local (only this project)
cp -r templates/api_scaffold .tasksmith/templates/
```

Or clone the whole repo:

```bash
git clone https://github.com/mattezell/tasksmith-templates.git
```

Then point your config at it:

```yaml
# ~/.tasksmith/config/tasksmith.yaml
workspace:
  templatesDir: ~/code/tasksmith-templates/templates
```

## Available Templates

| Template | Description | Iterates? |
|----------|-------------|-----------|
| `ralph_loop` | Run → validate → retry until tests pass | ✅ |
| `bug_hunt` | Find and fix a specific bug | ✅ |
| `code_review` | Review git diff for issues | ❌ |
| `doc_gen` | Generate documentation | ❌ |
| `research` | Research a topic and summarize | ❌ |
| `api_scaffold` | Scaffold a new REST endpoint | ✅ |
| `migration` | Database migration with validation | ✅ |
| `test_writer` | Generate tests for untested code | ✅ |
| `refactor` | Refactor with safety net | ✅ |
| `security_audit` | Scan for vulnerabilities | ❌ |

## Creating a Template

A template is a folder with a `PROMPT.md` file:

```
my_template/
└── PROMPT.md
```

`PROMPT.md` supports these variables:

- `{{prompt}}` — The user's task prompt
- `{{project}}` — Project name
- `{{model}}` — Model being used
- `{{timestamp}}` — Current ISO timestamp

Example:

```markdown
# My Custom Template

You are working on project {{project}}.

## Task

{{prompt}}

## Rules

- Always write tests
- Follow existing code style
- Commit messages use conventional commits
```

## Contributing

1. Create a folder in `templates/` with your template name (use snake_case)
2. Add a `PROMPT.md` with your compiled prompt
3. Add a `README.md` describing when to use it
4. Submit a PR

Templates should be generic enough to work across projects.
Project-specific logic belongs in directives (SOUL.md, CONVENTIONS.md), not templates.
