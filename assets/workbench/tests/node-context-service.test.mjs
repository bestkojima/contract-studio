import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeContext } from '../server/node-context.mjs';
import { runCapabilityTests, listCapabilities } from '../server/capabilities.mjs';

import { featureRegistry } from '../server/feature-registry.mjs';
// Execution declarations exist only in this isolated test process.
featureRegistry.capabilities.push(
  {id:'fixture.execute',nodeIds:['submit','validate','save'],testFiles:['tests/fixture.test.mjs'],frontend:{component:'FixturePanel',path:'features/fixture/client.tsx'}},
  {id:'fixture.secondary',nodeIds:['secondary','secondary-validate','secondary-save'],testFiles:['tests/secondary.test.mjs'],frontend:{component:'SecondaryPanel',path:'features/fixture/client.tsx'}}
);

const node = (id,parentId=null,extra={}) => ({id,parentId,title:`标题 ${id}`,kind:'logic',description:`职责 ${id}`,input:`输入 ${id}`,output:`输出 ${id}`,processing:`处理 ${id}`,acceptance:`验收 ${id}`,errors:['无效输入'],position:{x:0,y:0},...extra});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'studio-node-context-'));
  t.after(async()=>{
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    await fs.rm(root,{recursive:true,force:true});
  });
  for (const dir of ['contracts','src','server','tests']) await fs.mkdir(path.join(root,dir));
  const graph = {version:2,feature:{id:'demo',title:'独立契约',goal:'读取节点上下文'},nodes:[
    node('root',null,{kind:'group'}),node('input','root',{importance:'key'}),
    node('submit','root',{kind:'group',importance:'core',capabilityId:'fixture.execute'}),node('result','root'),
    node('validate','submit'),node('save','submit'),node('nested','validate'),node('unrelated')
  ],edges:[
    {id:'incoming',source:'input',target:'submit',sourceHandle:'ok',targetHandle:'in',label:'有效输入'},
    {id:'outgoing',source:'submit',target:'result',sourceHandle:'fail',targetHandle:'in',label:'失败展示'},
    {id:'internal',source:'validate',target:'save',sourceHandle:'ok',targetHandle:'in',label:'校验通过'},
    {id:'unrelated',source:'unrelated',target:'result',sourceHandle:'ok',targetHandle:'in',label:'无关分支'}
  ]};
  const requirement = {id:'REQ_FIXTURE',nodeId:'submit',nodeIds:['submit'],title:'已保存的需求',description:'需求保持项目保存内容',status:'confirmed',revision:2,
    confirmedText:{title:'已保存的需求',description:'需求保持项目保存内容'},
    acceptance:[{id:'AC_OK',input:'有效输入',expected:'成功结果',observable:'页面结果'}],acceptanceStatus:'draft'};
  await fs.writeFile(path.join(root,'contracts/project.json'),JSON.stringify(graph));
  await fs.writeFile(path.join(root,'contracts/requirements.json'),JSON.stringify({version:1,featureId:'demo',requirements:[requirement]}));
  await fs.writeFile(path.join(root,'src/demo.ts'),'// @need-ids: REQ_FIXTURE\nexport const value = 1;\n');
  await fs.writeFile(path.join(root,'tests/fixture.test.mjs'),"// @need-ids: REQ_FIXTURE\nimport test from 'node:test';import assert from 'node:assert/strict';test('fixture behaviour',()=>assert.equal(1+1,2));\n");
  return {root,graph};
}

