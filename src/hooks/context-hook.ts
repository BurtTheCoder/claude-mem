/**
 * Context Hook - SessionStart (Simplified Architecture)
 *
 * Direct SQLite access using SimpleMemory - no HTTP worker required.
 * Uses sqlite-vec for vector search and sqlite-lembed for embeddings.
 */

import path from 'path';
import { stdin } from 'process';
import { getSimpleMemory } from '../core/SimpleMemory.js';

export interface SessionStartInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
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

    // Get recent events for this project
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
