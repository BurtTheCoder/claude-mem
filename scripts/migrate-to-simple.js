#!/usr/bin/env node
/**
 * Migration script: Import existing claude-mem data into SimpleMemory
 *
 * Converts observations from the current architecture (claude-mem.db)
 * into tool events in the simplified architecture (simple-memory.db)
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

const DATA_DIR = join(homedir(), '.claude-mem');
const OLD_DB_PATH = join(DATA_DIR, 'claude-mem.db');
const NEW_DB_PATH = join(DATA_DIR, 'simple-memory.db');

function formatCount(n) {
  return n.toLocaleString();
}

async function migrate() {
  console.log('Claude-mem Migration Tool');
  console.log('=========================\n');

  // Check if old database exists
  if (!existsSync(OLD_DB_PATH)) {
    console.log('No existing database found at', OLD_DB_PATH);
    console.log('Nothing to migrate.\n');
    return;
  }

  console.log('Source:', OLD_DB_PATH);
  console.log('Destination:', NEW_DB_PATH);
  console.log('');

  // Open databases
  const oldDb = new Database(OLD_DB_PATH, { readonly: true });
  const newDb = new Database(NEW_DB_PATH);

  // Configure new database
  newDb.pragma('journal_mode = WAL');
  newDb.pragma('synchronous = NORMAL');

  // Create schema in new database if needed
  newDb.exec(`
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
      migrated_from TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON tool_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_project ON tool_events(project);
    CREATE INDEX IF NOT EXISTS idx_events_created ON tool_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_tool ON tool_events(tool_name);
  `);

  // Get counts
  let observationCount = 0;
  let sessionCount = 0;
  let summaryCount = 0;

  try {
    observationCount = oldDb.prepare('SELECT COUNT(*) as count FROM observations').get()?.count || 0;
  } catch { /* table might not exist */ }

  try {
    sessionCount = oldDb.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get()?.count || 0;
  } catch { /* table might not exist */ }

  try {
    summaryCount = oldDb.prepare('SELECT COUNT(*) as count FROM session_summaries').get()?.count || 0;
  } catch { /* table might not exist */ }

  console.log('Found in source database:');
  console.log(`  - ${formatCount(observationCount)} observations`);
  console.log(`  - ${formatCount(sessionCount)} sessions`);
  console.log(`  - ${formatCount(summaryCount)} summaries`);
  console.log('');

  // Migrate sessions
  console.log('Migrating sessions...');
  let migratedSessions = 0;

  try {
    const sessions = oldDb.prepare(`
      SELECT
        claude_session_id as id,
        project,
        user_prompt,
        started_at_epoch as started_at,
        completed_at_epoch as ended_at
      FROM sdk_sessions
    `).all();

    const insertSession = newDb.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, user_prompt, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.project || 'unknown',
        session.user_prompt || '',
        session.started_at || Date.now(),
        session.ended_at
      );
      migratedSessions++;
    }
    console.log(`  Migrated ${formatCount(migratedSessions)} sessions`);
  } catch (err) {
    console.log('  No sessions to migrate (table may not exist)');
  }

  // Migrate observations as synthetic tool events
  console.log('Migrating observations...');
  let migratedObservations = 0;

  try {
    const observations = oldDb.prepare(`
      SELECT
        sdk_session_id as session_id,
        project,
        text,
        type,
        title,
        subtitle,
        facts,
        narrative,
        files_read,
        files_modified,
        created_at_epoch as created_at
      FROM observations
      ORDER BY created_at_epoch ASC
    `).all();

    const insertEvent = newDb.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type, migrated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const obs of observations) {
      // Convert observation to synthetic tool event
      const toolInput = JSON.stringify({
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle
      });

      const toolOutput = obs.narrative || obs.text || '';

      // Combine files read and modified
      let filesTouched = [];
      try {
        if (obs.files_read) filesTouched.push(...JSON.parse(obs.files_read));
        if (obs.files_modified) filesTouched.push(...JSON.parse(obs.files_modified));
      } catch { /* ignore parse errors */ }

      // Map observation type to event type
      const eventTypeMap = {
        'decision': 'other',
        'bugfix': 'write',
        'feature': 'write',
        'refactor': 'write',
        'discovery': 'read',
        'change': 'write'
      };

      insertEvent.run(
        obs.session_id || 'unknown',
        obs.project || 'unknown',
        'Observation', // Synthetic tool name for migrated data
        toolInput,
        toolOutput,
        '', // No cwd in old schema
        obs.created_at || Date.now(),
        filesTouched.length > 0 ? JSON.stringify([...new Set(filesTouched)]) : null,
        eventTypeMap[obs.type] || 'other',
        'observation' // Mark as migrated
      );
      migratedObservations++;
    }
    console.log(`  Migrated ${formatCount(migratedObservations)} observations`);
  } catch (err) {
    console.log('  No observations to migrate (table may not exist)');
  }

  // Migrate summaries as synthetic tool events
  console.log('Migrating summaries...');
  let migratedSummaries = 0;

  try {
    const summaries = oldDb.prepare(`
      SELECT
        sdk_session_id as session_id,
        project,
        request,
        investigated,
        learned,
        completed,
        next_steps,
        files_read,
        files_edited,
        notes,
        created_at_epoch as created_at
      FROM session_summaries
      ORDER BY created_at_epoch ASC
    `).all();

    const insertEvent = newDb.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type, migrated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const summary of summaries) {
      const toolInput = JSON.stringify({
        request: summary.request
      });

      const parts = [];
      if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
      if (summary.learned) parts.push(`Learned: ${summary.learned}`);
      if (summary.completed) parts.push(`Completed: ${summary.completed}`);
      if (summary.next_steps) parts.push(`Next steps: ${summary.next_steps}`);
      if (summary.notes) parts.push(`Notes: ${summary.notes}`);

      const toolOutput = parts.join('\n\n');

      let filesTouched = [];
      try {
        if (summary.files_read) filesTouched.push(...JSON.parse(summary.files_read));
        if (summary.files_edited) filesTouched.push(...JSON.parse(summary.files_edited));
      } catch { /* ignore parse errors */ }

      insertEvent.run(
        summary.session_id || 'unknown',
        summary.project || 'unknown',
        'Summary', // Synthetic tool name for migrated data
        toolInput,
        toolOutput,
        '',
        summary.created_at || Date.now(),
        filesTouched.length > 0 ? JSON.stringify([...new Set(filesTouched)]) : null,
        'other',
        'summary' // Mark as migrated
      );
      migratedSummaries++;
    }
    console.log(`  Migrated ${formatCount(migratedSummaries)} summaries`);
  } catch (err) {
    console.log('  No summaries to migrate (table may not exist)');
  }

  // Close databases
  oldDb.close();
  newDb.close();

  const total = migratedSessions + migratedObservations + migratedSummaries;
  console.log('');
  console.log(`Migration complete! Migrated ${formatCount(total)} total records.`);
  console.log('');
  console.log('Note: The old database has NOT been modified or deleted.');
  console.log('You can safely delete it after verifying the migration:');
  console.log(`  rm "${OLD_DB_PATH}"`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
