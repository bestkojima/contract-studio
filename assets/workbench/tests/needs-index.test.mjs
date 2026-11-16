import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNeedsIndex, buildNeedsIndex, normalizeCodeUrl, sourceRevision } from '../server/needs-index.mjs';
import { traceability, exportNeeds, updateRequirement, sourceAt, buildTraceabilityIndex } from '../server/traceability.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=path.join(project,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
async function fixture(t,{configured=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-index-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['contracts','src','features/demo','server','tests','traceability','server/native'])await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.writeFile(path.join(root,'contracts/requirements.json'),JSON.stringify({version:1,featureId:'demo',requirements:[{id:'REQ_ONE',nodeId:'one',title:'原需求',description:'原描述',status:'draft',revision:1}]}));
  await fs.writeFile(path.join(root,'contracts/project.json'),JSON.stringify({version:2,feature:{id:'demo',title:'示例',goal:'验证'},nodes:[{id:'one',title:'功能一',input:'In',output:'Out',parentId:null,position:{x:0,y:0}},{id:'two',title:'功能二',input:'In',output:'Out',parentId:'one',position:{x:10,y:0}}],edges:[{id:'e',source:'one',target:'two',sourceHandle:'ok',label:'有效'}]}));
  await fs.writeFile(path.join(root,'src/demo.ts'),'// @need-ids: REQ_ONE\nexport const value=1;\n');
  await fs.writeFile(path.join(root,'features/demo/client.tsx'),'// @need-ids: REQ_ONE\nexport function Demo(){return null;}\n');
  await fs.writeFile(path.join(root,'tests/demo.mjs'),'// @need-ids: REQ_ONE, TEST_ONE\nexport function testOne() { return true; }\n');
  if(configured){
    await fs.writeFile(path.join(root,'tests/unattached.mjs'),'// @need-ids: TEST_ONE\n');
    await fs.copyFile(path.join(project,'traceability/conf.py'),path.join(root,'traceability/conf.py'));
    // A local-URL fixture has no repository; Git URL discovery is irrelevant here.
    await fs.appendFile(path.join(root,'traceability/conf.py'),"\nsuppress_warnings += ['codelinks.git_root']\n");
    const config=await fs.readFile(path.join(project,'traceability/ubproject.toml'),'utf8');
    await fs.writeFile(path.join(root,'traceability/ubproject.toml'),config.replace('src_dir = "../features"','src_dir = "../features/demo"'));
    await fs.writeFile(path.join(root,'traceability/index.rst'),'Index\n=====\n\n.. toctree::\n\n   project\n\n'+['frontend','features','backend','tests'].map(name=>`.. src-trace::\n   :project: ${name}\n`).join('\n')+'\n.. test:: Independent test\n   :id: TEST_ONE\n');
  }
  await exportNeeds(root);
  return root;
}

test('旧独立项目无 Python 配置仍保留引用形状、保存及显式来源',async t=>{
  const root=await fixture(t);let result=await traceability(root);
  assert.equal(result.index.state,'unconfigured');assert.equal(result.index.source,'local-marker');
  assert.deepEqual(result.requirements[0].tests,[{path:'tests/demo.mjs',line:1}]);
  assert.deepEqual((await readNeedsIndex(root)).entities,[]);
  result=await updateRequirement({id:'REQ_ONE',revision:1,title:'原需求',description:'原描述',action:'confirm'},root);
  assert.equal(result.requirements[0].status,'confirmed');
});

test('实体导出器属于索引修订，修改构建逻辑会改变候选',async t=>{
  const root=await fixture(t);
  await fs.mkdir(path.join(root,'scripts'));
  const file=path.join(root,'scripts/build-needs.py');
  await fs.writeFile(file,'# first\n');
  const before=await sourceRevision(root);
  assert.ok(before['scripts/build-needs.py']);
  await fs.appendFile(file,'# changed export\n');
  assert.notDeepEqual(await sourceRevision(root),before);
});

