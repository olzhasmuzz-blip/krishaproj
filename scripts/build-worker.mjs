import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
const assets = { index: read('index.html'), styles: read('styles.css'), app: read('app.js'), favicon: read('favicon.svg') };
const runtime = fs.readFileSync(path.join(root, 'server', 'worker-runtime.js'), 'utf8');
const safe = value => JSON.stringify(value).replace(/<\//g, '<\\/');

const worker = `const assets={"/":{body:${safe(assets.index)},type:"text/html; charset=utf-8"},"/index.html":{body:${safe(assets.index)},type:"text/html; charset=utf-8"},"/styles.css":{body:${safe(assets.styles)},type:"text/css; charset=utf-8"},"/app.js":{body:${safe(assets.app)},type:"application/javascript; charset=utf-8"},"/favicon.svg":{body:${safe(assets.favicon)},type:"image/svg+xml"}};\n${runtime}\nexport default worker;`;
fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'server', 'index.js'), worker);
console.log('Generated dist/server/index.js');

