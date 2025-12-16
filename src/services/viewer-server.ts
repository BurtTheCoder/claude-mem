#!/usr/bin/env node
/**
 * Simplified Viewer Server
 *
 * Minimal Express server that:
 * - Uses SimpleMemory directly (no legacy worker)
 * - Serves the existing React viewer UI
 * - Provides API endpoints for the viewer
 * - Supports SSE for real-time updates
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getSimpleMemory, ToolEvent } from '../core/SimpleMemory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '../../plugin');
const DATA_DIR = join(homedir(), '.claude-mem');
const DEFAULT_PORT = 37777;

// SSE clients for real-time updates
const sseClients: Set<express.Response> = new Set();

/**
 * Convert ToolEvent to viewer's Observation format
 */
function eventToObservation(event: ToolEvent): any {
  return {
    id: event.id,
    sdk_session_id: event.session_id,
    project: event.project,
    type: event.event_type || 'other',
    title: event.tool_name,
    subtitle: event.files_touched?.join(', ') || null,
    narrative: event.tool_output?.slice(0, 500) || null,
    text: event.tool_output,
    facts: null,
    concepts: null,
    files_read: event.event_type === 'read' ? JSON.stringify(event.files_touched || []) : null,
    files_modified: event.event_type === 'write' ? JSON.stringify(event.files_touched || []) : null,
    prompt_number: null,
    created_at: new Date(event.created_at).toISOString(),
    created_at_epoch: event.created_at,
  };
}

/**
 * Broadcast event to all SSE clients
 */
function broadcastEvent(eventType: string, data: any): void {
  const message = JSON.stringify({ type: eventType, ...data });
  for (const client of sseClients) {
    client.write(`data: ${message}\n\n`);
  }
}

/**
 * Create the Express application
 */
function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // CORS for local development
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', architecture: 'simplified' });
  });

  // SSE endpoint for real-time updates
  app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    // Send initial data
    const memory = getSimpleMemory();
    const events = memory.getRecentEvents('', 50); // All projects
    const observations = events.map(eventToObservation);
    const projects = [...new Set(events.map(e => e.project))];

    res.write(`data: ${JSON.stringify({
      type: 'initial_load',
      observations,
      summaries: [],
      prompts: [],
      projects,
    })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // Get observations (tool events)
  app.get('/api/observations', (req, res) => {
    try {
      const memory = getSimpleMemory();
      const project = req.query.project as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      // Get events - SimpleMemory doesn't have offset, so we get more and slice
      const allEvents = project
        ? memory.getRecentEvents(project, limit + offset)
        : memory.getRecentEvents('', limit + offset);

      const events = allEvents.slice(offset, offset + limit);
      const observations = events.map(eventToObservation);

      res.json({
        items: observations,
        total: allEvents.length,
        hasMore: offset + limit < allEvents.length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get summaries (we don't have these in simplified architecture)
  app.get('/api/summaries', (req, res) => {
    res.json({ items: [], total: 0, hasMore: false });
  });

  // Get prompts (we don't store these separately)
  app.get('/api/prompts', (req, res) => {
    res.json({ items: [], total: 0, hasMore: false });
  });

  // Search
  app.get('/api/search', (req, res) => {
    try {
      const memory = getSimpleMemory();
      const query = req.query.q as string;
      const project = req.query.project as string | undefined;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!query) {
        return res.json({ items: [], total: 0 });
      }

      const results = memory.searchEvents(query, { project, limit });
      const observations = results.map(r => ({
        ...eventToObservation(r.event),
        distance: r.distance,
      }));

      res.json({
        items: observations,
        total: results.length,
        semanticSearch: memory.isSemanticSearchAvailable(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Stats
  app.get('/api/stats', (req, res) => {
    try {
      const memory = getSimpleMemory();
      const dbPath = join(DATA_DIR, 'simple-memory.db');
      const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0;

      // Count events (rough estimate)
      const events = memory.getRecentEvents('', 1000);

      res.json({
        worker: {
          version: '8.0.0-simplified',
          uptime: process.uptime(),
          sseClients: sseClients.size,
        },
        database: {
          size: dbSize,
          observations: events.length,
          sessions: new Set(events.map(e => e.session_id)).size,
          summaries: 0,
        },
        semanticSearch: memory.isSemanticSearchAvailable(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Processing status (always false in simplified architecture - no async processing)
  app.get('/api/processing-status', (req, res) => {
    res.json({ isProcessing: false });
  });

  // Settings
  app.get('/api/settings', (req, res) => {
    const settingsPath = join(DATA_DIR, 'settings.json');
    try {
      const settings = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, 'utf-8'))
        : {};
      res.json(settings);
    } catch {
      res.json({});
    }
  });

  // Get projects
  app.get('/api/projects', (req, res) => {
    try {
      const memory = getSimpleMemory();
      const events = memory.getRecentEvents('', 500);
      const projects = [...new Set(events.map(e => e.project))].sort();
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Context preview (what would be injected)
  app.get('/api/context/inject', (req, res) => {
    try {
      const memory = getSimpleMemory();
      const project = req.query.project as string || '';
      const events = memory.getRecentEvents(project, 50);
      const context = memory.formatContext(events);
      res.type('text/plain').send(context);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Serve viewer UI
  const viewerPath = join(PLUGIN_DIR, 'ui', 'viewer.html');
  app.get('/', (req, res) => {
    if (existsSync(viewerPath)) {
      res.sendFile(viewerPath);
    } else {
      res.send(`
        <html>
          <head><title>Claude-Mem Viewer</title></head>
          <body style="font-family: system-ui; padding: 2rem; max-width: 600px; margin: 0 auto;">
            <h1>Claude-Mem Viewer</h1>
            <p>Viewer UI not found. Run <code>npm run build</code> first.</p>
            <h2>API Endpoints</h2>
            <ul>
              <li><a href="/api/stats">/api/stats</a> - Database statistics</li>
              <li><a href="/api/observations">/api/observations</a> - Recent events</li>
              <li><a href="/api/projects">/api/projects</a> - Project list</li>
              <li><a href="/api/search?q=test">/api/search?q=test</a> - Search</li>
            </ul>
          </body>
        </html>
      `);
    }
  });

  // Serve static files from plugin/ui
  app.use('/ui', express.static(join(PLUGIN_DIR, 'ui')));

  return app;
}

/**
 * Start the server
 */
async function main(): Promise<void> {
  const port = parseInt(process.env.CLAUDE_MEM_VIEWER_PORT || String(DEFAULT_PORT));
  const app = createApp();
  const server = http.createServer(app);

  server.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                   Claude-Mem Viewer                        ║
║                  (Simplified Architecture)                 ║
╠════════════════════════════════════════════════════════════╣
║  URL: http://localhost:${port.toString().padEnd(37)}║
║  API: http://localhost:${port}/api/stats${' '.repeat(24)}║
╚════════════════════════════════════════════════════════════╝
`);

    const memory = getSimpleMemory();
    if (memory.isSemanticSearchAvailable()) {
      console.log('✓ Semantic search enabled (sqlite-lembed + all-MiniLM-L6-v2)');
    } else {
      console.log('⚠ Semantic search disabled (model not found)');
      console.log('  Run: npm run setup:model');
    }
    console.log('');
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close(() => {
      process.exit(0);
    });
  });
}

main().catch(err => {
  console.error('Failed to start viewer:', err);
  process.exit(1);
});
