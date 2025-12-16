/**
 * SimpleMemory: Simplified claude-mem architecture
 *
 * Key differences from current architecture:
 * - Direct SQLite access (no HTTP worker)
 * - sqlite-vec for vector search (no Chroma MCP)
 * - Deterministic extraction (no LLM on write path)
 * - On-demand embeddings (generated at search time, cached)
 *
 * This is a single-file database that handles:
 * - Tool event storage (raw, no LLM processing)
 * - Session tracking
 * - Vector search via sqlite-vec
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Embedding dimension (using 384 for sentence-transformers compatibility)
const EMBEDDING_DIM = 384;

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

export class SimpleMemory {
  private db: Database.Database;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || join(homedir(), '.claude-mem');

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const dbPath = join(this.dataDir, 'simple-memory.db');
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    // Configure for performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');

    // Initialize schema
    this.initSchema();
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
   * Search events by text (uses sqlite-vec if embeddings available)
   * Falls back to simple text search if no embeddings
   */
  async searchEvents(
    query: string,
    options: { project?: string; limit?: number } = {}
  ): Promise<SearchResult[]> {
    const { project, limit = 20 } = options;

    // For now, use simple text search (LIKE)
    // TODO: Implement embedding generation and vector search
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
