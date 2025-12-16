/**
 * Context Hook - SessionStart (Simplified Architecture)
 *
 * Direct SQLite access using SimpleMemory - no HTTP worker required.
 * Uses sqlite-vec for vector search and sqlite-lembed for embeddings.
 * Supports preloading project-specific knowledge from .claude-mem/preload/
 */

import path from 'path';
import { stdin } from 'process';
import { getSimpleMemory } from '../core/SimpleMemory.js';
import { parsePreloadFiles } from '../utils/preload-parser.js';

export interface SessionStartInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
}

/**
 * Sync preload files - import new, update changed, remove deleted
 */
function syncPreloadFiles(projectRoot: string, project: string): { added: number; updated: number; removed: number } {
  const result = { added: 0, updated: 0, removed: 0 };

  try {
    const preloadResult = parsePreloadFiles(projectRoot);
    if (!preloadResult || preloadResult.files.length === 0) {
      return result;
    }

    const memory = getSimpleMemory();
    const existingFiles = memory.getPreloadFiles(project);
    const existingMap = new Map(existingFiles.map(f => [f.path, f]));

    // Process each preload file
    for (const file of preloadResult.files) {
      const existing = existingMap.get(file.path);

      if (!existing) {
        // New file - import
        memory.importPreloadFile(project, file.path, file.hash, file.title, file.category, file.content);
        result.added++;
      } else if (existing.hash !== file.hash) {
        // Changed file - update
        memory.updatePreloadFile(project, file.path, file.hash, file.title, file.category, file.content, existing.event_id);
        result.updated++;
      }
      // Unchanged files are skipped
    }

    // Remove deleted files
    const currentPaths = preloadResult.files.map(f => f.path);
    result.removed = memory.removeStalePreloadFiles(project, currentPaths);

    return result;
  } catch (error: any) {
    // Silent failure for preload
    console.error('[context-hook] Preload sync error:', error.message);
    return result;
  }
}

/**
 * Generate context for session start
 */
function generateContext(input?: SessionStartInput): string {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  try {
    const memory = getSimpleMemory();

    // Start/update session
    if (input?.session_id) {
      memory.startSession(input.session_id, project, '');
    }

    // Sync preload files (add new, update changed, remove deleted)
    // These are indexed for semantic search but NOT injected into context
    const preloadSync = syncPreloadFiles(cwd, project);
    if (preloadSync.added > 0 || preloadSync.updated > 0 || preloadSync.removed > 0) {
      console.error(`[claude-mem] Preload indexed: +${preloadSync.added} ~${preloadSync.updated} -${preloadSync.removed} files`);
    }

    // Get recent events for this project (excludes preload events)
    const events = memory.getRecentEvents(project, 50);

    if (events.length === 0) {
      return '';
    }

    // Format as context
    const context = memory.formatContext(events);

    // Wrap in system tag to prevent recursive storage
    return `<claude-mem-context>\n${context}\n</claude-mem-context>`;
  } catch (error: any) {
    // Silent failure - don't block session start
    console.error('[context-hook] Error:', error.message);
    return '';
  }
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes('--colors');

if (stdin.isTTY || forceColors) {
  const text = generateContext(undefined);
  console.log(text);
  process.exit(0);
} else {
  let input = '';
  stdin.on('data', (chunk) => (input += chunk));
  stdin.on('end', () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const text = generateContext(parsed);

    if (text) {
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: text,
          },
        })
      );
    } else {
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: true,
        })
      );
    }
    process.exit(0);
  });
}
