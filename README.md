<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">Persistent memory compression system built for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-8.0.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#mcp-search-tools">Search Tools</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Troubleshooting</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  Claude-Mem seamlessly preserves context across sessions by automatically capturing tool usage observations, generating semantic summaries, and making them available to future sessions. This enables Claude to maintain continuity of knowledge about projects even after sessions end or reconnect.
</p>

---

## Quick Start

Start a new Claude Code session in the terminal and enter the following commands:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restart Claude Code. Context from previous sessions will automatically appear in new sessions.

**Key Features:**

- 🧠 **Persistent Memory** - Context survives across sessions via direct SQLite storage
- 🔍 **Semantic Search** - sqlite-vec + sqlite-lembed for on-demand vector search
- 🖥️ **Web Viewer UI** - Browse history at http://localhost:37777 (run `npm run viewer`)
- 🔒 **Privacy Control** - Use `<private>` tags to exclude sensitive content from storage
- 🤖 **Automatic Operation** - No manual intervention required, no daemon to manage
- ⚡ **Lightweight** - No PM2, no Python, no external services - just SQLite
- 🧹 **Deterministic** - No LLM on write path, fast synchronous storage

---

## Documentation

📚 **[View Full Documentation](docs/)** - Browse markdown docs on GitHub

> **Note**: Some documentation may reference the pre-v8.0 architecture. The current simplified architecture uses direct SQLite access with sqlite-vec for vector search.

### Getting Started

