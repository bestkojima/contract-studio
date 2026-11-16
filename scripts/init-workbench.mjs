#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const template = fileURLToPath(new URL('../assets/workbench/', import.meta.url));
const omitted = new Set(['node_modules', '.venv', '.git', '_build', 'dist', '__pycache__', '.env']);

export async function initWorkbench(destination) {
  const target = path.resolve(destination);
  const relative = path.relative(template, target);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Choose a destination outside the bundled template.');
  }
  try {
    if ((await fs.readdir(target)).length) throw new Error('Destination must be new or empty: ' + target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (git.error || git.status !== 0) throw new Error('Git is required to initialize the workbench.');
  await fs.cp(template, target, {
    recursive: true,
    filter: source => !omitted.has(path.basename(source)) && !source.endsWith('.log') && !source.endsWith('.pyc'),
  });
  const existing = spawnSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true });
  if (existing.status !== 0) {
    const initialized = spawnSync('git', ['-C', target, 'init'], { encoding: 'utf8', windowsHide: true });
    if (initialized.status !== 0) throw new Error(initialized.stderr || 'Could not initialize Git in ' + target);
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    console.log('Usage: node init-workbench.mjs <new-or-empty-directory>');
    process.exitCode = args[0] === '--help' ? 0 : 1;
  } else {
    try {
      const target = await initWorkbench(args[0]);
      console.log(`Created workbench: ${target}\n\nNext:\n  cd "${target}"\n  npm install\n  uv sync --locked --python 3.12\n  node scripts/build-index.mjs\n  npm run dev -- --host 127.0.0.1`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
