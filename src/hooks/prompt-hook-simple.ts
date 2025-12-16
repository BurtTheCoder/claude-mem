/**
 * User Prompt Hook - UserPromptSubmit (Simplified Architecture)
 *
 * Smart context injection based on user's prompt:
 * - Detects if prompt references past work/history
 * - Performs semantic search to find relevant events
 * - Injects relevant context alongside the prompt
 *
 * Direct SQLite access using SimpleMemory - no HTTP worker required.
 */

import path from 'path';
import { stdin } from 'process';
import { getSimpleMemory } from '../prototype/SimpleMemory.js';
import { stripMemoryTagsFromPrompt } from '../utils/tag-stripping.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
}

/**
 * Patterns that suggest user is asking about past work
 */
const HISTORY_PATTERNS = [
  // Direct questions about past
  /\b(last time|previously|before|earlier|yesterday|last week|last session)\b/i,
  /\b(did (i|we|you)|have (i|we|you)|was there)\b.*\b(do|change|fix|add|create|implement|write)\b/i,
  /\b(what|how|when|where|why) did (i|we|you)\b/i,

  // References to past work
  /\b(remember|recall|mentioned|discussed|worked on|dealt with)\b/i,
  /\b(the .+ (bug|issue|problem|error|feature) (i|we))\b/i,
  /\b(continue|pick up|resume|get back to)\b.*\b(where|what)\b/i,

  // Explicit history queries
  /\b(history|past|previous|recent)\b.*\b(work|changes|sessions?|commits?)\b/i,
  /\bwhat (have|has) (been|changed|happened)\b/i,

  // File-specific history
  /\b(changes?|edits?|modifications?) to .+\.(ts|js|py|go|rs|java|c|cpp|h|md|json|yaml|yml)\b/i,
];

/**
 * Check if prompt seems to reference past work
 */
function looksLikeHistoryQuery(prompt: string): boolean {
  const cleanPrompt = prompt.toLowerCase();

  // Quick exit for very short prompts
  if (cleanPrompt.length < 10) return false;

  // Check against patterns
  return HISTORY_PATTERNS.some(pattern => pattern.test(prompt));
}

/**
 * Format search results for context injection
 */
function formatSearchResults(results: any[], query: string): string {
  if (results.length === 0) {
    return '';
  }

  const lines: string[] = [
    `<claude-mem-context>`,
    `## Relevant Past Work`,
    `_(Found ${results.length} related events for: "${query.slice(0, 50)}${query.length > 50 ? '...' : ''}")_\n`,
  ];

  for (const result of results.slice(0, 10)) { // Limit to top 10
    const event = result.event;
    const date = new Date(event.created_at).toLocaleDateString();
    const time = new Date(event.created_at).toLocaleTimeString();
    const files = event.files_touched?.join(', ') || '';
    const fileInfo = files ? ` (${files})` : '';

    lines.push(`### ${date} ${time} - ${event.tool_name}${fileInfo}`);

    // Add relevant output (truncated)
    if (event.tool_output) {
      const preview = event.tool_output.slice(0, 300);
      lines.push('```');
      lines.push(preview + (event.tool_output.length > 300 ? '...' : ''));
      lines.push('```');
    }
    lines.push('');
  }

  lines.push(`</claude-mem-context>`);
  return lines.join('\n');
}

/**
 * Main hook logic
 */
function promptHook(input?: UserPromptSubmitInput): string | null {
  if (!input) {
    return null;
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);

  // Strip privacy tags from prompt
  const cleanPrompt = stripMemoryTagsFromPrompt(prompt);

  // Skip if prompt was entirely private
  if (!cleanPrompt.trim()) {
    return null;
  }

  try {
    const memory = getSimpleMemory();

    // Update session with this prompt
    memory.startSession(session_id, project, cleanPrompt.slice(0, 500));

    // Check if this looks like a history query
    if (!looksLikeHistoryQuery(cleanPrompt)) {
      // Not a history query - no additional context needed
      return null;
    }

    // Check if semantic search is available
    if (!memory.isSemanticSearchAvailable()) {
      // Fall back to text search
      const results = memory.searchEvents(cleanPrompt, {
        project,
        limit: 10,
        semantic: false
      });

      if (results.length === 0) {
        return null;
      }

      return formatSearchResults(results, cleanPrompt);
    }

    // Perform semantic search
    const results = memory.searchEvents(cleanPrompt, {
      project,
      limit: 10,
      semantic: true
    });

    if (results.length === 0) {
      return null;
    }

    // Format and return context
    return formatSearchResults(results, cleanPrompt);
  } catch (error: any) {
    // Silent failure - don't block the prompt
    console.error('[prompt-hook] Error:', error.message);
    return null;
  }
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => (input += chunk));
stdin.on('end', () => {
  const parsed = input ? JSON.parse(input) : undefined;
  const additionalContext = promptHook(parsed);

  // Build response
  const response: any = {
    continue: true,
    suppressOutput: true,
  };

  // Add context if we found relevant history
  if (additionalContext) {
    response.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    };
  }

  console.log(JSON.stringify(response));
});
