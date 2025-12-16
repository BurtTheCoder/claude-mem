#!/usr/bin/env node

/**
 * Build script for claude-mem (simplified architecture)
 * Bundles TypeScript hooks into standalone executables using esbuild
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simplified architecture: 3 hooks with direct SQLite access
const HOOKS = [
  { name: 'context-hook', source: 'src/hooks/context-hook.ts' },
  { name: 'new-hook', source: 'src/hooks/new-hook.ts' },
  { name: 'save-hook', source: 'src/hooks/save-hook.ts' },
];

// Viewer server (optional, for browsing history)
const VIEWER_SERVER = {
  name: 'viewer-server',
  source: 'src/services/viewer-server.ts'
};

async function buildHooks() {
  console.log('🔨 Building claude-mem (simplified architecture)...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Create output directories
    console.log('\n📦 Preparing output directories...');
    const hooksDir = 'plugin/scripts';
    const uiDir = 'plugin/ui';

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    if (!fs.existsSync(uiDir)) {
      fs.mkdirSync(uiDir, { recursive: true });
    }
    console.log('✓ Output directories ready');

    // Generate plugin/package.json for runtime dependencies
    // Native modules are external and installed in the plugin cache directory
    console.log('\n📦 Generating plugin package.json...');
    const pluginPackageJson = {
      name: 'claude-mem-plugin',
      version: version,
      private: true,
      description: 'Runtime dependencies for claude-mem hooks',
      type: 'module',
      dependencies: {
        'better-sqlite3': packageJson.dependencies['better-sqlite3'],
        'sqlite-vec': packageJson.dependencies['sqlite-vec'],
        'sqlite-lembed': packageJson.dependencies['sqlite-lembed'],
      },
      engines: {
        node: '>=18.0.0'
      }
    };
    fs.writeFileSync('plugin/package.json', JSON.stringify(pluginPackageJson, null, 2) + '\n');
    console.log('✓ plugin/package.json generated');

    // Build React viewer
    console.log('\n📋 Building React viewer...');
    const { spawn } = await import('child_process');
    const viewerBuild = spawn('node', ['scripts/build-viewer.js'], { stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      viewerBuild.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Viewer build failed with exit code ${code}`));
        }
      });
    });

    // Build viewer server
    console.log(`\n🔧 Building viewer server...`);
    await build({
      entryPoints: [VIEWER_SERVER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: `${hooksDir}/${VIEWER_SERVER.name}.js`,
      minify: true,
      logLevel: 'error',
      external: ['better-sqlite3', 'sqlite-vec', 'sqlite-lembed'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });
    fs.chmodSync(`${hooksDir}/${VIEWER_SERVER.name}.js`, 0o755);
    const viewerStats = fs.statSync(`${hooksDir}/${VIEWER_SERVER.name}.js`);
    console.log(`✓ viewer-server built (${(viewerStats.size / 1024).toFixed(2)} KB)`);

    // Build each hook
    for (const hook of HOOKS) {
      console.log(`\n🔧 Building ${hook.name}...`);

      const outfile = `${hooksDir}/${hook.name}.js`;

      await build({
        entryPoints: [hook.source],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'esm',
        outfile,
        minify: true,
        external: ['better-sqlite3', 'sqlite-vec', 'sqlite-lembed'],
        define: {
          '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
        },
        banner: {
          js: '#!/usr/bin/env node'
        }
      });

      // Make executable
      fs.chmodSync(outfile, 0o755);

      // Check file size
      const stats = fs.statSync(outfile);
      const sizeInKB = (stats.size / 1024).toFixed(2);
      console.log(`✓ ${hook.name} built (${sizeInKB} KB)`);
    }

    console.log('\n✅ Build complete!');
    console.log(`   Output: ${hooksDir}/`);
    console.log('   Hooks:');
    console.log('   - context-hook.js (SessionStart: inject recent context)');
    console.log('   - save-hook.js (PostToolUse: record events)');
    console.log('   - new-hook.js (UserPromptSubmit: smart semantic search)');
    console.log('   Viewer:');
    console.log('   - viewer-server.js (optional: browse history at localhost:37777)');
    console.log('\n💡 Note: Run "npm run setup:model" to enable semantic search');

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    if (error.errors) {
      console.error('\nBuild errors:');
      error.errors.forEach(err => console.error(`  - ${err.text}`));
    }
    process.exit(1);
  }
}

buildHooks();
