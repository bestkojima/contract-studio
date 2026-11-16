import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultMappingRules, mappingRules, normalizeNeeds, nodeProperties } from '../server/needs-schema.mjs';
import { projectNeedsGraph, projectedRequirements } from '../server/needs-projection.mjs';
import { backendRelations, indexedCapabilityBindings } from '../server/backend-relations.mjs';

const customRules={
  ...defaultMappingRules,type:'functionality',feature:'belongs_to',id:'canvas_id',properties:'contract_fields',edges:'routes_json',
  fields:{title:'node_label',description:'intent',importance:'criticality',capabilityId:'binding',processing:'algorithm'},
  links:{requirements:'satisfies',children:'substeps',parent:'owner_spec',flow:'after'},
  defaults:{...defaultMappingRules.defaults,currency:'CNY'}
};
const entity=(symbol,needIds,extra={})=>({path:'server/warehouse.mjs',symbol,needIds,signature:`function ${symbol}(value) {`,startLine:2,endLine:4,
  kind:'function',language:'javascript',markerLines:[1],source:'sphinx-codelinks',indexState:'current',...extra});
const cap={id:'warehouse.reserve',nodeIds:[],testFiles:['tests/warehouse.test.mjs']};
const graph={version:2,feature:{id:'warehouse',title:'库存',goal:'预留库存'},nodes:[],edges:[]};
const rawNeeds=()=>({
  REQ_RESERVE:{id:'REQ_RESERVE',type:'req',title:'保证库存非负',content:'预留后剩余库存不得为负。',docname:'warehouse',lineno:3,
    parts:{AC_RESERVE:{id:'AC_RESERVE',content:'库存为 8，预留 3 后剩余 5。'}}},
  SPEC_RESERVE:{id:'SPEC_RESERVE',type:'functionality',title:'源指令标题',content:'源指令正文',docname:'warehouse',lineno:11,
    belongs_to:'warehouse',canvas_id:'reserve',node_label:'预留库存',intent:'检查库存后执行预留。',criticality:'key',binding:cap.id,algorithm:'扣减请求数量',
    contract_fields:JSON.stringify({input:'库存和预留数量',output:'剩余库存',threshold:5,reservation:{allowPartial:false}}),
    satisfies:['REQ_RESERVE'],substeps:['SPEC_RECORD'],after:['SPEC_RECORD']},
  SPEC_RECORD:{id:'SPEC_RECORD',type:'spec',title:'保存记录',content:'从已有 JSON 导出的节点',docname:'requirements',lineno:20,
    contract_source:'contracts/project.json',feature_id:'warehouse',node_id:'record',fulfills:['REQ_RESERVE'],parent_spec:['SPEC_RESERVE'],
    node_properties:JSON.stringify({input:'剩余库存',output:'预留记录',capabilityId:cap.id})},
  IMPL_RESERVE:{id:'IMPL_RESERVE',type:'impl',implements:['SPEC_RESERVE'],docname:'code',lineno:1},
  TEST_RESERVE:{id:'TEST_RESERVE',type:'test',title:'库存预留验收',verifies:['REQ_RESERVE.AC_RESERVE'],docname:'tests',lineno:2}
});

test('one normalization makes custom rules agree across nodes, requirements, functions and capability evidence',()=>{
  const raw=rawNeeds(),original=structuredClone(raw);
  const needs=normalizeNeeds(raw,customRules);
  const entities=[entity('reserveStock',['IMPL_RESERVE']),entity('recordReservation',['SPEC_RECORD'],{startLine:7,endLine:9}),
    entity(null,['TEST_RESERVE'],{path:'tests/warehouse.test.mjs',startLine:null,endLine:null,signature:null})];
  const projected=projectNeedsGraph(graph,needs,{},defaultMappingRules,entities);
  const requirements=projectedRequirements([],projected,needs);
  const relations=backendRelations(projected,requirements,{needs,entities,registry:{capabilities:[cap],trials:[]}});
  const binding=indexedCapabilityBindings(cap,needs,entities);
  const node=projected.nodes.find(node=>node.id==='reserve');
  assert.equal(node.title,'预留库存');assert.equal(node.description,'检查库存后执行预留。');assert.equal(node.importance,'key');
  assert.equal(node.processing,'扣减请求数量');assert.equal(node.currency,'CNY');assert.equal(node.threshold,5);
  assert.deepEqual(node.reservation,{allowPartial:false});assert.equal(node.capabilityId,cap.id);
  assert.match(node.code,/reserveStock/);assert.equal(node.test,'tests/warehouse.test.mjs');
  assert.equal(projected.nodes.find(node=>node.id==='record').parentId,'reserve');
  assert.deepEqual(projected.edges.map(edge=>[edge.source,edge.target]),[['reserve','record']]);
  assert.deepEqual(requirements[0].nodeIds,['reserve','record']);
  assert.deepEqual(relations.nodes.find(node=>node.nodeId==='reserve').requirementIds,['REQ_RESERVE']);
  assert.deepEqual(relations.functions.find(fn=>fn.symbol==='reserveStock').nodeIds,['reserve']);
  assert.deepEqual(binding.nodeIds,['reserve','record']);assert.deepEqual(binding.requirementIds,['REQ_RESERVE']);
  assert.deepEqual(binding.implementation.map(fn=>fn.symbol),['reserveStock','recordReservation']);
  assert.equal(binding.testCases[0].id,'TEST_RESERVE');assert.equal(binding.testCases[0].verifies[0].state,'linked');
  assert.deepEqual(needs.REQ_RESERVE,raw.REQ_RESERVE);assert.deepEqual(needs.IMPL_RESERVE,raw.IMPL_RESERVE);assert.deepEqual(needs.TEST_RESERVE,raw.TEST_RESERVE);
  assert.equal(needs.SPEC_RESERVE.docname,'warehouse');assert.equal(needs.SPEC_RESERVE.lineno,11);
  assert.equal(needs.SPEC_RECORD.contract_source,'contracts/project.json');
  assert.deepEqual(raw,original);
  assert.deepEqual(normalizeNeeds(needs,customRules),needs);
});

