import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTraceabilityIndex, traceability, updateGraph, updateRequirement, openTraceability } from '../server/traceability.mjs';
import { readNeedsIndex, buildNeedsIndex } from '../server/needs-index.mjs';
import { featureRegistry, featureSource } from '../server/feature-registry.mjs';
import { readProjectedGraph } from '../server/needs-projection.mjs';
import { indexedCapabilities } from '../server/capabilities.mjs';
import { nodeContext } from '../server/node-context.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=path.join(project,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const integration={skip:!existsSync(python)&&'先运行 uv sync --locked 启用真实 Sphinx 集成测试'};
const readJson=async(root,file)=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const feature={...featureRegistry.defaultTrace,id:'demo'};
const stockCode='// @need-ids: SPEC_STOCK_CHECK\nexport function reserveStock(quantity, requested) { return quantity - requested; }\n';

test('独立图读取保留传入描述符的文件与 ID，无需登记、需求文件或 Sphinx',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-standalone-graph-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const graph={version:2,feature:{id:'standalone',title:'独立功能',goal:'按来源读取'},nodes:[
    {id:'one',title:'独立节点',position:{x:0,y:0},input:'输入',output:'输出'}
  ],edges:[]};
  await fs.writeFile(path.join(root,'custom-graph.json'),JSON.stringify(graph));
  assert.deepEqual(await readProjectedGraph(root,{id:'standalone',graphFile:'custom-graph.json'}),graph);
});

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-projection-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['contracts','src','features','server','tests','traceability'])await fs.mkdir(path.join(root,dir),{recursive:true});
  // Saves use the established project interpreter path; share it without copying dependencies.
  await fs.symlink(path.join(project,'.venv'),path.join(root,'.venv'),process.platform==='win32'?'junction':'dir');
  await fs.writeFile(path.join(root,'contracts/requirements.json'),JSON.stringify({version:1,featureId:'demo',requirements:[{id:'REQ_LEGACY',nodeId:'one',title:'既有入口',description:'保留原有功能入口。',status:'draft',revision:1}]}));
  await fs.writeFile(path.join(root,'contracts/project.json'),JSON.stringify({version:2,feature:{id:'demo',title:'存量功能视图',goal:'增加库存预留'},nodes:[
    {id:'one',title:'入口',input:'请求',output:'任务',parentId:null,position:{x:0,y:0}},
    {id:'two',title:'原有存储',input:'记录',output:'结果',parentId:'one',position:{x:300,y:0}},
  ],edges:[]}));
  for(const file of ['conf.py','ubproject.toml','node-mapping.json'])await fs.copyFile(path.join(project,'traceability',file),path.join(root,'traceability',file));
  await fs.appendFile(path.join(root,'traceability/conf.py'),"\nsuppress_warnings += ['codelinks.git_root']\n");
  await fs.writeFile(path.join(root,'traceability/index.rst'),'Inventory fixture\n=================\n\n.. toctree::\n\n   project\n   warehouse\n   node-properties\n\n.. src-trace::\n   :project: backend\n\n.. src-trace::\n   :project: tests\n');
  await fs.writeFile(path.join(root,'traceability/warehouse.rst'),[
    'Warehouse rules','===============','','保留这段领域说明。','',
    '.. req:: 库存预留不得产生负库存','   :id: REQ_STOCK_RESERVE','','   预留数量不能超过可用库存。','',
    '   :need_part:`(AC_RESERVE) 库存为 8，预留 3 后剩余 5。`','',
    '.. spec:: 校验并预留库存','   :id: SPEC_STOCK_CHECK','   :feature_id: demo','   :importance: key',
    '   :fulfills: REQ_STOCK_RESERVE','   :parent_spec: FUNC_6F6E65','   :contains: SPEC_STOCK_COMMIT',
    '   :flows_to: SPEC_STOCK_COMMIT',
    '   :node_properties: {"kind":"logic","input":"库存与预留数量","output":"剩余库存","warehouse":"east-1","reservation":{"allowPartial":false}}',
    '', '   校验请求后计算剩余库存。','',
    '.. spec:: 记录库存预留','   :id: SPEC_STOCK_COMMIT','   :feature_id: demo','   :fulfills: REQ_STOCK_RESERVE',
    '   :parent_spec: SPEC_STOCK_CHECK','   :node_properties: {"kind":"logic","input":"剩余库存","output":"预留记录"}',
    '', '   保存预留记录。','', '尾部说明必须保留。','',
  ].join('\n'));
  await fs.writeFile(path.join(root,'server/warehouse.mjs'),stockCode);
  await fs.writeFile(path.join(root,'tests/warehouse.test.mjs'),[
    "import test from 'node:test';",'// @need test: 库存预留验收','// :id: TEST_STOCK_RESERVE',
    '// :verifies: REQ_STOCK_RESERVE.AC_RESERVE','// @endneed',"test('[TEST_STOCK_RESERVE] remaining stock', () => {});",'',
  ].join('\n'));
  const result=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(result.index.state,'current',result.index.error);
  return {root,result};
}

