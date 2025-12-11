// Export main components
export { DatabaseManager, getDatabase, initializeDatabase } from './Database.js';

// Export session store (CRUD operations for sessions, observations, summaries)
export { SessionStore } from './SessionStore.js';

// Export session search (structured filters - vector search handled by Chroma)
export { SessionSearch } from './SessionSearch.js';

// Export types
export * from './types.js';

// Export migrations
export { migrations } from './migrations.js';