test('default rules preserve legacy behavior and detailed edges while dropping derived fields from properties',()=>{
  const edge={id:'branch',source:'source',target:'destination',sourceHandle:'fail',targetHandle:'in',label:'库存不足'};
  const raw={SPEC_SOURCE:{id:'SPEC_SOURCE',type:'spec',title:'源节点',content:'职责',feature_id:'warehouse',node_id:'source',
    node_properties:JSON.stringify({input:'请求',output:'结果',importance:'core',capabilityId:cap.id,code:'wrong.mjs#wrong',position:{x:9,y:9}}),
    node_edges:JSON.stringify([edge]),fulfills:['REQ_ONE']},
    SPEC_DEST:{id:'SPEC_DEST',type:'spec',title:'下一节点',content:'职责',feature_id:'warehouse',node_id:'destination'}};
  const needs=normalizeNeeds(raw);
  const projected=projectNeedsGraph(graph,needs,{});
  assert.equal(projected.nodes[0].importance,'core');assert.equal(projected.nodes[0].code,undefined);
  assert.deepEqual(projected.nodes[0].position,{x:0,y:0});assert.deepEqual(projected.edges,[edge]);
  assert.equal(needs.SPEC_SOURCE.node_edges,raw.SPEC_SOURCE.node_edges);
  assert.deepEqual(nodeProperties({id:'n',title:'名称',parentId:null,position:{x:1,y:2},size:{width:3,height:4},code:'source',test:'test',needId:'SPEC',properties:{ignored:true},input:'in',custom:{field:true}}),{input:'in',custom:{field:true}});
});

test('custom type selection excludes unselected authored specs across projection and bindings, preserving generated nodes',()=>{
  const raw={...rawNeeds(),
    REQ_UNSELECTED:{id:'REQ_UNSELECTED',type:'req',title:'保留的其他需求',content:'不属于当前节点类型。'},
    SPEC_UNSELECTED:{id:'SPEC_UNSELECTED',type:'spec',title:'未选中的手写规格',content:'保留本条 Need。',docname:'other',lineno:8,
      feature_id:'warehouse',node_id:'unselected',fulfills:['REQ_UNSELECTED'],
      node_properties:JSON.stringify({input:'请求',output:'结果',capabilityId:cap.id})},
    IMPL_UNSELECTED:{id:'IMPL_UNSELECTED',type:'impl',implements:['SPEC_UNSELECTED']}};
  const original=structuredClone(raw),needs=normalizeNeeds(raw,customRules);
  const entities=[entity('reserveStock',['IMPL_RESERVE']),entity('recordReservation',['SPEC_RECORD'],{startLine:7,endLine:9}),
    entity('unselectedFunction',['SPEC_UNSELECTED'],{startLine:12,endLine:14}),
    entity('unselectedImpl',['IMPL_UNSELECTED'],{startLine:17,endLine:19})];
  const projected=projectNeedsGraph(graph,needs,{},defaultMappingRules,entities);
  const requirements=projectedRequirements([],projected,needs);
  const relations=backendRelations(projected,requirements,{needs,entities,registry:{capabilities:[cap],trials:[]}});
  const binding=indexedCapabilityBindings(cap,needs,entities);
  assert.deepEqual(projected.nodes.map(node=>node.id),['reserve','record']);
  assert.deepEqual(requirements.map(req=>req.id),['REQ_RESERVE']);
  assert.deepEqual(relations.functions.map(fn=>fn.symbol),['reserveStock','recordReservation']);
  assert.deepEqual(binding.nodeIds,['reserve','record']);
  assert.deepEqual(binding.requirementIds,['REQ_RESERVE']);
  assert.deepEqual(binding.implementation.map(fn=>fn.symbol),['reserveStock','recordReservation']);
  assert.equal(needs.SPEC_UNSELECTED.source_type,'spec');
  const {type,source_type,...retained}=needs.SPEC_UNSELECTED;
  const {type:originalType,...expected}=original.SPEC_UNSELECTED;
  assert.notEqual(type,'spec');assert.equal(source_type,originalType);assert.deepEqual(retained,expected);
  assert.deepEqual(raw,original);assert.deepEqual(normalizeNeeds(needs,customRules),needs);
  const reselected=normalizeNeeds(needs,defaultMappingRules);
  assert.equal(reselected.SPEC_UNSELECTED.type,'spec');
  assert.equal(reselected.SPEC_UNSELECTED.node_id,'unselected');
  assert.equal(reselected.SPEC_RESERVE.type,'functionality');
});

