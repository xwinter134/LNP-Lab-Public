// Copies the web app into dist/ for the Tauri bundle (no build step otherwise).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('app', 'dist/app', { recursive: true });
console.log('dist/ ready');
