/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage and injects relevant context into future sessions using direct SQLite access with on-demand semantic search.

**Current Version**: 8.0.0

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

**3 Lifecycle Hooks** (direct SQLite access, no HTTP worker):

1. **SessionStart** (`context-hook.ts`) - Injects recent events as context
2. **PostToolUse** (`save-hook.ts`) - Records tool events synchronously
3. **UserPromptSubmit** (`new-hook.ts`) - Smart semantic search when prompt references history

**Key Files**:
- `src/core/SimpleMemory.ts` - Core database class with vector search
- `src/hooks/context-hook.ts` - SessionStart: inject recent context
- `src/hooks/save-hook.ts` - PostToolUse: record events
- `src/hooks/new-hook.ts` - UserPromptSubmit: semantic search on history queries
- `src/services/viewer-server.ts` - Optional Express server for viewer UI
- `src/utils/tag-stripping.ts` - Privacy tag processing

**Design Principles**:
- Direct SQLite access (no daemon/worker)
- sqlite-vec for vector search (no external vector DB)
- sqlite-lembed for in-database embeddings (no Python dependencies)
- Deterministic extraction (no LLM on write path)
- On-demand embeddings (generated at search time, cached for reuse)

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy (prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level (prevents recursive storage)

Tag stripping happens at hook layer before data reaches storage.

## Build Commands

```bash
npm run build              # Build hooks and viewer
npm run sync-marketplace   # Copy to ~/.claude/plugins
npm run setup:model        # Download embedding model (~24MB)
npm run viewer             # Start viewer UI (http://localhost:37777)
```

## Testing

```bash
npm run test:memory        # Test SimpleMemory functionality
npm run test:context       # Test context hook
npm run migrate:simple     # Import data from legacy database
```

## File Locations

- **Database**: `~/.claude-mem/simple-memory.db`
- **Embedding Model**: `~/.claude-mem/models/all-MiniLM-L6-v2.gguf`
- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`

## Configuration

Settings in `~/.claude-mem/settings.json` (auto-created on first run):

```json
{
  "CLAUDE_MEM_DATA_DIR": "~/.claude-mem",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": 50,
  "CLAUDE_MEM_VIEWER_PORT": 37777
}
```

**Viewer UI**: http://localhost:37777 (run `npm run viewer`)