test('generated source snapshots never leak layout into behavior, while authored descriptions remain semantic',()=>{
  const generated=(x,importance,description)=>({SPEC_GENERATED:{id:'SPEC_GENERATED',type:'spec',title:'旧节点',feature_id:'warehouse',node_id:'generated',
    contract_source:'contracts/project.json',importance,
    content:`功能节点原始字段::\n\n   ${JSON.stringify({id:'generated',position:{x,y:0},importance})}`,
    node_properties:JSON.stringify({input:'请求',output:'结果',importance,...(description===undefined?{}:{description})})}});
  const first=generated(0,'key'),second=generated(500,'normal');
  const sourceSnapshots=[structuredClone(first),structuredClone(second)];
  const normalized=[normalizeNeeds(first),normalizeNeeds(second)];
  const behavior=needs=>{const {importance,...properties}=JSON.parse(needs.SPEC_GENERATED.node_properties);return properties;};
  assert.deepEqual(behavior(normalized[0]),behavior(normalized[1]));
  for(const needs of normalized) {
    assert.equal(needs.SPEC_GENERATED.content,'');
    assert.equal(projectNeedsGraph(graph,needs,{}).nodes[0].description,'');
  }
  const described=normalizeNeeds(generated(700,'core','只按业务规则预留库存。'));
  assert.equal(described.SPEC_GENERATED.content,'只按业务规则预留库存。');
  assert.equal(projectNeedsGraph(graph,described,{}).nodes[0].description,'只按业务规则预留库存。');
  assert.deepEqual([first,second],sourceSnapshots);
  const native=body=>normalizeNeeds({SPEC_NATIVE:{id:'SPEC_NATIVE',type:'spec',title:'手写节点',feature_id:'warehouse',content:body}});
  assert.notDeepEqual(JSON.parse(native('原行为').SPEC_NATIVE.node_properties),JSON.parse(native('修改行为').SPEC_NATIVE.node_properties));
  assert.equal(projectNeedsGraph(graph,native('修改行为'),{}).nodes[0].description,'修改行为');
});

test('normalization can repeat even when custom fields read canonical title and content',()=>{
  const rules={...defaultMappingRules,fields:{title:'content',description:'title',importance:'importance'}};
  const raw={SPEC_X:{id:'SPEC_X',type:'spec',title:'原始标题',content:'显示标题',feature_id:'warehouse'}};
  const normalized=normalizeNeeds(raw,rules);
  assert.equal(normalized.SPEC_X.title,'显示标题');assert.equal(normalized.SPEC_X.content,'原始标题');
  assert.deepEqual(normalizeNeeds(normalized,rules),normalized);
  assert.equal(raw.SPEC_X.title,'原始标题');assert.equal(raw.SPEC_X.content,'显示标题');
  for(const type of ['req','test','impl'])assert.throws(()=>normalizeNeeds(raw,{...rules,type}),/节点映射类型/);
});

test('mappingRules reads project configuration and keeps the existing unconfigured-project default',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-schema-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  assert.deepEqual(await mappingRules(root),defaultMappingRules);
  await fs.mkdir(path.join(root,'traceability'));
  await fs.writeFile(path.join(root,'traceability/node-mapping.json'),JSON.stringify(customRules));
  assert.deepEqual(await mappingRules(root),customRules);
  assert.equal(defaultMappingRules.type,'spec');
  assert.equal(defaultMappingRules.properties,'node_properties');
  assert.equal(defaultMappingRules.links.requirements,'fulfills');
});
