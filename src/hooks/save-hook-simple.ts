/**
 * Save Hook - PostToolUse (Simplified Architecture)
 *
 * Direct SQLite access using SimpleMemory - no HTTP worker required.
 * Deterministic metadata extraction, no LLM processing on write path.
 */

import path from 'path';
import { stdin } from 'process';
import { getSimpleMemory } from '../prototype/SimpleMemory.js';
import { stripMemoryTagsFromJson } from '../utils/tag-stripping.js';

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
}

// Tools to skip (don't add value to memory)
const SKIP_TOOLS = new Set([
  'TodoWrite',
  'SlashCommand',
  'Skill',
  'AskUserQuestion',
  'ExitPlanMode',
]);

/**
 * Save tool event to memory
 */
function saveEvent(input?: PostToolUseInput): void {
  if (!input) {
    return;
  }

  const { session_id, cwd, tool_name, tool_input, tool_response } = input;

  // Skip certain tools
  if (SKIP_TOOLS.has(tool_name)) {
    return;
  }

  const project = cwd ? path.basename(cwd) : 'unknown-project';

  try {
    // Serialize and strip privacy tags
    const inputStr = typeof tool_input === 'string'
      ? tool_input
      : JSON.stringify(tool_input);
    const outputStr = typeof tool_response === 'string'
      ? tool_response
      : JSON.stringify(tool_response);

    const cleanInput = stripMemoryTagsFromJson(inputStr);
    const cleanOutput = stripMemoryTagsFromJson(outputStr);

    // Skip if everything was stripped (was all private content)
    if (!cleanInput && !cleanOutput) {
      return;
    }

    const memory = getSimpleMemory();

    // Record the event (synchronous, no LLM)
    memory.recordEvent({
      session_id,
      project,
      tool_name,
      tool_input: cleanInput,
      tool_output: cleanOutput,
      cwd: cwd || '',
      created_at: Date.now(),
    });
  } catch (error: any) {
    // Silent failure - don't block tool execution
    console.error('[save-hook] Error:', error.message);
  }
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => (input += chunk));
stdin.on('end', () => {
  const parsed = input ? JSON.parse(input) : undefined;
  saveEvent(parsed);

  // Standard response for PostToolUse
  console.log(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
    })
  );
});