- **[Installation Guide](https://docs.claude-mem.ai/installation)** - Quick start & advanced installation
- **[Usage Guide](https://docs.claude-mem.ai/usage/getting-started)** - How Claude-Mem works automatically

### Architecture

- **[Hooks Architecture](https://docs.claude-mem.ai/hooks-architecture)** - How Claude-Mem uses lifecycle hooks
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite schema & vector search

### Configuration & Development

- **[Configuration](https://docs.claude-mem.ai/configuration)** - Environment variables & settings
- **[Development](https://docs.claude-mem.ai/development)** - Building, testing, contributing
- **[Troubleshooting](https://docs.claude-mem.ai/troubleshooting)** - Common issues & solutions

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start → Inject recent tool events as context        │
│                 (direct SQLite read)                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ User Prompts → Semantic search if prompt references history │
│                (sqlite-vec KNN search)                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tool Executions → Record events synchronously               │
│                   (deterministic metadata extraction)       │
└─────────────────────────────────────────────────────────────┘
```

**Core Components:**

1. **3 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse
2. **SimpleMemory** - Core SQLite class with sqlite-vec for vector search
3. **sqlite-lembed** - In-database embedding generation (no external services)
4. **Optional Viewer** - Browse history at localhost:37777 (run manually)

**Design Principles:**

- Direct SQLite access (no daemon/worker process)
- sqlite-vec for KNN vector search (no external vector DB)
- sqlite-lembed for embeddings (no Python dependencies)
- Deterministic extraction on write (no LLM in hot path)
- On-demand embeddings (generated at search time, cached)

---

## Semantic Search

The **UserPromptSubmit** hook automatically detects when you're asking about past work and injects relevant context:

**Trigger Patterns:**
- "What did we do last time?"
- "Did we fix this bug before?"
- "How did we implement authentication?"
- "What changes were made to X?"

**How It Works:**
1. Hook detects history-related keywords in your prompt
2. Generates embedding for your query using sqlite-lembed
3. Performs KNN search against cached event embeddings
4. Injects top matching events as context

**Setup Semantic Search:**
```bash
npm run setup:model  # Download ~24MB embedding model
```

Without the model, search falls back to LIKE-based text matching.

---

## Preload Knowledge

Seed Claude with project-specific knowledge that persists and is searchable:

```
project/
├── .claude-mem/
│   └── preload/
│       ├── architecture.md      # System design, patterns
│       ├── api-conventions.md   # API guidelines
│       └── decisions/           # Subdirectory = category
│           ├── database.md      # Why we chose Postgres
│           └── auth.md          # Authentication approach
```

**How it works:**
1. Create `.claude-mem/preload/` in your project root
2. Add markdown files with knowledge you want Claude to know
3. On next session, files are **indexed** (not auto-injected into context)
4. Ask a relevant question → semantic search finds matching preloaded content
5. Changes detected via hash - only modified files re-import

**Use cases:**
- Architecture decisions and rationale
- API conventions and patterns
- Domain-specific terminology
- Onboarding context for the codebase
- Historical decisions ("why did we choose X?")

**File format:**
```markdown
# Database Choice

We chose PostgreSQL over MongoDB because:
- Strong ACID compliance needed for financial data
- Complex queries with joins
- Better tooling ecosystem
```

Files with `# Title` headings use that as the title. Subdirectories become categories (shown as `[Decisions] Database Choice`).

---

## What's New

**v8.0.0 - Simplified Architecture:**
- **Removed daemon** - No more PM2 worker process to manage
- **Direct SQLite access** - Hooks read/write database directly
- **sqlite-vec + sqlite-lembed** - In-database vector search, no external services
- **Deterministic extraction** - No LLM on write path, fast synchronous storage
- **3 hooks** - SessionStart, UserPromptSubmit, PostToolUse
- **Optional viewer** - Run `npm run viewer` to browse history

**v6.4.0 - Dual-Tag Privacy System:**
- `<private>` tags for user-controlled privacy - wrap sensitive content to exclude from storage
- System-level `<claude-mem-context>` tags prevent recursive observation storage

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

---

## System Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **SQLite 3**: For persistent storage (bundled via better-sqlite3)

---

## Key Benefits

### Automatic Memory

- Context automatically injected when Claude starts
- No manual commands or configuration needed
- Works transparently in the background

### Semantic Search

- Vector-based search using sqlite-vec
- On-demand embedding generation via sqlite-lembed
- Falls back to text search if model not installed

### Structured Events

- Deterministic metadata extraction (no LLM latency)
- Categorized by type (read, write, exec, search, other)
- Files touched tracked automatically

### Privacy Control

- `<private>` tags exclude sensitive content from storage
- `<claude-mem-context>` tags prevent recursive storage
- Tag stripping happens at hook layer before database

---

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

**Available Settings:**

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Data directory location |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Number of events to inject at SessionStart |
| `CLAUDE_MEM_VIEWER_PORT` | `37777` | Port for optional viewer server |

**Settings File Format:**

```json
{
  "CLAUDE_MEM_DATA_DIR": "~/.claude-mem",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": 50,
  "CLAUDE_MEM_VIEWER_PORT": 37777
}
```

**File Locations:**

| Path | Description |
|------|-------------|
| `~/.claude-mem/simple-memory.db` | SQLite database with tool events |
| `~/.claude-mem/models/all-MiniLM-L6-v2.gguf` | Embedding model (optional, ~24MB) |
| `~/.claude-mem/settings.json` | Configuration file |

---

## Development

```bash
# Clone and build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Run tests
npm test
npm run test:memory    # Test SimpleMemory class
npm run test:context   # Test context hook

# Deploy to Claude Code
npm run sync-marketplace

# Optional: Start viewer UI
npm run viewer
npm run setup:model    # Download embedding model for semantic search
```

See [Development Guide](https://docs.claude-mem.ai/development) for detailed instructions.

---

## Troubleshooting

**Common Issues:**

- **No context appearing** → Run `npm run test:context` to verify hook works
- **Database issues** → `sqlite3 ~/.claude-mem/simple-memory.db "PRAGMA integrity_check;"`
- **Semantic search not working** → Run `npm run setup:model` to download embedding model
- **Viewer not starting** → Check port 37777 is available

**Reset Database:**

```bash
rm ~/.claude-mem/simple-memory.db
# Database will be recreated on next session
```

See [Troubleshooting Guide](https://docs.claude-mem.ai/troubleshooting) for more solutions.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a Pull Request

See [Development Guide](https://docs.claude-mem.ai/development) for contribution workflow.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

**What This Means:**

- You can use, modify, and distribute this software freely
- If you modify and deploy on a network server, you must make your source code available
- Derivative works must also be licensed under AGPL-3.0
- There is NO WARRANTY for this software

---

## Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Powered by Claude Code** | **Made with TypeScript** | **sqlite-vec + sqlite-lembed**