test('saved context supplies one bounded contract for UI, documents and Agent without writes',async t=>{
  const {root} = await fixture(t);
  const before = await fs.readFile(path.join(root,'contracts/project.json'),'utf8');
  const {context,markdown,taskMarkdown} = await nodeContext({featureId:'demo',nodeId:'submit'},root);
  assert.deepEqual(context.provenance,{graph:'saved',requirements:'saved',semanticChanges:false,evidenceContractChanges:false});
  assert.equal(context.node.importance,'core');
  assert.equal(context.parent.id,'root');
  assert.deepEqual(context.ancestors.map(item=>item.id),['root']);
  assert.equal(context.incoming[0].node.importance,'key');
  assert.equal(context.outgoing[0].node.importance,'normal');
  assert.deepEqual(context.children.map(item=>item.id),['validate','save']);
  assert.deepEqual(context.internalEdges.map(item=>item.id),['internal']);
  assert.equal(context.requirements[0].status,'confirmed');
  assert.equal(context.requirements[0].acceptanceStatus,'draft');
  assert.deepEqual(context.code,[{path:'src/demo.ts',line:1}]);
  assert.deepEqual(context.tests,[{path:'tests/fixture.test.mjs',line:1}]);
  assert.equal(context.capability.id,'fixture.execute');
  assert.equal(context.frontend.component,'FixturePanel');
  assert.equal(context.evidence.state,'not-run');
  assert.ok(context.gaps.some(gap=>gap.code==='requirement.REQ_FIXTURE.acceptance-confirmation'));
  assert.match(markdown,/核心逻辑 \(core\)/);
  assert.match(markdown,/input · 标题 input \[ok\] → submit · 标题 submit \[in\]/);
  assert.match(markdown,/REQ_FIXTURE · 已保存的需求/);
  assert.match(markdown,/src\/demo.ts:1/);
  assert.doesNotMatch(markdown,/标题 nested|标题 unrelated|无关分支/);
  assert.ok(taskMarkdown.includes(markdown));
  assert.match(taskMarkdown,/本次任务授权/);
  assert.equal(await fs.readFile(path.join(root,'contracts/project.json'),'utf8'),before);
  await assert.rejects(fs.stat(path.join(root,'traceability')),error=>error.code==='ENOENT');
});

test('draft preview updates node and dependency documents while requirements and disk remain saved',async t=>{
  const {root,graph} = await fixture(t);
  const original = JSON.stringify(graph);
  graph.nodes.find(item=>item.id==='submit').description='草稿功能职责';
  graph.nodes.find(item=>item.id==='input').output='草稿输入依赖输出';
  graph.edges[1].label='草稿失败条件';
  const {context,markdown} = await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.deepEqual(context.provenance,{graph:'draft',requirements:'saved',semanticChanges:true,evidenceContractChanges:true});
  assert.equal(context.node.description,'草稿功能职责');
  assert.equal(context.requirements[0].description,'需求保持项目保存内容');
  assert.equal(context.evidence.state,'not-run');
  assert.equal(context.evidence.coversCurrentGraph,false);
  assert.match(markdown,/草稿输入依赖输出/);
  assert.match(markdown,/草稿失败条件/);
  assert.match(markdown,/尚未覆盖这份草稿/);
  assert.equal(await fs.readFile(path.join(root,'contracts/project.json'),'utf8'),original);
});

test('saved test evidence remains current for layout and importance, but never covers a semantic draft',async t=>{
  const {root,graph} = await fixture(t);
  const report = await runCapabilityTests('fixture.execute',root);
  assert.equal(report.state,'passed',report.output);
  graph.nodes.find(item=>item.id==='submit').importance='normal';
  graph.nodes.find(item=>item.id==='submit').position.x=200;
  graph.nodes.find(item=>item.id==='submit').size={width:300,height:150};
  let result = await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.equal(result.context.provenance.graph,'draft');
  assert.equal(result.context.provenance.semanticChanges,false);
  assert.equal(result.context.evidence.state,'passed');
  assert.equal(result.context.node.importance,'normal');
  graph.nodes.find(item=>item.id==='submit').processing='新增业务处理规则';
  result = await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.equal(result.context.evidence.state,'stale');
  assert.equal(result.context.savedEvidence.state,'passed');
  assert.equal(result.context.evidence.coversCurrentGraph,false);
  assert.match(result.markdown,/状态：待复验/);
  assert.equal((await nodeContext({featureId:'demo',nodeId:'submit'},root)).context.evidence.state,'passed');
});

