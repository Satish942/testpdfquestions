import fs from 'fs';
import path from 'path';

// Mock the environment
const STORE_DIR = './.gemini/antigravity/brain/9662e214-f4f9-4ff2-a5ad-a95c7e49e9ce/mock_store';
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

async function test() {
  try {
    console.log("Starting code integrity test...");
    
    // We'll import the function but it has side effects (filesystem)
    // To safe-test logic, we'll just check if the file is syntactically valid by importing it
    const module = await import('./lib/mock-api.mjs');
    console.log("SUCCESS: mock-api.mjs is syntactically valid.");
  } catch (err) {
    console.error("SYNTAX/RUNTIME ERROR:", err);
    process.exit(1);
  }
}

test();
