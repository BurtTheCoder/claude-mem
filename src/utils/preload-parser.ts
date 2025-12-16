/**
 * Preload Parser - Import project-specific knowledge into memory
 *
 * Parses markdown files from .claude-mem/preload/ directory and converts
 * them into searchable tool events. Uses file hashes to detect changes
 * and only re-imports when files are added/modified.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, extname } from 'path';

export interface PreloadFile {
  path: string;           // Relative path from preload dir
  absolutePath: string;   // Full filesystem path
  content: string;        // File content
  hash: string;           // MD5 hash of content
  title: string;          // Extracted or derived title
  category?: string;      // Directory name if in subdirectory
}

export interface PreloadResult {
  files: PreloadFile[];
  preloadDir: string;
}

/**
 * Find the preload directory for a project
 */
export function findPreloadDir(projectRoot: string): string | null {
  const preloadDir = join(projectRoot, '.claude-mem', 'preload');
  return existsSync(preloadDir) ? preloadDir : null;
}

/**
 * Recursively find all markdown files in a directory
 */
function findMarkdownFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      files.push(...findMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Extract title from markdown content
 * Looks for # heading or uses filename
 */
function extractTitle(content: string, filename: string): string {
  // Look for first H1 heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Look for YAML frontmatter title
  const frontmatterMatch = content.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  // Fall back to filename without extension
  return basename(filename, extname(filename))
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract category from file path (subdirectory name)
 */
function extractCategory(relativePath: string): string | undefined {
  const parts = relativePath.split('/');
  if (parts.length > 1) {
    return parts[0]
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return undefined;
}

/**
 * Parse a single markdown file
 */
function parseFile(absolutePath: string, preloadDir: string): PreloadFile {
  const content = readFileSync(absolutePath, 'utf-8');
  const relativePath = relative(preloadDir, absolutePath);
  const hash = createHash('md5').update(content).digest('hex');

  return {
    path: relativePath,
    absolutePath,
    content,
    hash,
    title: extractTitle(content, absolutePath),
    category: extractCategory(relativePath),
  };
}

/**
 * Parse all preload files from a project
 */
export function parsePreloadFiles(projectRoot: string): PreloadResult | null {
  const preloadDir = findPreloadDir(projectRoot);

  if (!preloadDir) {
    return null;
  }

  const markdownFiles = findMarkdownFiles(preloadDir);
  const files = markdownFiles.map(f => parseFile(f, preloadDir));

  return {
    files,
    preloadDir,
  };
}

/**
 * Get hash of all preload files (for change detection)
 */
export function getPreloadManifestHash(files: PreloadFile[]): string {
  const manifest = files
    .map(f => `${f.path}:${f.hash}`)
    .sort()
    .join('\n');

  return createHash('md5').update(manifest).digest('hex');
}

/**
 * Format preload file as tool event data
 */
export function formatAsToolEvent(file: PreloadFile, project: string): {
  session_id: string;
  project: string;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  cwd: string;
  created_at: number;
  files_touched: string[];
  event_type: string;
} {
  const metadata: Record<string, string> = {
    source: 'preload',
    path: file.path,
    title: file.title,
  };

  if (file.category) {
    metadata.category = file.category;
  }

  return {
    session_id: `preload-${project}`,
    project,
    tool_name: 'PreloadedKnowledge',
    tool_input: JSON.stringify(metadata),
    tool_output: file.content,
    cwd: '',
    created_at: Date.now(),
    files_touched: [file.path],
    event_type: 'preload',
  };
}
