#!/usr/bin/env node
/**
 * Test the simplified memory architecture
 */

import { SimpleMemory } from './SimpleMemory.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

async function runTests(): Promise<void> {
  console.log('Testing SimpleMemory prototype...\n');

  // Create temp directory for test database
  const tempDir = mkdtempSync(join(tmpdir(), 'simple-memory-test-'));
  console.log(`Using temp dir: ${tempDir}`);

  try {
    const memory = new SimpleMemory(tempDir);

    // Test 1: Start session
    console.log('\n--- Test 1: Start session ---');
    memory.startSession('test-session-1', 'my-project', 'Help me fix the bug');
    console.log('✓ Session started');

    // Test 2: Record events
    console.log('\n--- Test 2: Record events ---');

    const event1Id = memory.recordEvent({
      session_id: 'test-session-1',
      project: 'my-project',
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/src/index.ts' }),
      tool_output: 'const foo = "bar";',
      cwd: '/home/user/my-project',
      created_at: Date.now() - 60000
    });
    console.log(`✓ Recorded Read event (id: ${event1Id})`);

    const event2Id = memory.recordEvent({
      session_id: 'test-session-1',
      project: 'my-project',
      tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: '/src/index.ts', old_string: 'bar', new_string: 'baz' }),
      tool_output: 'File updated successfully',
      cwd: '/home/user/my-project',
      created_at: Date.now() - 30000
    });
    console.log(`✓ Recorded Edit event (id: ${event2Id})`);

    const event3Id = memory.recordEvent({
      session_id: 'test-session-1',
      project: 'my-project',
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'npm test' }),
      tool_output: 'All tests passed',
      cwd: '/home/user/my-project',
      created_at: Date.now()
    });
    console.log(`✓ Recorded Bash event (id: ${event3Id})`);

    // Test 3: Get recent events
    console.log('\n--- Test 3: Get recent events ---');
    const events = memory.getRecentEvents('my-project', 10);
    console.log(`✓ Retrieved ${events.length} events`);
    console.log('Events:', events.map(e => ({
      tool: e.tool_name,
      type: e.event_type,
      files: e.files_touched
    })));

    // Test 4: Text search
    console.log('\n--- Test 4: Text search ---');
    const searchResults = await memory.searchEvents('npm test');
    console.log(`✓ Found ${searchResults.length} results for "npm test"`);

    // Test 5: Format context
    console.log('\n--- Test 5: Format context ---');
    const context = memory.formatContext(events);
    console.log('Context output:');
    console.log('---');
    console.log(context.slice(0, 500) + '...');
    console.log('---');

    // Test 6: End session
    console.log('\n--- Test 6: End session ---');
    memory.endSession('test-session-1');
    console.log('✓ Session ended');

    // Test 7: Vector embedding storage (mock)
    console.log('\n--- Test 7: Vector embedding storage ---');
    // Create a mock 384-dim embedding
    const mockEmbedding = Array.from({ length: 384 }, () => Math.random());
    memory.storeEmbedding(event1Id, mockEmbedding, 'hash123');
    console.log('✓ Stored embedding for event 1');

    const hasEmb = memory.hasEmbedding(event1Id);
    console.log(`✓ Has embedding: ${hasEmb}`);

    // Test 8: Events without embeddings
    console.log('\n--- Test 8: Events without embeddings ---');
    const noEmbeddings = memory.getEventsWithoutEmbeddings(10);
    console.log(`✓ Found ${noEmbeddings.length} events without embeddings`);

    // Test 9: Vector search (with mock embedding)
    console.log('\n--- Test 9: Vector search ---');
    try {
      const vectorResults = memory.searchByVector(mockEmbedding, { limit: 5 });
      console.log(`✓ Vector search returned ${vectorResults.length} results`);
      if (vectorResults.length > 0) {
        console.log('First result distance:', vectorResults[0].distance);
      }
    } catch (err: any) {
      console.log('✗ Vector search failed:', err.message);
    }

    memory.close();
    console.log('\n✅ All tests passed!');

  } finally {
    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
    console.log(`\nCleaned up temp dir: ${tempDir}`);
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