test('secondary draft evidence follows its own nodes and incident edges, not unrelated graph changes',async t=>{
  const {root,graph}=await fixture(t);
  const rename=id=>({submit:'secondary',validate:'secondary-validate',save:'secondary-save'}[id]??id);
  graph.nodes=graph.nodes.map(item=>({...item,id:rename(item.id),parentId:rename(item.parentId),
    ...(item.capabilityId?{capabilityId:'fixture.secondary'}:{})}));
  graph.edges=graph.edges.map(edge=>({...edge,source:rename(edge.source),target:rename(edge.target)}));
  await fs.writeFile(path.join(root,'contracts/project.json'),JSON.stringify(graph));
  for(const file of listCapabilities().find(cap=>cap.id==='fixture.secondary').testFiles){
    await fs.writeFile(path.join(root,file),"import test from 'node:test';import assert from 'node:assert/strict';test('secondary fixture',()=>assert.equal(true,true));\n");
  }
  assert.equal((await runCapabilityTests('fixture.secondary',root)).state,'passed');
  const cases=[
    ['unrelated node',draft=>{draft.nodes.find(item=>item.id==='unrelated').processing='unrelated change';},false],
    ['unrelated edge',draft=>{draft.edges.find(edge=>edge.id==='unrelated').label='unrelated branch';},false],
    ['owned node',draft=>{draft.nodes.find(item=>item.id==='secondary-validate').processing='changed validation';},true],
    ['incident edge',draft=>{draft.edges.find(edge=>edge.id==='incoming').label='changed input condition';},true],
    ['new binding',draft=>{draft.nodes.find(item=>item.id==='unrelated').capabilityId='fixture.secondary';},true],
    ['layout and importance',draft=>{const item=draft.nodes.find(item=>item.id==='secondary');item.position.x=50;item.importance='normal';},false]
  ];
  for(const [label,change,affected] of cases){
    const draft=structuredClone(graph);change(draft);
    const {context}=await nodeContext({featureId:'demo',nodeId:'secondary',graph:draft},root);
    assert.equal(context.provenance.evidenceContractChanges,affected,label);
    assert.equal(context.evidence.state,affected?'stale':'passed',label);
    assert.equal(context.evidence.coversCurrentGraph,!affected,label);
    assert.equal(context.savedEvidence.state,'passed',label);
    assert.equal(context.provenance.semanticChanges,label!=='layout and importance',label);
  }
});

test('unbound nodes expose actual gaps; an explicit unknown capability does not inherit a same-ID binding',async t=>{
  const {root,graph} = await fixture(t);
  const selected = graph.nodes.find(item=>item.id==='submit');
  selected.capabilityId='unregistered.command';
  selected.processing='';
  const {context,markdown} = await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.equal(context.capability,null);
  assert.equal(context.evidence,null);
  assert.equal(context.frontend,null);
  assert.deepEqual(context.implementation,[]);
  assert.ok(context.gaps.some(gap=>gap.code==='capability.missing'));
  assert.ok(context.gaps.some(gap=>gap.code==='contract.processing'));
  assert.match(markdown,/能力 unregistered.command 尚未登记/);
  assert.doesNotMatch(markdown,/状态：测试通过/);
});

test('acceptance has one source: linked requirement criteria or node instructions suffice',async t=>{
  const {root,graph}=await fixture(t);
  graph.nodes.find(item=>item.id==='submit').acceptance='';
  const file=path.join(root,'contracts/requirements.json');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  data.requirements[0].acceptanceStatus='confirmed';
  data.requirements[0].confirmedAcceptance=structuredClone(data.requirements[0].acceptance);
  await fs.writeFile(file,JSON.stringify(data));
  let result=await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.equal(result.context.gaps.some(gap=>gap.code.includes('acceptance')),false);
  assert.match(result.markdown,/见关联需求中的验收条件/);
  data.requirements[0].acceptance=[];
  data.requirements[0].confirmedAcceptance=[];
  await fs.writeFile(file,JSON.stringify(data));
  result=await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.deepEqual(result.context.gaps.filter(gap=>gap.code.includes('acceptance')).map(gap=>gap.code),['contract.acceptance']);
  graph.nodes.find(item=>item.id==='submit').acceptance='从节点定义可观察结果';
  result=await nodeContext({featureId:'demo',nodeId:'submit',graph},root);
  assert.equal(result.context.gaps.some(gap=>gap.code.includes('acceptance')),false);
});

test('missing nodes and invalid previews fail without generating misleading context',async t=>{
  const {root,graph} = await fixture(t);
  await assert.rejects(nodeContext({featureId:'demo',nodeId:'absent'},root),error=>error.status===404);
  await assert.rejects(nodeContext({featureId:'demo'},root),error=>error.status===400);
  graph.nodes[0].importance='urgent';
  await assert.rejects(nodeContext({featureId:'demo',nodeId:'submit',graph},root),error=>error.status===400);
  graph.nodes[0].importance='core';
  graph.feature.id='other';
  await assert.rejects(nodeContext({featureId:'demo',nodeId:'submit',graph},root),error=>error.status===400);
});
