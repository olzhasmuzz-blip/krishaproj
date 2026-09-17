import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'server'), { recursive: true });
fs.mkdirSync(path.join(dist, '.openai'), { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'worker.js'), path.join(dist, 'server', 'index.js'));
fs.copyFileSync(path.join(root, '.openai', 'hosting.json'), path.join(dist, '.openai', 'hosting.json'));
console.log('Built the API-only Worker entrypoint.');

