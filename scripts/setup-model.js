#!/usr/bin/env node
/**
 * Setup script to download the embedding model for sqlite-lembed
 *
 * Downloads all-MiniLM-L6-v2 GGUF model (~24MB) to ~/.claude-mem/models/
 */

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, createWriteStream, unlinkSync } from 'fs';
import { get } from 'https';

const MODEL_URL = 'https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf';
const MODEL_DIR = join(homedir(), '.claude-mem', 'models');
const MODEL_PATH = join(MODEL_DIR, 'all-MiniLM-L6-v2.gguf');

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function downloadModel() {
  // Check if model already exists
  if (existsSync(MODEL_PATH)) {
    console.log('✓ Model already exists at', MODEL_PATH);
    return;
  }

  // Ensure directory exists
  if (!existsSync(MODEL_DIR)) {
    mkdirSync(MODEL_DIR, { recursive: true });
    console.log('Created directory:', MODEL_DIR);
  }

  console.log('Downloading all-MiniLM-L6-v2 embedding model...');
  console.log('Source:', MODEL_URL);
  console.log('Destination:', MODEL_PATH);
  console.log('');

  const tempPath = MODEL_PATH + '.tmp';

  return new Promise((resolve, reject) => {
    const file = createWriteStream(tempPath);
    let downloadedBytes = 0;
    let totalBytes = 0;
    let lastPercent = -1;

    const request = get(MODEL_URL, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        console.log('Following redirect...');
        get(redirectUrl, handleResponse).on('error', handleError);
        return;
      }

      handleResponse(response);
    });

    function handleResponse(response) {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      if (totalBytes > 0) {
        console.log(`File size: ${formatBytes(totalBytes)}`);
      }

      response.pipe(file);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.floor((downloadedBytes / totalBytes) * 100);
          if (percent !== lastPercent && percent % 10 === 0) {
            process.stdout.write(`\rProgress: ${percent}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
            lastPercent = percent;
          }
        }
      });

      response.on('end', () => {
        file.close();
        console.log('\n');

        // Rename temp file to final path
        const fs = require('fs');
        fs.renameSync(tempPath, MODEL_PATH);

        console.log('✓ Download complete!');
        console.log('Model saved to:', MODEL_PATH);
        resolve();
      });
    }

    function handleError(err) {
      // Clean up temp file
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
      reject(err);
    }

    request.on('error', handleError);
    file.on('error', handleError);
  });
}

// Run
downloadModel()
  .then(() => {
    console.log('\n✅ Setup complete! Semantic search is now available.');
  })
  .catch((err) => {
    console.error('\n❌ Download failed:', err.message);
    console.error('\nYou can manually download the model with:');
    console.error(`  curl -L -o "${MODEL_PATH}" "${MODEL_URL}"`);
    process.exit(1);
  });
