import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traceability, exportNeeds, updateRequirement, updateGraph, sourceAt, isLocalRequest, isLocalWrite } from '../server/traceability.mjs';
import { api } from '../server/api.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-studio-trace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['contracts', 'src', 'server', 'tests']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'contracts', 'requirements.json'), JSON.stringify({version:1, featureId:'demo', requirements:[{id:'REQ_ONE',nodeId:'one',title:'原需求',description:'原描述',status:'draft',revision:1}]}));
  await fs.writeFile(path.join(root, 'contracts', 'project.json'), JSON.stringify({version:2, feature:{id:'demo',title:'示例',goal:'测试'}, nodes:[{id:'one',parentId:null,title:'功能一',input:'In',output:'Out',position:{x:0,y:0}},{id:'two',parentId:'one',title:'功能二',input:'In',output:'Out',position:{x:1,y:0}}],edges:[{id:'e1',source:'one',target:'two',sourceHandle:'fail',targetHandle:'in',label:'失败'}]}));
  await fs.writeFile(path.join(root, 'src', 'demo.ts'), '// @need-ids: REQ_ONE\nexport const a = 1;\n');
  await fs.writeFile(path.join(root, 'tests', 'demo.mjs'), '// @need-ids: REQ_ONE\n');
  await exportNeeds(root);
  return root;
}

test('需求创建、确认、修改回草稿及生成 RST 同步', async t => {
  const root = await fixture(t);
  let data = await traceability(root);
  assert.equal(data.sphinx.state, 'current');
  assert.deepEqual(data.requirements[0].code, [{path:'src/demo.ts',line:1}]);
  assert.deepEqual(data.requirements[0].tests, [{path:'tests/demo.mjs',line:1}]);
  data = await updateRequirement({action:'confirm',id:'REQ_ONE',revision:1,title:'原需求',description:'原描述'}, root);
  assert.equal(data.requirements[0].status, 'confirmed');
  assert.equal(data.requirements[0].revision, 2);
  data = await updateRequirement({action:'save',id:'REQ_ONE',revision:2,title:'修订需求',description:'原描述'}, root);
  assert.equal(data.requirements[0].status, 'draft');
  assert.equal(data.sphinx.state, 'current');
  assert.match(await fs.readFile(path.join(root, 'traceability', 'project.rst'), 'utf8'), /修订需求/);
  await assert.rejects(updateRequirement({action:'confirm',id:'REQ_ONE',revision:1,title:'原需求',description:'原描述'}, root), e => e.status === 409);
  data = await updateRequirement({action:'create',featureId:'demo',id:'REQ_TWO',nodeId:'two',title:'新需求',description:'新描述'}, root);
  assert.equal(data.requirements[1].status, 'draft');
  await assert.rejects(updateRequirement({action:'create',featureId:'demo',id:'REQ_TWO',nodeId:'other',title:'新需求',description:'新描述'}, root), e => e.status === 409);
});

test('项目图生成独立的需求、包含与流程关系，保留边原始分支并检测外部修改', async t => {
  const root = await fixture(t);
  let before = await traceability(root);
  let rst = await fs.readFile(path.join(root, 'traceability', 'project.rst'), 'utf8');
  assert.match(rst, /:fulfills: REQ_ONE/);
  assert.match(rst, /:contains: FUNC_74776F/);
  assert.match(rst, /:flows_to: FUNC_74776F/);
  assert.match(rst, /"sourceHandle":"fail"/);
  const next = structuredClone(before.projectGraph);
  next.nodes.push({id:'three',parentId:'one',title:'新增节点',input:'In',output:'Out',position:{x:3,y:0}});
  const {version,feature,nodes,edges} = before.projectGraph;
  const reorderedBaseline = {edges,nodes,feature,version};
  const updated = await updateGraph({featureId:'demo',expectedGraph:reorderedBaseline,graph:next}, root);
  assert.equal(updated.sphinx.state, 'current');
  assert.equal(updated.projectGraph.nodes.length, 3);
  rst = await fs.readFile(path.join(root, 'traceability', 'project.rst'), 'utf8');
  assert.match(rst, /:contains: FUNC_74776F, FUNC_7468726565/);
  await assert.rejects(updateGraph({featureId:'demo',expectedGraph:before.projectGraph,graph:next}, root), e => e.status === 409);
  const file = path.join(root, 'contracts', 'project.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  disk.nodes[1].title = '外部修改';
  await fs.writeFile(file, JSON.stringify(disk));
  before = await traceability(root);
  assert.equal(before.sphinx.state, 'outdated');
  await assert.rejects(updateGraph({featureId:'demo',expectedGraph:next,graph:next}, root), e => e.status === 409);
});

test('保存图拒绝缺少输入输出或非法端口，保留项目文件；旧图仍可读取', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'contracts', 'project.json');
  const originalBytes = await fs.readFile(file, 'utf8');
  const baseline = (await traceability(root)).projectGraph;
  const missingOutput = structuredClone(baseline);
  delete missingOutput.nodes[0].output;
  await assert.rejects(updateGraph({featureId:'demo',expectedGraph:baseline,graph:missingOutput}, root), /缺少输入或输出/);
  assert.equal(await fs.readFile(file, 'utf8'), originalBytes);
  const badPort = structuredClone(baseline);
  badPort.edges[0].sourceHandle = 'unknown';
  await assert.rejects(updateGraph({featureId:'demo',expectedGraph:baseline,graph:badPort}, root), /输出端口无效/);
  assert.equal(await fs.readFile(file, 'utf8'), originalBytes);
  await fs.writeFile(file, JSON.stringify(missingOutput));
  assert.equal((await traceability(root)).projectGraph.nodes[0].output, undefined);
});

