import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importanceLabels, importanceLabel, nodeImportance } from '../src/node-importance.mjs';
import { traceability, updateGraph } from '../server/traceability.mjs';

test('重要性仅接受三个等级，旧节点缺省普通，显式非法值拒绝', () => {
  assert.deepEqual(Object.keys(importanceLabels), ['core', 'key', 'normal']);
  assert.equal(nodeImportance(), 'normal');
  assert.equal(importanceLabel(), '普通组成逻辑');
  for (const level of Object.keys(importanceLabels)) assert.equal(nodeImportance(level), level);
  for (const value of [null, '', 'critical', 'CORE', 1, {}, 'toString']) assert.throws(() => nodeImportance(value), /importance 无效/);
});

test('等级保存读取与 JSON 往返一致；需求确认和执行绑定不变；非法值不落盘', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-importance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['contracts', 'src', 'server', 'tests']) await fs.mkdir(path.join(root, dir));
  const graphFile = path.join(root, 'contracts/project.json');
  const requirementFile = path.join(root, 'contracts/requirements.json');
  const requirements = JSON.stringify({ version: 1, featureId: 'project', requirements: [{
    id: 'REQ_ONE', nodeId: 'one', title: '已确认需求', description: '保持原意', status: 'confirmed', revision: 1,
    confirmedText: { title: '已确认需求', description: '保持原意' }, confirmedAt: '2026-11-13T00:00:00Z'
  }] });
  await fs.writeFile(requirementFile, requirements);
  await fs.writeFile(graphFile, JSON.stringify({ version: 2, feature: { id: 'project', title: '测试项目', goal: '验证' }, nodes: [{
    id: 'one', parentId: null, kind: 'logic', title: '处理', position: { x: 0, y: 0 }, input: '输入', output: '结果', capabilityId: 'project.execute'
  }], edges: [] }));
  let view = await traceability(root);
  assert.equal(view.projectGraph.nodes[0].importance, undefined);
  assert.equal(nodeImportance(view.projectGraph.nodes[0].importance), 'normal');
  for (const importance of ['core', 'key', 'normal']) {
    const imported = JSON.parse(JSON.stringify(view.projectGraph));
    imported.nodes[0].importance = importance;
    view = await updateGraph({ featureId: 'project', expectedGraph: view.projectGraph, graph: imported }, root);
    assert.equal(view.projectGraph.nodes[0].importance, importance);
    assert.equal(JSON.parse(await fs.readFile(graphFile, 'utf8')).nodes[0].importance, importance);
    assert.equal((await traceability(root)).projectGraph.nodes[0].importance, importance);
    assert.match(await fs.readFile(path.join(root, 'traceability/project.rst'), 'utf8'), new RegExp(`:importance: ${importance}`));
    assert.equal(view.projectGraph.nodes[0].capabilityId, 'project.execute');
    assert.equal(view.requirements[0].status, 'confirmed');
    assert.equal(await fs.readFile(requirementFile, 'utf8'), requirements);
  }
  const saved = await fs.readFile(graphFile, 'utf8');
  for (const importance of ['urgent', null, 3]) {
    const invalid = structuredClone(view.projectGraph); invalid.nodes[0].importance = importance;
    await assert.rejects(updateGraph({ featureId: 'project', expectedGraph: view.projectGraph, graph: invalid }, root), error => error.status === 400 && /importance 无效/.test(error.message));
    assert.equal(await fs.readFile(graphFile, 'utf8'), saved);
  }
  const invalid = JSON.parse(saved); invalid.nodes[0].importance = 'urgent';
  await fs.writeFile(graphFile, JSON.stringify(invalid));
  await assert.rejects(traceability(root), /importance 无效/);
});
