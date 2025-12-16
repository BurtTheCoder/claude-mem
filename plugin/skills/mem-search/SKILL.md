---
name: mem-search
description: Memory search is automatic - just ask about past work or preloaded knowledge naturally.
---

# Memory Search

**Search is automatic.** The UserPromptSubmit hook detects history-related prompts and injects relevant context.

## Just Ask Naturally

The hook recognizes patterns like:
- "What did we do last session?"
- "Did we fix this bug before?"
- "How did we implement X last time?"
- "What changes were made to this file?"
- "Why did we choose Postgres?" (finds preloaded decisions)

When detected, it performs semantic search (if model installed) or text search and injects matching events as context.

## How It Works

1. **SessionStart** - Recent events injected, preload files indexed
2. **UserPromptSubmit** - History queries trigger semantic search (includes preloaded knowledge)
3. **PostToolUse** - All tool executions recorded for future sessions

## Preloaded Knowledge

Projects can include searchable documentation in `.claude-mem/preload/`:

```
project/
├── .claude-mem/
│   └── preload/
│       ├── architecture.md     # System design
│       ├── conventions.md      # Code conventions
│       └── decisions/          # Subdirs = categories
│           └── database.md     # Why we chose X
```

This content is:
- **Indexed** on session start (not auto-injected into context)
- Found via semantic search when you ask relevant questions
- Re-imported when files change (hash-based detection)

## Setup Semantic Search

For better search results, install the embedding model:

```bash
npm run setup:model  # Downloads ~24MB model
```

Without it, search falls back to LIKE-based text matching.

## Manual Browsing

To browse history manually, start the viewer:

```bash
npm run viewer  # Opens http://localhost:37777
```

The viewer provides:
- `/api/observations` - Recent tool events
- `/api/search?q=query` - Search events
- `/api/projects` - List of projects
- `/api/stats` - Database statistics

## Privacy

Wrap sensitive content with `<private>` tags to exclude from storage:

```
<private>my secret API key</private>
```