test('一节点多需求、跨节点关联与验收独立确认保留旧文字确认',async t=>{
  const root=await fixture(t);
  let view=await updateRequirement({id:'REQ_ONE',revision:1,title:'原需求',description:'原描述',action:'confirm'},root);
  const original=view.requirements[0];
  const acceptance=[{id:'AC_ONE',input:'有效请求',expected:'完成',observable:'状态更新'}];
  view=await updateRequirement({id:'REQ_ONE',revision:2,title:original.title,description:original.description,action:'save',acceptance,nodeIds:['one','two']},root);
  let req=view.requirements[0];assert.equal(req.status,'confirmed');assert.equal(req.confirmedAt,original.confirmedAt);assert.deepEqual(req.confirmedText,original.confirmedText);assert.equal(req.acceptanceStatus,'draft');
  view=await updateRequirement({featureId:'demo',id:'REQ_TWO',nodeIds:['one'],title:'另一需求',description:'共享节点',action:'create'},root);
  assert.equal(view.requirements.filter(r=>r.nodeIds.includes('one')).length,2);
  assert.match(await fs.readFile(path.join(root,'traceability/project.rst'),'utf8'),/:fulfills: REQ_ONE, REQ_TWO/);
  view=await updateRequirement({id:'REQ_ONE',revision:req.revision,title:req.title,description:req.description,action:'save',confirmAcceptance:true},root);
  req=view.requirements[0];assert.equal(req.acceptanceStatus,'confirmed');assert.deepEqual(req.confirmedAcceptance,acceptance);
  const disk=JSON.parse(await fs.readFile(path.join(root,'contracts/requirements.json'),'utf8'));disk.requirements[0].acceptance[0].expected='2';await fs.writeFile(path.join(root,'contracts/requirements.json'),JSON.stringify(disk));
  req=(await traceability(root)).requirements[0];assert.equal(req.acceptanceStatus,'draft');assert.equal(req.status,'confirmed');
});

test('真实 Sphinx 构建统一需求关系、多 CodeLinks 引用与源位置',{skip:!existsSync(python)&&'先运行 uv sync --locked 启用真实 Sphinx 集成测试'},async t=>{
  const root=await fixture(t,{configured:true});
  const graphFile=path.join(root,'contracts/project.json');
  const graph=JSON.parse(await fs.readFile(graphFile,'utf8'));graph.nodes[0].importance='core';
  await fs.writeFile(graphFile,JSON.stringify(graph));
  const built=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(built.index.state,'current',built.index.error);
  assert.equal(built.index.source,'sphinx-needs+codelinks');
  assert.equal(built.relations.find(r=>r.id==='FUNC_6F6E65').fulfills[0],'REQ_ONE');
  assert.deepEqual(built.relations.find(r=>r.id==='FUNC_6F6E65').contains,['FUNC_74776F']);
  assert.deepEqual(built.relations.find(r=>r.id==='FUNC_6F6E65').flowsTo,['FUNC_74776F']);
  assert.equal(built.relations.find(r=>r.id==='FUNC_6F6E65').importance,'core');
  assert.equal(built.relations.find(r=>r.id==='FUNC_74776F').importance,'normal');
  const {needs,entities,refs}=await readNeedsIndex(root);
  assert.equal(needs.FUNC_6F6E65.importance,'core');
  assert.equal(needs.FUNC_74776F.importance,'normal');
  assert.equal(needs.REQ_ONE.importance,null); // Field belongs to spec nodes, not requirement confirmation.
  const demo=entities.find(entity=>entity.path==='features/demo/client.tsx');
  assert.deepEqual(demo,{path:'features/demo/client.tsx',symbol:'Demo',signature:'function Demo(){return null;}',startLine:2,endLine:2,kind:'function',language:'typescript',needIds:['REQ_ONE'],markerLines:[1],source:'sphinx-codelinks',indexState:'current'});
  const testEntity=entities.find(entity=>entity.path==='tests/demo.mjs');
  assert.equal(testEntity.symbol,'testOne');
  assert.deepEqual(testEntity.needIds,['REQ_ONE','TEST_ONE']);
  assert.equal(refs.get('TEST_ONE')[0].scope.symbol,'testOne');
  assert.equal(refs.get('REQ_ONE').find(ref=>ref.path===demo.path).scope.symbol,'Demo');
  const unattached=entities.find(entity=>entity.path==='tests/unattached.mjs');
  assert.deepEqual(Object.fromEntries(['symbol','signature','startLine','endLine','kind','language'].map(key=>[key,unattached[key]])),{symbol:null,signature:null,startLine:null,endLine:null,kind:null,language:null});
  const req=built.requirements[0];
  for(const file of ['src/demo.ts','features/demo/client.tsx'])assert.ok(req.code.some(ref=>ref.path===file&&ref.source==='sphinx-codelinks'),file);
  assert.ok(req.tests.some(ref=>ref.path==='tests/demo.mjs'&&ref.source==='sphinx-codelinks'));
  assert.equal(await normalizeCodeUrl(root,'../outside#L1'),null);
  assert.equal(await normalizeCodeUrl(root,'https://example.com/evil#L1'),null);
  assert.equal(await normalizeCodeUrl(root,'src/demo.ts#L999'),null);
  const previous=await fs.readFile(path.join(root,'traceability/_build/needs/needs.json'),'utf8');
  const previousEntities=await fs.readFile(path.join(root,'traceability/_build/needs/code-entities.json'),'utf8');
  // A successful build of old RST must not certify externally edited JSON.
  const requirementFile=path.join(root,'contracts/requirements.json');
  const edited=JSON.parse(await fs.readFile(requirementFile,'utf8'));edited.requirements[0].title='外部编辑';
  await fs.writeFile(requirementFile,JSON.stringify(edited));
  await buildNeedsIndex(root,{python});
  assert.equal((await traceability(root)).index.state,'stale');
  edited.requirements[0].title='原需求';await fs.writeFile(requirementFile,JSON.stringify(edited));
  await fs.writeFile(path.join(root,'src/demo.ts'),'// moved\n// @need-ids: REQ_ONE\nexport const value=1;\n');
  const stale=await readNeedsIndex(root);
  assert.equal(stale.index.state,'stale');
  assert.equal(stale.entities.find(entity=>entity.path==='src/demo.ts').indexState,'stale');
  assert.ok(!stale.refs.get('REQ_ONE').some(ref=>ref.scope));
  await assert.rejects(sourceAt('src/demo.ts',1,root),e=>e.status===404);
  const failed=await buildNeedsIndex(root,{runner:async()=>{throw Error('deliberate build failure');}});
  assert.equal(failed.state,'failed');assert.match(failed.error,/deliberate/);
  const preserved=JSON.parse(await fs.readFile(path.join(root,'traceability/_build/needs/needs.json'),'utf8'));
  assert.deepEqual(preserved.versions[preserved.current_version].needs,JSON.parse(previous).versions[''].needs);
  assert.equal(await fs.readFile(path.join(root,'traceability/_build/needs/code-entities.json'),'utf8'),previousEntities);
  assert.ok((await readNeedsIndex(root)).entities.every(entity=>entity.indexState==='failed'));
  const invalid=await buildNeedsIndex(root,{runner:async(_python,args)=>{
    await fs.writeFile(path.join(args[2],'code-entities.json'),JSON.stringify({schemaVersion:99,entities:[]}));
  }});
  assert.equal(invalid.state,'failed');assert.match(invalid.error,/code-entities/);
  assert.equal(await fs.readFile(path.join(root,'traceability/_build/needs/code-entities.json'),'utf8'),previousEntities);
  const saved=await updateRequirement({id:'REQ_ONE',revision:1,title:'已保存原文',description:'原描述',action:'save'},root);
  assert.equal(saved.requirements[0].title,'已保存原文');assert.equal(saved.index.state,'failed');
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'contracts/requirements.json'),'utf8')).requirements[0].title,'已保存原文');
});

