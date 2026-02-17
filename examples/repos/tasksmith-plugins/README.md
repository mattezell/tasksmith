# TaskSmith Plugin Directory

Curated list of plugins for TaskSmith.

## Official Plugins

| Plugin | Description | Install |
|--------|-------------|---------|
| `tasksmith-plugin-github` | GitHub issue/PR integration | `npm i tasksmith-plugin-github` |
| `tasksmith-plugin-jira` | JIRA ticket integration | `npm i tasksmith-plugin-jira` |
| `tasksmith-plugin-docker` | Docker container management | `npm i tasksmith-plugin-docker` |
| `tasksmith-plugin-proxmox` | Proxmox VM provisioning | `npm i tasksmith-plugin-proxmox` |
| `tasksmith-plugin-postgres` | Direct PostgreSQL task hooks | `npm i tasksmith-plugin-postgres` |

## Community Plugins

Submit a PR to add your plugin here.

## Creating a Plugin

```bash
tasksmith plugin create my-thing
```

This scaffolds a complete, publishable plugin:

```
tasksmith-plugin-my-thing/
├── index.js          # Plugin entry point
├── package.json      # npm metadata
├── README.md         # Usage docs
└── templates/        # Optional templates bundled with plugin
    └── my_template/
        └── PROMPT.md
```

### Plugin API

A plugin is a single default-exported function:

```javascript
export default function myPlugin(forge, opts) {
  // Add an outbound notification provider
  forge.addOutboundProvider(new MyNotifier(opts));

  // Add a custom template
  forge.addTemplate("my-template", "./templates/my_template");

  // Hook into task lifecycle
  forge.addHook("beforeTaskExecute", async (task) => {
    // Modify task before execution
    console.log(`Starting: ${task.id}`);
  });

  forge.addHook("afterTaskExecute", async (result) => {
    // React to task completion
    if (result.ok) await celebrate(result);
  });

  forge.addHook("onTaskFail", async (task, error) => {
    // Handle failures
    await logToExternalService(task, error);
  });
}
```

### Available Hooks

| Hook | Args | When |
|------|------|------|
| `beforeTaskExecute` | `(task)` | Before Claude Code runs |
| `afterTaskExecute` | `(result)` | After successful completion |
| `onTaskFail` | `(task, error)` | After task failure |
| `onValidationFail` | `(task, output, iteration)` | Ralph Loop validation failure |
| `onMemoryStore` | `(entry)` | Before memory is stored |
| `onStartup` | `(config)` | Engine startup |
| `onShutdown` | `()` | Engine shutdown |

### Configuration

Users configure plugins in `tasksmith.yaml`:

```yaml
plugins:
  - tasksmith-plugin-github
  - name: tasksmith-plugin-proxmox
    config:
      host: "https://pve.local:8006"
      tokenId: "tasksmith@pam!api"
      tokenSecret: "xxx"
```

### Publishing

```bash
cd tasksmith-plugin-my-thing
npm publish
```

That's it. Users install with `npm install tasksmith-plugin-my-thing`.
The convention is `tasksmith-plugin-*` — TaskSmith auto-discovers installed plugins
matching this pattern.