test('源码定位仅允许已标记的路径和行号', async t => {
  const root = await fixture(t);
  const source = await sourceAt('src/demo.ts', 1, root);
  assert.match(source.excerpt, /export const a/);
  await assert.rejects(sourceAt('contracts/requirements.json', 1, root), e => e.status === 404);
  await assert.rejects(sourceAt('../outside', 1, root), e => e.status === 404);
});

test('直接修改已确认的需求也会撤销确认并标记 RST 过期', async t => {
  const root = await fixture(t);
  await updateRequirement({action:'confirm',id:'REQ_ONE',revision:1,title:'原需求',description:'原描述'}, root);
  const file = path.join(root, 'contracts', 'requirements.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  disk.requirements[0].description = '从文件直接修改';
  await fs.writeFile(file, JSON.stringify(disk));
  const data = await traceability(root);
  assert.equal(data.requirements[0].status, 'draft');
  assert.equal(data.requirements[0].revision, 3);
  assert.equal(data.sphinx.state, 'outdated');
  await assert.rejects(updateRequirement({action:'confirm',id:'REQ_ONE',revision:2,title:'原需求',description:'原描述'}, root), e => e.status === 409);
});

test('写入端点仅接受本机、同源 JSON', () => {
  const request = (remote, origin, host = 'localhost:5173') => ({socket:{remoteAddress:remote},headers:{host,origin,'content-type':'application/json'}});
  assert.equal(isLocalWrite(request('127.0.0.1','http://localhost:5173')), true);
  assert.equal(isLocalWrite(request('192.168.1.2','http://localhost:5173')), false);
  assert.equal(isLocalWrite(request('127.0.0.1','https://evil.example')), false);
  assert.equal(isLocalWrite(request('127.0.0.1','http://evil.example','evil.example')), false);
});

test('追踪读取仅接受本机及匹配的来源和主机', () => {
  const request = (remote, host, origin) => ({ socket:{remoteAddress:remote}, headers:{host,origin} });
  assert.equal(isLocalRequest(request('127.0.0.1', 'localhost:5173', 'http://localhost:5173')), true);
  assert.equal(isLocalRequest(request('::1', '[::1]:5173')), true);
  assert.equal(isLocalRequest(request('192.168.1.2', 'localhost:5173')), false);
  assert.equal(isLocalRequest(request('127.0.0.1', 'evil.example:5173')), false);
  assert.equal(isLocalRequest(request('127.0.0.1', 'localhost:5173', 'https://evil.example')), false);
});

test('两个追踪读取端点拒绝远程请求，允许本机访问', async () => {
  async function get(url, remoteAddress) {
    const req = { url, method:'GET', socket:{remoteAddress}, headers:{host:'localhost:5173'} };
    const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await api(req, res, () => assert.fail('unexpected next'));
    return res;
  }
  const local = await get('/api/traceability', '127.0.0.1');
  assert.equal(local.statusCode, 200);
  assert.deepEqual(local.body.requirements, []);
  const sourceUrl = '/api/traceability/source?path=server/unbound.mjs&line=1';
  assert.equal((await get(sourceUrl, '127.0.0.1')).statusCode, 404);
  assert.equal((await get('/api/traceability', '192.168.1.2')).statusCode, 403);
  assert.equal((await get(sourceUrl, '192.168.1.2')).statusCode, 403);
});

test('项目图保存端点拒绝远程请求', async () => {
  const req = { url:'/api/traceability/graph', method:'POST', socket:{remoteAddress:'192.168.1.2'}, headers:{host:'localhost:5173','content-type':'application/json'} };
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await api(req, res, () => assert.fail('unexpected next'));
  assert.equal(res.statusCode, 403);
});

test('通用契约检查允许新增节点并拒绝不存在的边端点', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-studio-check-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'contracts'));
  const graph = JSON.parse(await fs.readFile(new URL('../contracts/project.json', import.meta.url), 'utf8'));
  graph.nodes.push({id:'extra',parentId:'root',title:'新增设计',position:{x:0,y:0},input:'In',output:'Out'});
  const file = path.join(root, 'contracts', 'project.json');
  const script = new URL('../scripts/check-contract.mjs', import.meta.url);
  await fs.writeFile(file, JSON.stringify(graph));
  assert.doesNotThrow(() => execFileSync(process.execPath, [fileURLToPath(script)], {cwd:root,stdio:'pipe'}));
  graph.edges = [{id:'invalid',source:'root',target:'missing',sourceHandle:'ok'}];
  await fs.writeFile(file, JSON.stringify(graph));
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(script)], {cwd:root,stdio:'pipe'}));
});