test('显式重建仅同步已存在来源，旧独立调用无需补齐其他示例或 Python',async t=>{
  const root=await fixture(t);
  const file=path.join(root,'contracts/requirements.json');
  const data=JSON.parse(await fs.readFile(file,'utf8'));data.requirements[0].title='外部修改的旧项目';
  const original=JSON.stringify(data);await fs.writeFile(file,original);
  const result=await buildTraceabilityIndex(root);
  assert.equal(result.sphinx.state,'current');assert.equal(result.index.state,'unconfigured');
  assert.match(await fs.readFile(path.join(root,'traceability/project.rst'),'utf8'),/外部修改的旧项目/);
  assert.equal(await fs.readFile(file,'utf8'),original);
  assert.equal(existsSync(path.join(root,'contracts/unregistered.json')),false);
});

test('原生 CodeLinks 声明自动生成实体、验收关联和安全定位',{skip:!existsSync(python)&&'先运行 uv sync --locked 启用真实 Sphinx 集成测试'},async t=>{
  const root=await fixture(t,{configured:true});
  await fs.appendFile(path.join(root,'traceability/conf.py'),"\nfor _project in src_trace_projects.values():\n    _project['analyse']['get_multiline_needs'] = True\n");
  const requirementFile=path.join(root,'contracts/requirements.json');
  const requirements=JSON.parse(await fs.readFile(requirementFile,'utf8'));
  requirements.requirements[0].acceptance=[{id:'AC_ONE',input:'1,2',expected:'3',observable:'求和结果'}];
  await fs.writeFile(requirementFile,JSON.stringify(requirements));
  await exportNeeds(root);
  await fs.writeFile(path.join(root,'server/native.mjs'),[
    '// @need impl: Native sum', '// :id: IMPL_NATIVE', '// :implements: FUNC_6F6E65', '// @endneed',
    'export function nativeSum(a, b) { return a + b; }', '',
    '// @ Native helper, IMPL_NATIVE_ONE, impl', 'export function nativeHelper() { return 1; }', '',
  ].join('\n'));
  const testFile=path.join(root,'tests/native.test.mjs');
  const testSource=[
    "import test from 'node:test';", '// @need test: Native acceptance', '// :id: TEST_NATIVE',
    '// :verifies: REQ_ONE.AC_ONE', '// @endneed', "test('[TEST_NATIVE] adds values', () => {});", '',
  ].join('\n');
  await fs.writeFile(testFile,testSource);
  let built=await buildNeedsIndex(root,{python});
  assert.equal(built.state,'current',built.error);
  let {needs,entities,refs}=await readNeedsIndex(root);
  assert.deepEqual(needs.TEST_NATIVE.verifies,['REQ_ONE.AC_ONE']);
  assert.deepEqual(needs.REQ_ONE.parts.AC_ONE.verifies_back,['TEST_NATIVE']);
  assert.deepEqual(needs.IMPL_NATIVE.implements,['FUNC_6F6E65']);
  const implementation=entities.find(entity=>entity.needIds.includes('IMPL_NATIVE'));
  assert.equal(implementation.symbol,'nativeSum');
  assert.equal(implementation.startLine,5);
  assert.equal(implementation.endLine,5);
  assert.deepEqual(implementation.declarations,[{needId:'IMPL_NATIVE',line:1,endLine:4,kind:'multiline-need'}]);
  const oneLine=entities.find(entity=>entity.needIds.includes('IMPL_NATIVE_ONE'));
  assert.equal(oneLine.symbol,'nativeHelper');
  assert.equal(oneLine.declarations[0].kind,'need');
  const anonymous=entities.find(entity=>entity.needIds.includes('TEST_NATIVE'));
  assert.equal(anonymous.path,'tests/native.test.mjs');
  assert.deepEqual(anonymous.markerLines,[2]);
  assert.deepEqual(Object.fromEntries(['symbol','signature','startLine','endLine','kind','language'].map(key=>[key,anonymous[key]])),{symbol:null,signature:null,startLine:null,endLine:null,kind:null,language:null});
  assert.equal(refs.get('TEST_NATIVE')[0].line,2);
  assert.equal(refs.get('IMPL_NATIVE')[0].scope.symbol,'nativeSum');
  assert.match((await sourceAt('tests/native.test.mjs',2,root)).excerpt,/TEST_NATIVE/);
  // Unrelated changes keep a verified source location, but never current scope.
  await fs.appendFile(path.join(root,'src/demo.ts'),'// unrelated change\n');
  let stale=await readNeedsIndex(root);
  assert.equal(stale.index.state,'stale');
  assert.equal(stale.refs.get('TEST_NATIVE')[0].line,2);
  assert.equal(stale.refs.get('TEST_NATIVE')[0].scope,undefined);
  // Moving a declaration invalidates the old source record until another build.
  await fs.writeFile(testFile,'// inserted line\n'+testSource);
  stale=await readNeedsIndex(root);
  assert.deepEqual(stale.refs.get('TEST_NATIVE'),[]);
  await assert.rejects(sourceAt('tests/native.test.mjs',2,root),error=>error.status===404);
  built=await buildNeedsIndex(root,{python});
  assert.equal(built.state,'current',built.error);
  assert.equal((await readNeedsIndex(root)).refs.get('TEST_NATIVE')[0].line,3);
  // Removing the marker and failing a build preserves history, not a live link.
  await fs.writeFile(testFile,"import test from 'node:test';\n\ntest('unmarked', () => {});\n");
  built=await buildNeedsIndex(root,{runner:async()=>{throw Error('native fixture failure');}});
  assert.equal(built.state,'failed');
  const failed=await readNeedsIndex(root);
  assert.ok(failed.needs.TEST_NATIVE);
  assert.deepEqual(failed.refs.get('TEST_NATIVE'),[]);
  await assert.rejects(sourceAt('tests/native.test.mjs',3,root),error=>error.status===404);
});



