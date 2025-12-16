/**
 * SimpleMemory: Simplified claude-mem architecture
 *
 * Key differences from current architecture:
 * - Direct SQLite access (no HTTP worker)
 * - sqlite-vec for vector search (no Chroma MCP)
 * - sqlite-lembed for in-database embeddings (no external embedding service)
 * - Deterministic extraction (no LLM on write path)
 * - On-demand embeddings (generated at search time, cached)
 *
 * This is a single-file database that handles:
 * - Tool event storage (raw, no LLM processing)
 * - Session tracking
 * - Vector search via sqlite-vec + sqlite-lembed
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as sqliteLembed from 'sqlite-lembed';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

// Embedding dimension (all-MiniLM-L6-v2 produces 384-dim vectors)
const EMBEDDING_DIM = 384;

// Model name used for lembed registration
const EMBEDDING_MODEL = 'all-MiniLM-L6-v2';

// Default model path (can be overridden)
const DEFAULT_MODEL_PATH = join(homedir(), '.claude-mem', 'models', 'all-MiniLM-L6-v2.gguf');

export interface ToolEvent {
  id?: number;
  session_id: string;
  project: string;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  cwd: string;
  created_at: number; // epoch ms
  // Deterministically extracted metadata
  files_touched?: string[];
  event_type?: 'read' | 'write' | 'exec' | 'search' | 'other';
}

export interface Session {
  id: string;
  project: string;
  user_prompt: string;
  started_at: number;
  ended_at?: number;
}

export interface SearchResult {
  event: ToolEvent;
  distance: number;
}

export interface SimpleMemoryOptions {
  dataDir?: string;
  modelPath?: string;
}

export class SimpleMemory {
  private db: Database.Database;
  private dataDir: string;
  private modelPath: string;
  private lembedAvailable: boolean = false;

  constructor(options: SimpleMemoryOptions | string = {}) {
    // Handle legacy string argument for backwards compatibility
    const opts = typeof options === 'string' ? { dataDir: options } : options;

    this.dataDir = opts.dataDir || join(homedir(), '.claude-mem');
    this.modelPath = opts.modelPath || DEFAULT_MODEL_PATH;

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const dbPath = join(this.dataDir, 'simple-memory.db');
    this.db = new Database(dbPath);

    // Load sqlite-vec extension (vector storage and search)
    sqliteVec.load(this.db);

    // Load sqlite-lembed extension (embedding generation)
    try {
      sqliteLembed.load(this.db);
      this.initLembed();
    } catch (err: any) {
      console.warn('[SimpleMemory] sqlite-lembed not available, semantic search disabled:', err.message);
    }

    // Configure for performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');

    // Initialize schema
    this.initSchema();
  }

  /**
   * Initialize sqlite-lembed with the embedding model
   */
  private initLembed(): void {
    if (!existsSync(this.modelPath)) {
      console.warn(`[SimpleMemory] Model not found at ${this.modelPath}`);
      console.warn('[SimpleMemory] Download with: curl -L -o ~/.claude-mem/models/all-MiniLM-L6-v2.gguf https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf');
      return;
    }

    try {
      // Register the embedding model with lembed
      // Model is loaded from file and registered with a name for use in queries
      this.db.exec(`
        INSERT INTO temp.lembed_models(name, model)
        SELECT '${EMBEDDING_MODEL}', lembed_model_from_file('${this.modelPath}')
        WHERE NOT EXISTS (SELECT 1 FROM temp.lembed_models WHERE name = '${EMBEDDING_MODEL}')
      `);
      this.lembedAvailable = true;
      console.log('[SimpleMemory] sqlite-lembed initialized with', EMBEDDING_MODEL);
    } catch (err: any) {
      console.warn('[SimpleMemory] Failed to register embedding model:', err.message);
    }
  }

  /**
   * Check if semantic search (lembed) is available
   */
  isSemanticSearchAvailable(): boolean {
    return this.lembedAvailable;
  }

  private initSchema(): void {
    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
    `);

    // Tool events table (raw storage, no LLM processing)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        files_touched TEXT,
        event_type TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON tool_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON tool_events(project);
      CREATE INDEX IF NOT EXISTS idx_events_created ON tool_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tool ON tool_events(tool_name);
    `);

    // Vector embeddings table (sqlite-vec)
    // Embeddings are generated on-demand and cached here
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS event_embeddings USING vec0(
          event_id INTEGER PRIMARY KEY,
          embedding float[${EMBEDDING_DIM}]
        );
      `);
    } catch (err: any) {
      // Table might already exist
      if (!err.message.includes('already exists')) {
        throw err;
      }
    }

    // Embedding cache metadata
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        event_id INTEGER PRIMARY KEY,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE CASCADE
      );
    `);

    // Preload tracking table
    // source: 'file' for filesystem-based, 'ui' for UI-created
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preload_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        title TEXT,
        category TEXT,
        event_id INTEGER,
        imported_at INTEGER NOT NULL,
        source TEXT DEFAULT 'file',
        UNIQUE(project, file_path),
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_preload_project ON preload_files(project);
    `);

    // Add source column if it doesn't exist (migration for existing DBs)
    try {
      this.db.exec(`ALTER TABLE preload_files ADD COLUMN source TEXT DEFAULT 'file'`);
    } catch {
      // Column already exists
    }
  }

  /**
   * Start a new session
   */
  startSession(sessionId: string, project: string, userPrompt: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project, user_prompt, started_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(sessionId, project, userPrompt, Date.now());
  }

  /**
   * End a session
   */
  endSession(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `);
    stmt.run(Date.now(), sessionId);
  }

  /**
   * Record a tool event (synchronous, no LLM)
   * Performs deterministic extraction of metadata
   */
  recordEvent(event: Omit<ToolEvent, 'id'>): number {
    // Deterministic extraction
    const extracted = this.extractMetadata(event);

    const stmt = this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.session_id,
      event.project,
      event.tool_name,
      event.tool_input,
      event.tool_output,
      event.cwd,
      event.created_at || Date.now(),
      extracted.files_touched ? JSON.stringify(extracted.files_touched) : null,
      extracted.event_type
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Deterministic metadata extraction (no LLM)
   */
  private extractMetadata(event: Omit<ToolEvent, 'id'>): {
    files_touched: string[];
    event_type: 'read' | 'write' | 'exec' | 'search' | 'other';
  } {
    const files: string[] = [];
    let eventType: 'read' | 'write' | 'exec' | 'search' | 'other' = 'other';

    // Extract based on tool name
    switch (event.tool_name) {
      case 'Read':
        eventType = 'read';
        // Extract file path from input
        try {
          const input = JSON.parse(event.tool_input);
          if (input.file_path) files.push(input.file_path);
        } catch {}
        break;

      case 'Write':
      case 'Edit':
      case 'MultiEdit':
        eventType = 'write';
        try {
          const input = JSON.parse(event.tool_input);
          if (input.file_path) files.push(input.file_path);
        } catch {}
        break;

      case 'Bash':
        eventType = 'exec';
        // Could parse command for file references, but keep simple for now
        break;

      case 'Glob':
      case 'Grep':
        eventType = 'search';
        // Extract pattern/path
        try {
          const input = JSON.parse(event.tool_input);
          if (input.path) files.push(input.path);
        } catch {}
        break;

      default:
        eventType = 'other';
    }

    return { files_touched: files, event_type: eventType };
  }

  /**
   * Get recent events for context injection
   */
  getRecentEvents(project: string, limit: number = 50): ToolEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tool_events
      WHERE project = ?
        AND (event_type IS NULL OR event_type != 'preload')
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(project, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      tool_name: row.tool_name,
      tool_input: row.tool_input,
      tool_output: row.tool_output,
      cwd: row.cwd,
      created_at: row.created_at,
      files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
      event_type: row.event_type
    }));
  }

  /**
   * Generate text to embed for an event (used for both indexing and search)
   */
  private getEmbeddableText(event: ToolEvent | Omit<ToolEvent, 'id'>): string {
    // Combine relevant fields for embedding
    const parts: string[] = [];

    // Tool name gives context
    parts.push(`[${event.tool_name}]`);

    // Extract meaningful content from input (file paths, queries, etc.)
    try {
      const input = JSON.parse(event.tool_input);
      if (input.file_path) parts.push(input.file_path);
      if (input.pattern) parts.push(input.pattern);
      if (input.query) parts.push(input.query);
      if (input.command) parts.push(input.command);
    } catch {
      // If not JSON, use raw input (truncated)
      const inputPreview = event.tool_input.slice(0, 500);
      parts.push(inputPreview);
    }

    // Include truncated output for context
    const outputPreview = event.tool_output.slice(0, 1000);
    parts.push(outputPreview);

    return parts.join(' ');
  }

  /**
   * Generate embedding using sqlite-lembed (in-database)
   */
  generateEmbedding(text: string): Buffer | null {
    if (!this.lembedAvailable) {
      return null;
    }

    try {
      // Use lembed() SQL function to generate embedding
      const stmt = this.db.prepare(`SELECT lembed('${EMBEDDING_MODEL}', ?) as embedding`);
      const result = stmt.get(text) as { embedding: Buffer } | undefined;
      return result?.embedding || null;
    } catch (err: any) {
      console.warn('[SimpleMemory] Embedding generation failed:', err.message);
      return null;
    }
  }

  /**
   * Search events semantically using sqlite-lembed + sqlite-vec
   * Falls back to text search if embeddings unavailable
   */
  searchEvents(
    query: string,
    options: { project?: string; limit?: number; semantic?: boolean } = {}
  ): SearchResult[] {
    const { project, limit = 20, semantic = true } = options;

    // Try semantic search if available and requested
    if (semantic && this.lembedAvailable) {
      return this.semanticSearch(query, { project, limit });
    }

    // Fall back to text search
    return this.textSearch(query, { project, limit });
  }

  /**
   * Semantic search using lembed for query embedding + vec for similarity
   */
  private semanticSearch(
    query: string,
    options: { project?: string; limit?: number }
  ): SearchResult[] {
    const { project, limit = 20 } = options;

    // First, ensure recent events have embeddings
    this.ensureEmbeddings(limit * 2);

    // Generate query embedding using lembed()
    const queryEmbedding = this.generateEmbedding(query);
    if (!queryEmbedding) {
      // Fall back to text search
      return this.textSearch(query, { project, limit });
    }

    // Use sqlite-vec for KNN search
    // Note: project filtering happens after KNN due to vec0 limitations
    const stmt = this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `);

    const rows = stmt.all(queryEmbedding, limit * 2) as any[];

    // Filter by project if specified and take limit
    const filtered = project
      ? rows.filter(row => row.project === project).slice(0, limit)
      : rows.slice(0, limit);

    return filtered.map(row => ({
      event: {
        id: row.id,
        session_id: row.session_id,
        project: row.project,
        tool_name: row.tool_name,
        tool_input: row.tool_input,
        tool_output: row.tool_output,
        cwd: row.cwd,
        created_at: row.created_at,
        files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
        event_type: row.event_type
      },
      distance: row.distance
    }));
  }

  /**
   * Simple text search (LIKE-based fallback)
   */
  private textSearch(
    query: string,
    options: { project?: string; limit?: number }
  ): SearchResult[] {
    const { project, limit = 20 } = options;

    let sql = `
      SELECT * FROM tool_events
      WHERE (
        tool_input LIKE ? OR
        tool_output LIKE ?
      )
    `;
    const params: any[] = [`%${query}%`, `%${query}%`];

    if (project) {
      sql += ` AND project = ?`;
      params.push(project);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      event: {
        id: row.id,
        session_id: row.session_id,
        project: row.project,
        tool_name: row.tool_name,
        tool_input: row.tool_input,
        tool_output: row.tool_output,
        cwd: row.cwd,
        created_at: row.created_at,
        files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
        event_type: row.event_type
      },
      distance: 0 // Text search doesn't have distance
    }));
  }

  /**
   * Ensure recent events have embeddings (lazy generation)
   */
  private ensureEmbeddings(limit: number = 100): void {
    if (!this.lembedAvailable) return;

    const eventsWithoutEmbeddings = this.getEventsWithoutEmbeddings(limit);

    for (const event of eventsWithoutEmbeddings) {
      if (!event.id) continue;

      const text = this.getEmbeddableText(event);
      const textHash = createHash('md5').update(text).digest('hex');

      // Generate embedding using lembed
      const embedding = this.generateEmbedding(text);
      if (embedding) {
        // Store directly as BLOB from lembed (already in correct format)
        try {
          this.db.exec(`
            INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
            VALUES (${event.id}, x'${embedding.toString('hex')}')
          `);

          // Store cache metadata
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
            VALUES (?, ?, ?)
          `);
          stmt.run(event.id, textHash, Date.now());
        } catch (err: any) {
          console.warn(`[SimpleMemory] Failed to store embedding for event ${event.id}:`, err.message);
        }
      }
    }
  }

  /**
   * Search events by vector similarity (requires embeddings)
   */
  searchByVector(
    embedding: number[],
    options: { project?: string; limit?: number } = {}
  ): SearchResult[] {
    const { limit = 20 } = options;

    // Convert to buffer for sqlite-vec
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // sqlite-vec requires 'k = ?' constraint for KNN queries
    const stmt = this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `);

    const rows = stmt.all(embeddingBuffer, limit) as any[];

    return rows.map(row => ({
      event: {
        id: row.id,
        session_id: row.session_id,
        project: row.project,
        tool_name: row.tool_name,
        tool_input: row.tool_input,
        tool_output: row.tool_output,
        cwd: row.cwd,
        created_at: row.created_at,
        files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
        event_type: row.event_type
      },
      distance: row.distance
    }));
  }

  /**
   * Store embedding for an event (called after embedding generation)
   */
  storeEmbedding(eventId: number, embedding: number[], textHash: string): void {
    // Store in sqlite-vec
    const embeddingJson = JSON.stringify(embedding);
    this.db.exec(`
      INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
      VALUES (${eventId}, '${embeddingJson}')
    `);

    // Store cache metadata
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(eventId, textHash, Date.now());
  }

  /**
   * Check if embedding exists for an event
   */
  hasEmbedding(eventId: number): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM embedding_cache WHERE event_id = ?');
    return stmt.get(eventId) !== undefined;
  }

  /**
   * Get events without embeddings (for batch embedding generation)
   */
  getEventsWithoutEmbeddings(limit: number = 100): ToolEvent[] {
    const stmt = this.db.prepare(`
      SELECT t.* FROM tool_events t
      LEFT JOIN embedding_cache c ON c.event_id = t.id
      WHERE c.event_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];

    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      tool_name: row.tool_name,
      tool_input: row.tool_input,
      tool_output: row.tool_output,
      cwd: row.cwd,
      created_at: row.created_at,
      files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
      event_type: row.event_type
    }));
  }

  /**
   * Format events for context injection
   */
  formatContext(events: ToolEvent[]): string {
    if (events.length === 0) {
      return 'No recent activity found for this project.';
    }

    const lines: string[] = ['# Recent Activity\n'];

    // Group by day
    const byDay = new Map<string, ToolEvent[]>();
    for (const event of events) {
      const day = new Date(event.created_at).toLocaleDateString();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(event);
    }

    for (const [day, dayEvents] of byDay) {
      lines.push(`## ${day}\n`);

      for (const event of dayEvents) {
        const time = new Date(event.created_at).toLocaleTimeString();
        const files = event.files_touched?.join(', ') || '';
        const fileInfo = files ? ` (${files})` : '';

        lines.push(`- **${time}** [${event.tool_name}]${fileInfo}`);

        // Truncate long outputs
        const output = event.tool_output.length > 200
          ? event.tool_output.slice(0, 200) + '...'
          : event.tool_output;

        if (output && event.tool_name !== 'Read') {
          lines.push(`  ${output.replace(/\n/g, '\n  ')}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ===================
  // Preload Management
  // ===================

  /**
   * Get existing preload files for a project
   */
  getPreloadFiles(project: string): Array<{ path: string; hash: string; event_id: number | null }> {
    const stmt = this.db.prepare(`
      SELECT file_path as path, file_hash as hash, event_id
      FROM preload_files
      WHERE project = ?
    `);
    return stmt.all(project) as Array<{ path: string; hash: string; event_id: number | null }>;
  }

  /**
   * Import a preload file as a tool event
   */
  importPreloadFile(
    project: string,
    filePath: string,
    fileHash: string,
    title: string,
    category: string | undefined,
    content: string
  ): number {
    // Create the tool event
    const eventStmt = this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadata = JSON.stringify({
      source: 'preload',
      path: filePath,
      title,
      category: category || null,
    });

    const result = eventStmt.run(
      `preload-${project}`,
      project,
      'PreloadedKnowledge',
      metadata,
      content,
      '',
      Date.now(),
      JSON.stringify([filePath]),
      'preload'
    );

    const eventId = Number(result.lastInsertRowid);

    // Track the preload file
    const preloadStmt = this.db.prepare(`
      INSERT OR REPLACE INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    preloadStmt.run(project, filePath, fileHash, title, category || null, eventId, Date.now());

    return eventId;
  }

  /**
   * Update an existing preload file
   */
  updatePreloadFile(
    project: string,
    filePath: string,
    fileHash: string,
    title: string,
    category: string | undefined,
    content: string,
    existingEventId: number | null
  ): number {
    // Delete old event if exists
    if (existingEventId) {
      this.db.prepare('DELETE FROM tool_events WHERE id = ?').run(existingEventId);
      this.db.prepare('DELETE FROM event_embeddings WHERE event_id = ?').run(existingEventId);
      this.db.prepare('DELETE FROM embedding_cache WHERE event_id = ?').run(existingEventId);
    }

    // Import as new
    return this.importPreloadFile(project, filePath, fileHash, title, category, content);
  }

  /**
   * Remove preload files that no longer exist
   */
  removeStalePreloadFiles(project: string, currentPaths: string[]): number {
    const existing = this.getPreloadFiles(project);
    const currentSet = new Set(currentPaths);
    let removed = 0;

    for (const file of existing) {
      if (!currentSet.has(file.path)) {
        // Remove the event
        if (file.event_id) {
          this.db.prepare('DELETE FROM tool_events WHERE id = ?').run(file.event_id);
          this.db.prepare('DELETE FROM event_embeddings WHERE event_id = ?').run(file.event_id);
          this.db.prepare('DELETE FROM embedding_cache WHERE event_id = ?').run(file.event_id);
        }
        // Remove the tracking record
        this.db.prepare('DELETE FROM preload_files WHERE project = ? AND file_path = ?').run(project, file.path);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get preload events for context injection
   */
  getPreloadEvents(project: string): ToolEvent[] {
    const stmt = this.db.prepare(`
      SELECT t.* FROM tool_events t
      JOIN preload_files p ON p.event_id = t.id
      WHERE p.project = ?
      ORDER BY t.created_at DESC
    `);

    const rows = stmt.all(project) as any[];

    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      tool_name: row.tool_name,
      tool_input: row.tool_input,
      tool_output: row.tool_output,
      cwd: row.cwd,
      created_at: row.created_at,
      files_touched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
      event_type: row.event_type
    }));
  }

  // ===================
  // Preload CRUD (for UI)
  // ===================

  /**
   * Get all preloads, optionally filtered by project
   */
  getAllPreloads(project?: string): Array<{
    id: number;
    project: string;
    file_path: string;
    title: string | null;
    category: string | null;
    source: string;
    imported_at: number;
    content_preview: string;
  }> {
    const query = project
      ? `SELECT p.*, SUBSTR(t.tool_output, 1, 200) as content_preview
         FROM preload_files p
         LEFT JOIN tool_events t ON t.id = p.event_id
         WHERE p.project = ?
         ORDER BY p.imported_at DESC`
      : `SELECT p.*, SUBSTR(t.tool_output, 1, 200) as content_preview
         FROM preload_files p
         LEFT JOIN tool_events t ON t.id = p.event_id
         ORDER BY p.imported_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = project ? stmt.all(project) : stmt.all();

    return (rows as any[]).map(row => ({
      id: row.id,
      project: row.project,
      file_path: row.file_path,
      title: row.title,
      category: row.category,
      source: row.source || 'file',
      imported_at: row.imported_at,
      content_preview: row.content_preview || '',
    }));
  }

  /**
   * Get a single preload by ID with full content
   */
  getPreloadById(id: number): {
    id: number;
    project: string;
    file_path: string;
    title: string | null;
    category: string | null;
    source: string;
    imported_at: number;
    content: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT p.*, t.tool_output as content
      FROM preload_files p
      LEFT JOIN tool_events t ON t.id = p.event_id
      WHERE p.id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      project: row.project,
      file_path: row.file_path,
      title: row.title,
      category: row.category,
      source: row.source || 'file',
      imported_at: row.imported_at,
      content: row.content || '',
    };
  }

  /**
   * Create a new preload (UI-based, not from file)
   */
  createPreload(project: string, title: string, category: string | null, content: string): number {
    const hash = createHash('md5').update(content).digest('hex');
    const filePath = `ui:${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const sessionId = `preload-${project}`;

    // Ensure session exists for preloads (required for foreign key)
    this.startSession(sessionId, project, 'Preloaded Knowledge');

    // Create the tool event
    const eventStmt = this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadata = JSON.stringify({
      source: 'ui',
      path: filePath,
      title,
      category,
    });

    const result = eventStmt.run(
      sessionId,
      project,
      'PreloadedKnowledge',
      metadata,
      content,
      '',
      Date.now(),
      JSON.stringify([filePath]),
      'preload'
    );

    const eventId = Number(result.lastInsertRowid);

    // Track the preload file
    const preloadStmt = this.db.prepare(`
      INSERT INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ui')
    `);

    const preloadResult = preloadStmt.run(project, filePath, hash, title, category, eventId, Date.now());

    return Number(preloadResult.lastInsertRowid);
  }

  /**
   * Update an existing preload (UI-based only)
   */
  updatePreload(id: number, title: string, category: string | null, content: string): void {
    const preload = this.getPreloadById(id);
    if (!preload) throw new Error('Preload not found');
    if (preload.source === 'file') throw new Error('Cannot update file-based preloads');

    const hash = createHash('md5').update(content).digest('hex');

    // Update the tool event
    const eventStmt = this.db.prepare(`
      UPDATE tool_events
      SET tool_input = ?, tool_output = ?, created_at = ?
      WHERE id = (SELECT event_id FROM preload_files WHERE id = ?)
    `);

    const metadata = JSON.stringify({
      source: 'ui',
      path: preload.file_path,
      title,
      category,
    });

    eventStmt.run(metadata, content, Date.now(), id);

    // Update preload tracking
    const preloadStmt = this.db.prepare(`
      UPDATE preload_files
      SET title = ?, category = ?, file_hash = ?, imported_at = ?
      WHERE id = ?
    `);

    preloadStmt.run(title, category, hash, Date.now(), id);

    // Invalidate embedding cache for this event
    const eventIdStmt = this.db.prepare('SELECT event_id FROM preload_files WHERE id = ?');
    const result = eventIdStmt.get(id) as { event_id: number } | undefined;
    if (result?.event_id) {
      this.db.prepare('DELETE FROM embedding_cache WHERE event_id = ?').run(result.event_id);
      this.db.prepare('DELETE FROM event_embeddings WHERE event_id = ?').run(result.event_id);
    }
  }

  /**
   * Delete a preload (UI-based only)
   */
  deletePreload(id: number): void {
    const preload = this.getPreloadById(id);
    if (!preload) throw new Error('Preload not found');
    if (preload.source === 'file') throw new Error('Cannot delete file-based preloads');

    // Get event ID before deletion
    const eventIdStmt = this.db.prepare('SELECT event_id FROM preload_files WHERE id = ?');
    const result = eventIdStmt.get(id) as { event_id: number } | undefined;

    if (result?.event_id) {
      // Delete event and related data
      this.db.prepare('DELETE FROM tool_events WHERE id = ?').run(result.event_id);
      this.db.prepare('DELETE FROM embedding_cache WHERE event_id = ?').run(result.event_id);
      this.db.prepare('DELETE FROM event_embeddings WHERE event_id = ?').run(result.event_id);
    }

    // Delete preload tracking
    this.db.prepare('DELETE FROM preload_files WHERE id = ?').run(id);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Export singleton for hook usage
let instance: SimpleMemory | null = null;

export function getSimpleMemory(): SimpleMemory {
  if (!instance) {
    instance = new SimpleMemory();
  }
  return instance;
}