async function saveGraph(root,view,edit) {
  const graph=structuredClone(view.projectGraph);edit(graph);
  const result=await updateGraph({featureId:'demo',expectedGraph:view.projectGraph,graph},root);
  assert.equal(result.index.state,'current',result.index.error);
  return result;
}

test('陌生领域的需求、节点属性、函数和原生测试由规则投影，无需业务映射表',integration,async t=>{
  const registry=JSON.stringify(featureRegistry.features);
  const {root,result}=await fixture(t);
  const node=result.projectGraph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK');
  assert.equal(node.title,'校验并预留库存');
  assert.equal(node.importance,'key');
  assert.equal(node.warehouse,'east-1');
  assert.deepEqual(node.reservation,{allowPartial:false});
  assert.equal(node.parentId,'one');
  assert.match(node.code,/server\/warehouse\.mjs#reserveStock/);
  assert.deepEqual((await readProjectedGraph(root,feature)).nodes,result.projectGraph.nodes);
  const requirement=result.requirements.find(item=>item.id==='REQ_STOCK_RESERVE');
  assert.deepEqual(new Set(requirement.nodeIds),new Set(['SPEC_STOCK_CHECK','SPEC_STOCK_COMMIT']));
  assert.equal(requirement.sourceDocument,'traceability/warehouse.rst');
  const fn=result.backend.functions.find(fn=>fn.symbol==='reserveStock');
  assert.deepEqual(fn.nodeIds,['SPEC_STOCK_CHECK']);
  assert.deepEqual(fn.requirementIds,['REQ_STOCK_RESERVE']);
  const linkedTest=result.backend.testCases.find(item=>item.id==='TEST_STOCK_RESERVE');
  assert.equal(linkedTest.file,'tests/warehouse.test.mjs');
  assert.deepEqual(linkedTest.relatedFunctionIds,[fn.id]);
  assert.equal(linkedTest.verifies[0].needId,'REQ_STOCK_RESERVE.AC_RESERVE');
  assert.deepEqual(result.backend.requirements.find(item=>item.id===requirement.id).acceptance[0].testCaseIds,['TEST_STOCK_RESERVE']);
  assert.deepEqual((await readJson(root,'contracts/project.json')).nodes.map(node=>node.id),['one','two']);
  assert.equal((await readJson(root,'contracts/requirements.json')).requirements.some(item=>item.id==='REQ_STOCK_RESERVE'),false);
  assert.equal(JSON.stringify(featureRegistry.features),registry);
  const source=await featureSource('SPEC_STOCK_CHECK',new URL('http://localhost/'),root);
  assert.equal(source.symbol,'reserveStock');assert.equal(source.startLine,2);
});

test('原生节点属性写回 RST，布局单独保存，移动函数后重建更新位置',integration,async t=>{
  const {root,result}=await fixture(t);
  let view=await saveGraph(root,result,graph=>{
    const node=graph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK');
    node.title='分仓校验并预留';node.warehouse='west-2';node.reservation.allowPartial=true;node.importance='core';
  });
  let node=view.projectGraph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK');
  assert.equal(node.title,'分仓校验并预留');assert.equal(node.warehouse,'west-2');assert.deepEqual(node.reservation,{allowPartial:true});assert.equal(node.importance,'core');
  const document=await fs.readFile(path.join(root,'traceability/warehouse.rst'),'utf8');
  assert.match(document,/\.\. spec:: 分仓校验并预留/);assert.match(document,/"warehouse":"west-2"/);
  assert.match(document,/保留这段领域说明/);assert.match(document,/尾部说明必须保留/);
  view=await saveGraph(root,view,graph=>{
    const node=graph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK');node.position={x:777,y:333};node.size={width:320,height:180};
  });
  assert.equal(await fs.readFile(path.join(root,'traceability/warehouse.rst'),'utf8'),document);
  const persisted=await readJson(root,'contracts/project.json');
  assert.equal(persisted.nodes.some(node=>node.id==='SPEC_STOCK_CHECK'),false);
  assert.deepEqual(persisted._needsLayout.SPEC_STOCK_CHECK,{needId:'SPEC_STOCK_CHECK',position:{x:777,y:333},size:{width:320,height:180}});
  node=(await readProjectedGraph(root,feature)).nodes.find(node=>node.id==='SPEC_STOCK_CHECK');
  assert.deepEqual(node.position,{x:777,y:333});assert.equal(node.warehouse,'west-2');
  await fs.writeFile(path.join(root,'server/warehouse.mjs'),'// moved function\n\n'+stockCode);
  assert.equal(await featureSource('SPEC_STOCK_CHECK',new URL('http://localhost/'),root),null);
  view=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(view.index.state,'current',view.index.error);
  const source=await featureSource('SPEC_STOCK_CHECK',new URL('http://localhost/'),root);
  assert.equal(source.startLine,4);assert.equal(source.symbol,'reserveStock');
});

test('原生需求确认和修改回写原文，原有 JSON 需求保持独立',integration,async t=>{
  const {root,result}=await fixture(t);
  const original=await fs.readFile(path.join(root,'contracts/requirements.json'),'utf8');
  let requirement=result.requirements.find(item=>item.id==='REQ_STOCK_RESERVE');
  assert.equal(requirement.description,'预留数量不能超过可用库存。');
  assert.deepEqual(requirement.acceptance,[{id:'AC_RESERVE',input:'',expected:'库存为 8，预留 3 后剩余 5。'}]);
  let view=await updateRequirement({featureId:'demo',id:requirement.id,revision:requirement.revision,title:requirement.title,description:requirement.description,action:'confirm',confirmAcceptance:true},root);
  assert.equal(view.index.state,'current',view.index.error);
  requirement=view.requirements.find(item=>item.id==='REQ_STOCK_RESERVE');
  assert.equal(requirement.status,'confirmed');assert.equal(requirement.acceptanceStatus,'confirmed');
  // An edited RST title must not inherit a confirmation of the previous words.
  const nativeDocument=path.join(root,'traceability/warehouse.rst');
  await fs.writeFile(nativeDocument,(await fs.readFile(nativeDocument,'utf8')).replace('.. req:: 库存预留不得产生负库存','.. req:: 外部修改的库存需求'));
  view=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(view.index.state,'current',view.index.error);
  requirement=view.requirements.find(item=>item.id==='REQ_STOCK_RESERVE');
  assert.equal(requirement.status,'draft');assert.equal(requirement.acceptanceStatus,'confirmed');
  view=await updateRequirement({featureId:'demo',id:requirement.id,revision:requirement.revision,title:'库存预留与缺货提示',description:'库存不足时返回缺货原因，预留成功时扣减可用库存。',action:'save'},root);
  assert.equal(view.index.state,'current',view.index.error);
  requirement=view.requirements.find(item=>item.id==='REQ_STOCK_RESERVE');
  assert.equal(requirement.status,'draft');assert.equal(requirement.title,'库存预留与缺货提示');
  assert.deepEqual(requirement.nodeIds,['SPEC_STOCK_CHECK','SPEC_STOCK_COMMIT']);
  const document=await fs.readFile(path.join(root,'traceability/warehouse.rst'),'utf8');
  assert.match(document,/\.\. req:: 库存预留与缺货提示/);assert.match(document,/库存不足时返回缺货原因/);
  assert.match(document,/:need_part:`\(AC_RESERVE\)/);assert.match(document,/尾部说明必须保留/);
  assert.equal(await fs.readFile(path.join(root,'contracts/requirements.json'),'utf8'),original);
});

test('JSON 与原生 RST 节点可跨来源重排父子和出边，再删除原生叶节点',integration,async t=>{
  const {root,result}=await fixture(t);
  let view=await saveGraph(root,result,graph=>{
    graph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK').parentId='one';
    graph.nodes.find(node=>node.id==='two').parentId='SPEC_STOCK_CHECK';
    graph.nodes.find(node=>node.id==='SPEC_STOCK_COMMIT').parentId='two';
    graph.edges=[
      {id:'legacy-native',source:'one',target:'SPEC_STOCK_CHECK',sourceHandle:'ok',targetHandle:'in'},
      {id:'native-legacy',source:'SPEC_STOCK_CHECK',target:'two',sourceHandle:'ok',targetHandle:'in'},
      {id:'legacy-native-leaf',source:'two',target:'SPEC_STOCK_COMMIT',sourceHandle:'ok',targetHandle:'in'},
    ];
  });
  assert.equal(view.projectGraph.nodes.find(node=>node.id==='two').parentId,'SPEC_STOCK_CHECK');
  assert.equal(view.projectGraph.nodes.find(node=>node.id==='SPEC_STOCK_COMMIT').parentId,'two');
  assert.deepEqual(view.projectGraph.edges.map(edge=>[edge.source,edge.target]).sort(),[['one','SPEC_STOCK_CHECK'],['SPEC_STOCK_CHECK','two'],['two','SPEC_STOCK_COMMIT']].sort());
  view=await saveGraph(root,view,graph=>{
    graph.nodes=graph.nodes.filter(node=>node.id!=='SPEC_STOCK_COMMIT');
    graph.edges=graph.edges.filter(edge=>edge.source!=='SPEC_STOCK_COMMIT'&&edge.target!=='SPEC_STOCK_COMMIT');
  });
  assert.equal(view.projectGraph.nodes.some(node=>node.id==='SPEC_STOCK_COMMIT'),false);
  assert.equal((await readNeedsIndex(root)).needs.SPEC_STOCK_COMMIT,undefined);
  assert.doesNotMatch(await fs.readFile(path.join(root,'traceability/warehouse.rst'),'utf8'),/:id: SPEC_STOCK_COMMIT/);
  assert.equal((await traceability(root,'demo')).index.state,'current');
});

test('公共读取 Interface 统一识别旧 RST：图、能力、源码和草稿都使用同一过期状态',integration,async t=>{
  const {root}=await fixture(t);
  const graph=await readJson(root,'contracts/project.json');
  graph.nodes[0].title='尚未导出的新名称';
  await fs.writeFile(path.join(root,'contracts/project.json'),JSON.stringify(graph));
  // Simulate an external Sphinx-only build that did not export the newer JSON.
  assert.equal((await buildNeedsIndex(root,{python})).state,'current');
  const project=await openTraceability(root);
  const saved=await project.feature('demo');
  assert.equal(project.index.state,'stale');
  assert.equal(saved.projectGraph.nodes.find(node=>node.id==='one').title,'尚未导出的新名称');
  assert.ok(project.capabilities().every(cap=>cap.indexState==='stale'));
  assert.equal(await project.source({nodeId:'SPEC_STOCK_CHECK'}),null);
  const draft=structuredClone(saved.projectGraph);
  draft.nodes.find(node=>node.id==='SPEC_STOCK_CHECK').description='草稿中的库存职责';
  const preview=await project.feature('demo',{graph:draft});
  assert.ok(preview.backend.functions.every(fn=>fn.scopeState==='stale'));
  // Existing entry points consume the same policy instead of interpreting raw index state.
  assert.deepEqual(await readProjectedGraph(root,feature),saved.projectGraph);
  assert.equal(await featureSource('SPEC_STOCK_CHECK',new URL('http://localhost/'),root),null);
  assert.ok((await indexedCapabilities(root)).every(cap=>cap.indexState==='stale'));
  const {context}=await nodeContext({featureId:'demo',nodeId:'SPEC_STOCK_CHECK',graph:draft},root);
  assert.equal(context.index.state,'stale');assert.equal(context.implementation[0].scopeState,'stale');
});

test('项目定制字段与关系在公共 Interface 同时贯通属性、函数、能力和证据契约',integration,async t=>{
  const {root}=await fixture(t);
  const fixtureCapability={id:'fixture.execute',nodeIds:[],testFiles:['tests/warehouse.test.mjs']};
  featureRegistry.capabilities.push(fixtureCapability);
  t.after(()=>featureRegistry.capabilities.splice(featureRegistry.capabilities.indexOf(fixtureCapability),1));
  const rules=await readJson(root,'traceability/node-mapping.json');
  rules.properties='contract_fields';rules.links.requirements='satisfies';
  await fs.writeFile(path.join(root,'traceability/node-mapping.json'),JSON.stringify(rules));
  await fs.appendFile(path.join(root,'traceability/ubproject.toml'),[
    '', '[needs.types.spec.fields.contract_fields]', 'schema = { type = "string" }',
    '[needs.links.satisfies]', 'outgoing = "satisfies"', 'incoming = "satisfied by"', '',
  ].join('\n'));
  const document=path.join(root,'traceability/warehouse.rst');
  await fs.writeFile(document,(await fs.readFile(document,'utf8')).replaceAll(':node_properties:',':contract_fields:').replaceAll(':fulfills:',':satisfies:').replace('"warehouse":"east-1"','"warehouse":"east-1","capabilityId":"fixture.execute"'));
  const built=await buildTraceabilityIndex(root,undefined,{python});
  assert.equal(built.index.state,'current',built.index.error);
  const project=await openTraceability(root),view=await project.feature('demo');
  const node=view.projectGraph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK');
  assert.equal(node.warehouse,'east-1');
  assert.equal(view.backend.nodes.find(node=>node.nodeId==='SPEC_STOCK_CHECK').requirementIds[0],'REQ_STOCK_RESERVE');
  assert.equal(view.backend.functions.find(fn=>fn.symbol==='reserveStock').nodeIds[0],node.id);
  const cap=project.capabilities().find(cap=>cap.id==='fixture.execute');
  assert.ok(cap.nodeIds.includes(node.id));assert.ok(cap.requirementIds.includes('REQ_STOCK_RESERVE'));
  assert.equal(cap.implementation[0].symbol,'reserveStock');assert.equal(cap.testCases[0].id,'TEST_STOCK_RESERVE');
  const contract=project.capabilityContract(cap.id);
  assert.equal(contract.specifications[0].properties.warehouse,'east-1');
  assert.equal(contract.requirements[0].id,'REQ_STOCK_RESERVE');
  assert.equal((await project.source({nodeId:node.id})).symbol,'reserveStock');
  // Legacy JSON remains readable beside the custom authored source.
  assert.equal(view.projectGraph.nodes.find(node=>node.id==='one').title,'入口');
  const updated=await saveGraph(root,view,graph=>{graph.nodes.find(node=>node.id==='SPEC_STOCK_CHECK').warehouse='west-custom';});
  assert.equal(updated.projectGraph.nodes.find(item=>item.id===node.id).warehouse,'west-custom');
  assert.match(await fs.readFile(document,'utf8'),/:contract_fields: .*"warehouse":"west-custom"/);
  assert.doesNotMatch(await fs.readFile(document,'utf8'),/:node_properties:/);
});
