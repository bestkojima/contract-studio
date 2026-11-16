import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openSource } from '../server/editor.mjs';
import { api } from '../server/api.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio editor '));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  for (const dir of ['src','server','tests']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'src', 'demo.ts'), '// @need-ids: REQ_DEMO\nexport const n = 1;\n');
  await fs.writeFile(path.join(root, 'tests', 'demo.test.mjs'), '// @need-ids: REQ_DEMO\n');
  const local = path.join(root, 'apps');
  const executable = path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe');
  await fs.mkdir(path.dirname(executable), {recursive:true});
  await fs.writeFile(executable, '');
  const systemRoot = path.join(root, 'windows');
  await fs.mkdir(path.join(systemRoot, 'System32'), {recursive:true});
  await fs.writeFile(path.join(systemRoot, 'System32', 'notepad.exe'), '');
  return {root, executable, env:{LOCALAPPDATA:local, SystemRoot:systemRoot, PATH:''}};
}

test('VS Code 以参数安全打开标记源码和测试并定位目标行', async t => {
  const {root, executable, env} = await fixture(t);
  const calls = [];
  for (const file of ['src/demo.ts', 'tests/demo.test.mjs']) {
    const response = await openSource({path:file,line:1,editor:'vscode'}, {root,platform:'win32',env,launch:async (...args) => calls.push(args)});
    assert.equal(response.lineJumped, true);
    assert.deepEqual(calls.at(-1), [executable, ['--goto', `${await fs.realpath(path.join(root,file))}:1`]]);
  }
});

test('记事本只打开文件，并明确提示用户手动定位行号', async t => {
  const {root, env} = await fixture(t);
  let call;
  const response = await openSource({path:'tests/demo.test.mjs',line:1,editor:'notepad'}, {root,platform:'win32',env,launch:async (...args) => {call=args;}});
  assert.equal(response.lineJumped, false);
  assert.match(response.message, /Ctrl\+G.*第 1 行/);
  assert.deepEqual(call, [path.join(env.SystemRoot,'System32','notepad.exe'), [await fs.realpath(path.join(root,'tests/demo.test.mjs'))]]);
});

test('拒绝未标记位置和任意编辑器；缺失或启动失败返回明确错误', async t => {
  const {root, env} = await fixture(t);
  const calls = [];
  const options = {root,platform:'win32',env,launch:async (...args) => calls.push(args)};
  for (const body of [
    {path:'../outside',line:1,editor:'vscode'},
    {path:'src/demo.ts',line:2,editor:'vscode'},
    {path:'src/demo.ts',line:1,editor:'cmd'},
    {path:'src/demo.ts',line:'1',editor:'vscode'},
  ]) await assert.rejects(openSource(body, options));
  assert.equal(calls.length, 0);
  await assert.rejects(openSource({path:'src/demo.ts',line:1,editor:'vscode'}, {...options,env:{PATH:''}}), /未找到 VS Code/);
  await assert.rejects(openSource({path:'src/demo.ts',line:1,editor:'vscode'}, {...options,launch:async () => {throw new Error('permission denied');}}), /无法启动 VS Code.*permission denied/);
});

test('编辑器端点要求本机同源 JSON，并拒绝未关联的文件', async () => {
  async function request(remote, origin, contentType = 'application/json') {
    const req = Readable.from([JSON.stringify({path:'../outside',line:1,editor:'vscode'})]);
    Object.assign(req, {url:'/api/open-source',method:'POST',socket:{remoteAddress:remote},headers:{host:'localhost:5173',origin,'content-type':contentType}});
    const res = {setHeader() {}, end(body) {this.body=JSON.parse(body);}};
    await api(req,res,()=>assert.fail('unexpected next'));
    return res;
  }
  assert.equal((await request('192.168.1.2','http://localhost:5173')).statusCode, 403);
  assert.equal((await request('127.0.0.1','https://evil.example')).statusCode, 403);
  assert.equal((await request('127.0.0.1',undefined)).statusCode, 403);
  assert.equal((await request('127.0.0.1','http://localhost:5173','text/plain')).statusCode, 403);
  assert.equal((await request('127.0.0.1','http://localhost:5173')).statusCode, 404);
});
