# Project Template

This directory contains the **templates** for project agent and web
applications.

These templates are copied into each project when created via the orchestrator
API/web.

## Structure

```
project-template/
├── server/          - Agent API template with Discord bot
└── web/             - Next.js dashboard template
```

## How It Works

1. When you create a project, these directories are copied to
   `.projects/<project-id>/`
2. Each project gets its own isolated copy
3. The copies are built and run inside Docker containers
4. Templates are never run directly on the orchestrator

## Development

To modify the templates:

1. Make changes in this directory
2. Create a new project (it will use the updated template)
3. Or rebuild an existing project: `bun run projects build <project-id>`

## Template Contents

### Server Template

- Managed agent API
- Discord bot integration
- Tool system (28 tools)
- Memory management
- Session handling
- Immutable report storage (reports saved via `send_report` are permanent DB
  records — never written to files)
