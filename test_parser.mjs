import { runAddLibrary } from './lib/mock-api.mjs';
import fs from 'fs';

async function test() {
  try {
    console.log("Testing Mock API...");
    // Mock file object
    const file = {
      path: './test_dummy.pdf',
      originalname: 'test.pdf',
      mimetype: 'application/pdf'
    };
    // Create dummy file
    fs.writeFileSync(file.path, 'Dummy PDF content for parsing test');
    
    await runAddLibrary(null, { file, displayName: 'Test Doc' });
    console.log("SUCCESS: Parser ran without runtime errors.");
    fs.unlinkSync(file.path);
  } catch (err) {
    console.error("RUNTIME ERROR:", err);
    process.exit(1);
  }
}

test();
