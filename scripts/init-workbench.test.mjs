import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initWorkbench } from './init-workbench.mjs';

test('initialize a relocatable neutral workbench without copying local dependencies', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-skill-init-'));
  const installed = path.join(temp, 'installed-skill');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  await fs.cp(packageRoot, installed, { recursive: true, filter: source => !['node_modules', '.venv', '_build', 'dist', '__pycache__'].includes(path.basename(source)) });
  const { initWorkbench: relocatedInit } = await import(pathToFileURL(path.join(installed, 'scripts/init-workbench.mjs')));
  const target = await relocatedInit(path.join(temp, 'app'));
  const graph = JSON.parse(await fs.readFile(path.join(target, 'contracts/project.json'), 'utf8'));
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, 'root');
  const { featureRegistry } = await import(pathToFileURL(path.join(target, 'server/feature-registry.mjs')));
  assert.equal(featureRegistry.features.length, 1);
  assert.equal(featureRegistry.capabilities.length, 0);
  assert.equal(spawnSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true');
  for (const entry of ['node_modules', '.venv', 'dist', 'traceability/_build']) {
    await assert.rejects(fs.access(path.join(target, entry)), { code: 'ENOENT' });
  }
  await assert.rejects(relocatedInit(target), /new or empty/);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'contracts/project.json'), 'utf8')).nodes[0].id, 'root');
});

test('existing repository is reused; bundled template cannot be its own destination', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-skill-parent-'));
  assert.equal(spawnSync('git', ['-C', parent, 'init']).status, 0);
  const target = await initWorkbench(path.join(parent, 'workbench'));
  await assert.rejects(fs.access(path.join(target, '.git')), { code: 'ENOENT' });
  const template = fileURLToPath(new URL('../assets/workbench', import.meta.url));
  await assert.rejects(initWorkbench(template), /outside/);
  await assert.rejects(initWorkbench(path.join(template, 'nested')), /outside/);
});
