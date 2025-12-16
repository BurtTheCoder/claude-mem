# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage and injects relevant context into future sessions using direct SQLite access with on-demand semantic search.

**Current Version**: 8.0.0

## Build & Test Commands

```bash
npm run build              # Build hooks and viewer (esbuild bundles to plugin/scripts/)
npm run sync-marketplace   # Copy built plugin to ~/.claude/plugins/marketplaces/thedotmack/
npm run setup:model        # Download embedding model (~24MB GGUF)
npm run viewer             # Start viewer UI server (http://localhost:37777)

npm run test:memory        # Test SimpleMemory class functionality
npm run test:context       # Test context hook with mock session input
npm run test               # Run vitest test suite
npm run migrate:simple     # Import data from legacy database format
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SimpleMemory                         │
├─────────────────────────────────────────────────────────┤
│  SQLite (simple-memory.db)                              │
│  ├── sqlite-vec    → vector storage & KNN search        │
│  └── sqlite-lembed → in-database embedding generation   │
│                                                         │
│  + all-MiniLM-L6-v2.gguf (~24MB model, optional)       │
└─────────────────────────────────────────────────────────┘
```

**3 Lifecycle Hooks** (configured in `plugin/hooks/hooks.json`):

| Hook | Source | Purpose |
|------|--------|---------|
| SessionStart | `context-hook.ts` | Injects recent events as `<claude-mem-context>` |
| PostToolUse | `save-hook.ts` | Records tool events synchronously (skips TodoWrite, SlashCommand, Skill, AskUserQuestion, ExitPlanMode) |
| UserPromptSubmit | `new-hook.ts` | Semantic search when prompt matches history patterns |

**Core Module**: `src/core/SimpleMemory.ts`
- Singleton pattern via `getSimpleMemory()`
- Tables: `sessions`, `tool_events`, `event_embeddings`, `embedding_cache`, `preload_files`
- Deterministic metadata extraction (event_type: read/write/exec/search/preload/other)
- Lazy embedding generation with MD5-based cache invalidation

**Design Principles**:
- Direct SQLite access (no daemon/worker process)
- sqlite-vec for KNN vector search (no external vector DB)
- sqlite-lembed for in-database embeddings (no Python dependencies)
- Deterministic extraction on write (no LLM in hot path)
- On-demand embeddings (generated at search time, cached for reuse)

## Preload Knowledge

Project-specific knowledge can be preloaded from `.claude-mem/preload/` directory:

```
project/
├── .claude-mem/
│   └── preload/
│       ├── architecture.md       # Gets indexed and searchable
│       ├── api-conventions.md
│       └── decisions/            # Subdirs become categories
│           └── database-choice.md
```

**How it works:**
- On SessionStart, hook scans `.claude-mem/preload/` for markdown files
- Files are **indexed** as `PreloadedKnowledge` tool events (not auto-injected)
- Hash-based change detection (only re-imports when files change)
- Content is searchable via semantic search when user asks relevant questions
- Subdirectory names become categories (e.g., `[Decisions] Database Choice`)

**Key files:**
- `src/utils/preload-parser.ts` - Parses markdown files from preload directory
- `src/core/SimpleMemory.ts` - `preload_files` table tracks imported files

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy (prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level (prevents recursive storage)

Tag stripping happens in `src/utils/tag-stripping.ts` at hook layer before data reaches storage.

## File Locations

| Path | Description |
|------|-------------|
| `~/.claude-mem/simple-memory.db` | SQLite database with tool events |
| `~/.claude-mem/models/all-MiniLM-L6-v2.gguf` | Embedding model (384-dim vectors) |
| `~/.claude-mem/settings.json` | Runtime configuration |
| `plugin/` | Built plugin output (scripts/, ui/, hooks/, skills/) |
| `plugin/hooks/hooks.json` | Hook configuration for Claude Code |
| `plugin/skills/` | mem-search and troubleshoot skill definitions |

## Configuration

Settings in `~/.claude-mem/settings.json` (auto-created on first run):

```json
{
  "CLAUDE_MEM_DATA_DIR": "~/.claude-mem",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": 50,
  "CLAUDE_MEM_VIEWER_PORT": 37777
}
```

## Plugin Structure

The build process (`scripts/build-hooks.js`) uses esbuild to bundle TypeScript hooks:
- Entry points: `src/hooks/*.ts` → `plugin/scripts/*.js`
- Native modules (`better-sqlite3`, `sqlite-vec`, `sqlite-lembed`) are external
- Runtime deps installed via `plugin/package.json` during smart-install

**Viewer UI**: React app built to `plugin/ui/`, served by `viewer-server.ts` on port 37777