test('new local Git repository builds without remote or commit while unknown source references still fail',{skip:!existsSync(python)&&'先运行 uv sync --locked 启用真实 Sphinx 集成测试'},async t=>{
  const root=await fixture(t,{configured:true});
  // Exercise the exact shipped config, without the no-repository fixture override.
  await fs.copyFile(path.join(project,'traceability/conf.py'),path.join(root,'traceability/conf.py'));
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(git('init','--quiet').status,0);
  assert.equal(git('remote').stdout.trim(),'');
  assert.notEqual(git('rev-parse','--verify','HEAD').status,0);
  const built=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(built.index.state,'current',built.index.error);
  const linked=await readNeedsIndex(root);
  assert.equal(linked.refs.get('REQ_ONE').find(ref=>ref.path==='features/demo/client.tsx').scope.symbol,'Demo');
  assert.equal(linked.entities.find(entity=>entity.path==='tests/demo.mjs').symbol,'testOne');
  assert.equal(git('remote').stdout.trim(),'');
  assert.notEqual(git('rev-parse','--verify','HEAD').status,0);
  await fs.appendFile(path.join(root,'src/demo.ts'),'// @need-ids: REQ_UNKNOWN\nexport const unknown=2;\n');
  const rejected=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(rejected.index.state,'failed');
  assert.match(rejected.index.error,/unknown need.*REQ_UNKNOWN/);
});
