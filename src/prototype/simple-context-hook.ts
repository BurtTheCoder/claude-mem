#!/usr/bin/env node
/**
 * Simplified SessionStart context hook
 *
 * Key differences from current architecture:
 * - Direct SQLite access (no HTTP to worker)
 * - No worker startup required
 * - Fast synchronous read
 */

import { getSimpleMemory } from './SimpleMemory.js';
import { basename } from 'path';

interface HookInput {
  session_id: string;
  cwd: string;
}

async function main(): Promise<void> {
  // Parse stdin (Claude Code hook input)
  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const input: HookInput = JSON.parse(inputData);

  // Get project name from cwd
  const project = basename(input.cwd);

  // Get direct database access
  const memory = getSimpleMemory();

  // Get recent events
  const events = memory.getRecentEvents(project, 50);

  if (events.length === 0) {
    // No context to inject
    return;
  }

  // Format and output context
  const context = memory.formatContext(events);

  // Output as system prompt injection
  const output = {
    result: context
  };

  console.log(JSON.stringify(output));
}

main().catch(err => {
  // Silent failure for hooks - don't block session start
  console.error('[simple-context-hook] Error:', err.message);
});
