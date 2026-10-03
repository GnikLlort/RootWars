import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientIndex = path.resolve(__dirname, '../../dist/client/index.html');

if (!fs.existsSync(clientIndex)) {
  console.log('[RootWars Dev] Building client assets...');
  execSync('npx vite build', { stdio: 'inherit' });
}

await import('./index.js');
