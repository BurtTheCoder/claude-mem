#!/usr/bin/env node
/**
 * Simplified PostToolUse hook
 *
 * Key differences from current architecture:
 * - Direct SQLite access (no HTTP to worker)
 * - No LLM processing on write path
 * - Deterministic metadata extraction
 * - Synchronous, fast execution
 */

import { getSimpleMemory } from './SimpleMemory.js';
import { basename } from 'path';

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: string;
  tool_result: string;
}

async function main(): Promise<void> {
  // Parse stdin (Claude Code hook input)
  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const input: HookInput = JSON.parse(inputData);

  // Skip certain tools that don't add value
  const skipTools = ['TodoWrite', 'SlashCommand', 'Skill', 'AskUserQuestion'];
  if (skipTools.includes(input.tool_name)) {
    return;
  }

  // Get project name from cwd
  const project = basename(input.cwd);

  // Get direct database access
  const memory = getSimpleMemory();

  // Record event (synchronous, no LLM)
  memory.recordEvent({
    session_id: input.session_id,
    project,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_output: input.tool_result,
    cwd: input.cwd,
    created_at: Date.now()
  });

  // No output needed - fire and forget
}

main().catch(err => {
  // Silent failure for hooks
  console.error('[simple-save-hook] Error:', err.message);
});
