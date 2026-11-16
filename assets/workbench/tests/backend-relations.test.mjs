import test from 'node:test';
import assert from 'node:assert/strict';
import { backendRelations, nodeBackend, indexedCapabilityBindings, functionNeedId, nodeNeedId, acceptanceNeedId } from '../server/backend-relations.mjs';
import { createFeatureRegistry } from '../server/feature-registry.mjs';

const entity=(symbol,needIds,extra={})=>({path:'server/units.mjs',symbol,needIds,signature:`function ${symbol}(value) {`,startLine:2,endLine:4,kind:'function',language:'javascript',markerLines:[1],source:'sphinx-codelinks',indexState:'current',...extra});
const spec=(id,nodeId,fulfills,extra={})=>({id,type:'spec',node_id:nodeId,fulfills,...extra});
const emptyRegistry=()=>createFeatureRegistry([]);

test('exact spec markers determine functions; a shared requirement cannot smear functions across nodes',()=>{
  const graph={nodes:[{id:'left',needId:'SPEC_LEFT'},{id:'right',needId:'SPEC_RIGHT'}],edges:[{id:'data',source:'left',target:'right'}]};
  const needs={SPEC_LEFT:spec('SPEC_LEFT','left',['REQ_SHARED']),SPEC_RIGHT:spec('SPEC_RIGHT','right',['REQ_SHARED']),REQ_SHARED:{id:'REQ_SHARED',type:'req'}};
  const entities=[entity('first',['SPEC_LEFT','REQ_SHARED']),entity('second',['SPEC_RIGHT','REQ_SHARED']),entity('helper',['REQ_SHARED'])];
  const model=backendRelations(graph,[{id:'REQ_SHARED'}],{needs,entities,registry:emptyRegistry()});
  assert.deepEqual(nodeBackend(model,'left').functions.map(fn=>fn.symbol),['first']);
  assert.deepEqual(nodeBackend(model,'right').functions.map(fn=>fn.symbol),['second']);
  assert.equal(model.functions.length,2);
  assert.deepEqual(model.requirements[0].nodeIds,['left','right']);
  assert.deepEqual(model.calls,[]);
  assert.equal(model.flows[0].sourceKind,'contract-data-flow');
  const stale=backendRelations(graph,[],{needs,entities:entities.map(item=>({...item,indexState:'stale'})),registry:emptyRegistry()});
  assert.equal(stale.functions[0].scopeState,'stale');
});

test('an unfamiliar spec with several source entities needs no feature or code registration',()=>{
  const registry=emptyRegistry();
  const graph={nodes:[{id:'SPEC_MEDIAN',capabilityId:'not-executable-yet'}],edges:[]};
  const needs={SPEC_MEDIAN:spec('SPEC_MEDIAN',null,['REQ_MEDIAN'])};
  const entities=[entity('sortValues',['SPEC_MEDIAN']),entity('pickMedian',['SPEC_MEDIAN'],{startLine:6,endLine:9})];
  const model=backendRelations(graph,[{id:'REQ_MEDIAN'}],{needs,entities,registry});
  const node=nodeBackend(model,'SPEC_MEDIAN');
  assert.equal(node.capabilityId,null);
  assert.deepEqual(node.functions.map(fn=>fn.symbol),['sortValues','pickMedian']);
  assert.equal(node.functions[0].startLine,2);
  assert.deepEqual(registry.features,[]);
});

test('impl implements and test verifies are read from indexed Needs, with observed results joined by stable test ID',()=>{
  const graph={nodes:[{id:'node',needId:'SPEC_ONE'}],edges:[]};
  const requirements=[{id:'REQ_ONE',acceptance:[{id:'AC_ONE',input:'3',expected:'6'}]}];
  const needs={
    REQ_ONE:{id:'REQ_ONE',type:'req',parts:{AC_ONE:{id:'AC_ONE'}}},
    SPEC_ONE:spec('SPEC_ONE','node',['REQ_ONE']),
    IMPL_ONE:{id:'IMPL_ONE',type:'impl',implements:['SPEC_ONE'],calls:['IMPL_TWO']},
    IMPL_TWO:{id:'IMPL_TWO',type:'impl',implements:['SPEC_ONE']},
    TEST_ONE:{id:'TEST_ONE',type:'test',title:'double value',verifies:['REQ_ONE.AC_ONE']}
  };
  const entities=[entity('prepare',['IMPL_ONE']),entity('double',['IMPL_TWO'],{startLine:6,endLine:8}),
    entity(null,['TEST_ONE'],{path:'tests/units.test.mjs',startLine:null,endLine:null,signature:null})];
  const model=backendRelations(graph,requirements,{needs,entities,registry:emptyRegistry()});
  const node=nodeBackend(model,'node',{cases:[{id:'TEST_ONE',state:'passed',durationMs:1}]});
  assert.equal(node.testCases[0].state,'passed');
  assert.equal(node.testCases[0].file,'tests/units.test.mjs');
  assert.equal(node.testCases[0].verifies[0].state,'linked');
  assert.equal(node.testCases[0].relationSource,'requirement-binding');
  assert.equal(node.testCases[0].relatedFunctionIds.length,2);
  assert.deepEqual(model.calls,[{caller:functionNeedId(entities[0]),callee:functionNeedId(entities[1]),source:'needs-declaration'}]);
  delete needs.REQ_ONE.parts.AC_ONE;
  assert.equal(backendRelations(graph,requirements,{needs,entities,registry:emptyRegistry()}).testCases[0].verifies[0].state,'missing-acceptance');
});

test('capability display bindings are derived from spec properties and source markers',()=>{
  const cap={id:'new.capability',nodeIds:[],testFiles:['tests/new.test.mjs']};
  const needs={SPEC_NEW:spec('SPEC_NEW','new-node',['REQ_NEW'],{node_properties:JSON.stringify({capabilityId:cap.id})}),
    REQ_NEW:{id:'REQ_NEW',type:'req',parts:{AC:{}}},TEST_NEW:{id:'TEST_NEW',type:'test',title:'new test',verifies:['REQ_NEW.AC']}};
  const bindings=indexedCapabilityBindings(cap,needs,[entity('newFunction',['SPEC_NEW']),entity(null,['TEST_NEW'],{path:'tests/new.test.mjs'})]);
  assert.deepEqual(bindings.nodeIds,['new-node']);
  assert.deepEqual(bindings.requirementIds,['REQ_NEW']);
  assert.deepEqual(bindings.implementation.map(item=>item.symbol),['newFunction']);
  assert.equal(bindings.testCases[0].id,'TEST_NEW');
});

test('missing indexes do not resurrect code strings or old hand-maintained association tables',()=>{
  const graph={nodes:[{id:'one',code:'server/obsolete.mjs#wrong'}],edges:[]};
  const registry=createFeatureRegistry([{code:[{nodeId:'one',file:'server/obsolete.mjs',symbol:'wrong'}]}]);
  assert.deepEqual(backendRelations(graph,[{id:'REQ_ONE',nodeId:'one'}],{registry}).functions,[]);
  assert.equal(acceptanceNeedId('REQ_X','AC.ONE'),'REQ_X.PART_41432E4F4E45');
  assert.notEqual(acceptanceNeedId('REQ_X','AC.ONE'),acceptanceNeedId('REQ_X','PART_41432E4F4E45'));
});
