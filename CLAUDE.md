/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage and injects relevant context into future sessions.

**Current Version**: 7.0.7

## Architecture (Simplified)

The simplified architecture uses direct SQLite access with no external dependencies:

```
┌─────────────────────────────────────────────┐
│            SimpleMemory.ts                  │
├─────────────────────────────────────────────┤
│  SQLite (simple-memory.db)                  │
│  ├── sqlite-vec  → vector storage/KNN      │
│  └── sqlite-lembed → embedding generation  │
│                                             │
│  + all-MiniLM-L6-v2.gguf (~24MB model)     │
└─────────────────────────────────────────────┘
```

**Key Components**:
- `src/prototype/SimpleMemory.ts` - Core database class with vector search
- `src/prototype/viewer-server.ts` - Minimal Express server for viewer UI
- `src/hooks/*-simple.ts` - Simplified hooks using direct DB access
- `~/.claude-mem/simple-memory.db` - Single SQLite database file
- `~/.claude-mem/models/all-MiniLM-L6-v2.gguf` - Embedding model (optional)

**Design Principles**:
- Direct SQLite access (no HTTP worker)
- sqlite-vec for vector search (no Chroma MCP)
- sqlite-lembed for in-database embeddings (no Python/uvx)
- Deterministic extraction (no LLM on write path)
- On-demand embeddings (generated at search time, cached)

## Architecture (Legacy)

> Note: The legacy architecture is being deprecated in favor of the simplified version above.

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, PM2-managed

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search (deprecated)

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (auto-injected observations, prevents recursive storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

**Hooks only**: `npm run build && npm run sync-marketplace`

**Worker changes** (legacy): `npm run build && npm run sync-marketplace && npm run worker:restart`

**Skills only**: `npm run sync-marketplace`

## Setup Commands (Simplified Architecture)

```bash
npm run setup:model        # Download embedding model (~24MB)
npm run test:prototype     # Test SimpleMemory functionality
npm run migrate:simple     # Import data from legacy database
npm run viewer             # Start viewer UI (http://localhost:37777)
```

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

**Core Settings:**
- `CLAUDE_MEM_MODEL` - Model for observations/summaries (default: claude-haiku-4-5)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observations injected at SessionStart (default: 50)
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)

**System Configuration:**
- `CLAUDE_MEM_DATA_DIR` - Data directory location (default: ~/.claude-mem)
- `CLAUDE_MEM_LOG_LEVEL` - Log verbosity: DEBUG, INFO, WARN, ERROR, SILENT (default: INFO)
- `CLAUDE_MEM_PYTHON_VERSION` - Python version for uvx/chroma-mcp (default: 3.13, avoids onnxruntime compatibility issues with Python 3.14+)
- `CLAUDE_CODE_PATH` - Path to Claude executable (default: auto-detect via 'which claude')

**Settings File Format:**
```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777"
}
```

## File Locations

**Simplified Architecture**:
- **Database**: `~/.claude-mem/simple-memory.db`
- **Embedding Model**: `~/.claude-mem/models/all-MiniLM-L6-v2.gguf`

**Legacy Architecture**:
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

**Shared**:
- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Usage Logs**: `~/.claude-mem/usage-logs/usage-YYYY-MM-DD.jsonl`

## Quick Reference

```bash
npm run build                 # Compile TypeScript
npm run sync-marketplace      # Copy to ~/.claude/plugins
npm run worker:restart        # Restart PM2 worker
npm run worker:logs           # View worker logs
pm2 list                      # Check worker status
pm2 delete claude-mem-worker  # Force clean start
```

**Viewer UI**: http://localhost:37777
