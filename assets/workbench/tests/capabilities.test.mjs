import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCapabilities, capabilityEvidence, runCapabilityTests } from '../server/capabilities.mjs';
import { sourceRevision } from '../server/needs-index.mjs';
import { featureRegistry } from '../server/feature-registry.mjs';
// Test-only reviewed execution fixture; the shipped registry remains empty.
featureRegistry.capabilities.push({id:'fixture.execute',rootNodeId:'operation',nodeIds:['operation'],runPath:'/api/fixture',testPath:'/api/fixture/test',frontend:{component:'FixturePanel',path:'features/fixture/client.tsx'},testFiles:['tests/fixture.test.mjs','tests/fixture-api.test.mjs','tests/fixture-input.test.mjs']});

import { indexedTestCases } from '../server/indexed-tests.mjs';

async function writeFixtureIndex(root,needs,entities) {
  const dir=path.join(root,'traceability/_build/needs');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(root,'traceability/conf.py'),'# Fixture for the parsed index interface\n');
  await fs.writeFile(path.join(dir,'needs.json'),JSON.stringify({current_version:'',versions:{'':{needs}}}));
  await fs.writeFile(path.join(dir,'source-projects.json'),'{}');
  await fs.writeFile(path.join(dir,'code-entities.json'),JSON.stringify({schemaVersion:1,entities}));
  await fs.writeFile(path.join(dir,'index-state.json'),JSON.stringify({state:'current',sourceRevision:await sourceRevision(root)}));
}

test('能力登记保持后端、前端、节点和测试一一可查',()=>{
  const caps=listCapabilities();
  assert.equal(new Set(caps.map(cap=>cap.id)).size,1);
  for(const cap of caps){assert.ok(cap.nodeIds.includes(cap.rootNodeId));assert.ok(cap.runPath&&cap.testPath&&cap.frontend.component&&cap.frontend.path);assert.ok(cap.testFiles.length);}
  caps[0].nodeIds.push('not-persisted');assert.ok(!listCapabilities()[0].nodeIds.includes('not-persisted'));
});

test('真实固定测试报告持久化；行为变化过期，布局与重要性变化保持有效',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-evidence-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['tests','contracts','server'])await fs.mkdir(path.join(root,dir));
  for(const file of listCapabilities().find(cap=>cap.id==='fixture.execute').testFiles){
    await fs.writeFile(path.join(root,file),"import test from 'node:test';import assert from 'node:assert/strict';test('real assertion',()=>assert.equal(true,true));\n");
  }
  const graph={nodes:[{id:'operation',title:'处理功能',input:'数字',position:{x:1,y:1}}],edges:[]};
  const graphFile=path.join(root,'contracts','fixture.json');await fs.writeFile(graphFile,JSON.stringify(graph));
  assert.equal((await capabilityEvidence('fixture.execute',root)).state,'not-run');
  const report=await runCapabilityTests('fixture.execute',root);
  assert.equal(report.state,'passed',report.output);assert.equal(report.passed,3);assert.equal(report.failed,0);
  assert.deepEqual(report.cases,[],'a legacy project without a Needs index does not invent case associations');
  assert.equal(report.caseIndex.state,'unconfigured');
  assert.equal(report.caseCoverage.state,'unindexed');assert.equal(report.executionState,'passed');
  assert.ok(report.completedAt);assert.ok(report.output.includes('real assertion'));
  assert.equal((await capabilityEvidence('fixture.execute',root)).state,'passed');
  graph.nodes[0].position.x=9;await fs.writeFile(graphFile,JSON.stringify(graph));
  assert.equal((await capabilityEvidence('fixture.execute',root)).state,'passed');
  for(const importance of ['core','key','normal',undefined]) {
    graph.nodes[0].importance=importance;await fs.writeFile(graphFile,JSON.stringify(graph));
    assert.equal((await capabilityEvidence('fixture.execute',root)).state,'passed',`importance=${importance}`);
  }
  graph.nodes[0].input='修改后的输入约束';await fs.writeFile(graphFile,JSON.stringify(graph));
  assert.equal((await capabilityEvidence('fixture.execute',root)).state,'stale');
  await fs.writeFile(path.join(root,'tests/fixture.test.mjs'),"import test from 'node:test';test('actual failure',()=>{throw Error('failure evidence')});\n");
  const failure=await runCapabilityTests('fixture.execute',root);
  assert.equal(failure.state,'failed');assert.equal(failure.failed,1);assert.notEqual(failure.exitCode,0);
  await fs.mkdir(path.join(root,'features/demo'),{recursive:true});
  await fs.writeFile(path.join(root,'features/demo/client.tsx'),'export function Feature(){return null;}\n');
  assert.equal((await capabilityEvidence('fixture.execute',root)).state,'stale','feature modules are part of the inspected candidate');
  await assert.rejects(runCapabilityTests('../untrusted',root),/未知/);
});

test('逐用例证据从索引读取并匹配文件和稳定 ID，保留失败、跳过、未运行和过期结果',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-cases-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'tests'));
  const cap=listCapabilities().find(item=>item.id==='fixture.execute');
  const needs={REQ_DEMO:{id:'REQ_DEMO',type:'req',title:'Dynamic requirement',parts:{AC_ONE:{id:'AC_ONE'}}}};
  const entities=[];
  for(const [id,title] of [['TEST_PASS','pass'],['TEST_FAIL','fail'],['TEST_SKIP','skip'],['TEST_MISSING','missing']]) {
    needs[id]={id,title,type:'test',verifies:['REQ_DEMO.AC_ONE']};
    entities.push({path:'tests/fixture.test.mjs',needIds:[id],markerLines:[1],indexState:'current'});
  }
  const [passed,failed,skipped,missing]=indexedTestCases(needs,entities);
  const testLine=(item,body='()=>{}',options='')=>`test(${JSON.stringify(`[${item.id}] runtime title can differ`)},${options}${body});\n`;
  const header="import test from 'node:test';\n";
  const caseFile=path.join(root,passed.file);
  await fs.writeFile(caseFile,header+testLine(passed)+testLine(failed,"()=>{throw Error('specific assertion failed')}")+
    testLine(skipped,'()=>{}',"{skip:'pending fixture'},"));
  await fs.writeFile(path.join(root,'tests/fixture-api.test.mjs'),header+testLine(missing));
  await fs.writeFile(path.join(root,'tests/fixture-input.test.mjs'),header);
  await writeFixtureIndex(root,needs,entities);

  const [report,sameJob]=await Promise.all([runCapabilityTests(cap.id,root),runCapabilityTests(cap.id,root)]);
  assert.deepEqual(report,sameJob,'concurrent requests share the same execution');
  assert.equal(report.state,'failed');
  assert.deepEqual(report.cases.map(item=>item.state),['passed','failed','skipped','not-run']);
  assert.deepEqual(report.cases[1].verifies,failed.verifies);
  assert.match(report.cases[1].message,/specific assertion failed/);
  assert.equal(report.cases[0].line,2);
  assert.equal(typeof report.cases[0].durationMs,'number');
  assert.equal(report.cases[2].message,'pending fixture');
  assert.match(report.output,/TAP version 13/);
  assert.deepEqual((await capabilityEvidence(cap.id,root)).cases,report.cases);

  await fs.appendFile(caseFile,'// modified candidate\n');
  const stale=await capabilityEvidence(cap.id,root);
  assert.equal(stale.state,'stale');
  assert.deepEqual(stale.cases.map(item=>item.state),['stale','stale','stale','not-run']);
  assert.deepEqual(stale.cases.map(item=>item.observedState),['passed','failed','skipped',undefined]);

  await fs.writeFile(caseFile,header+testLine(passed)+testLine(passed)+
    testLine(failed,"()=>{throw Error('todo is not passed')}",'{todo:true},')+testLine(skipped)+testLine(missing));
  await writeFixtureIndex(root,needs,entities);
  const next=await runCapabilityTests(cap.id,root);
  assert.equal(next.state,'passed',next.output);
  assert.deepEqual(next.cases.map(item=>item.state),['not-run','skipped','passed','passed']);
  assert.deepEqual(next.caseCoverage,{state:'incomplete',declared:4,passed:2,failed:0,skipped:1,notRun:1,stale:0,unlinked:0});
  assert.match(next.message,/关联用例证据尚不完整/,'passing TAP output does not claim all declared cases were verified');
  assert.match(next.cases[0].message,/无法唯一关联/);
  assert.ok(next.cases.every(item=>!('observedState' in item)),'fresh run replaces stale outcomes');

  await fs.writeFile(caseFile,header+"import fs from 'node:fs/promises';\n"+
    testLine(passed,"async()=>{await fs.appendFile(import.meta.filename,'\\n// changed during execution\\n')}"));
  await writeFixtureIndex(root,needs,entities);
  const changed=await runCapabilityTests(cap.id,root);
  assert.equal(changed.state,'stale');
  assert.equal(changed.cases[0].state,'stale');
  assert.equal(changed.cases[0].observedState,'passed');
  assert.equal(changed.cases[1].state,'not-run');
});

test('测试关联变更按当前声明投影；旧文件、删除条目和旧 verifies 不会继续提供通过证据',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-case-binding-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'tests'));
  const cap=listCapabilities().find(item=>item.id==='fixture.execute');
  const header="import test from 'node:test';\n";
  for(const file of cap.testFiles)await fs.writeFile(path.join(root,file),header);
  await fs.appendFile(path.join(root,'tests/fixture.test.mjs'),"test('[TEST_ONE] one',()=>{});\n");
  const needs={
    REQ_ONE:{id:'REQ_ONE',type:'req',parts:{AC_ONE:{id:'AC_ONE'},AC_TWO:{id:'AC_TWO'}}},
    SPEC_ONE:{id:'SPEC_ONE',type:'spec',node_id:'operation',fulfills:['REQ_ONE']},
    TEST_ONE:{id:'TEST_ONE',type:'test',title:'one',verifies:['REQ_ONE.AC_ONE']},
  };
  const entities=[{path:'tests/fixture.test.mjs',needIds:['TEST_ONE'],markerLines:[1]}];
  await writeFixtureIndex(root,needs,entities);
  const report=await runCapabilityTests(cap.id,root);
  assert.equal(report.state,'passed');assert.equal(report.cases[0].state,'passed');
  assert.equal(report.caseCoverage.state,'complete');

  needs.TEST_ONE.verifies=['REQ_ONE.AC_TWO'];
  await writeFixtureIndex(root,needs,entities);
  const relinked=await capabilityEvidence(cap.id,root);
  assert.equal(relinked.state,'stale');assert.equal(relinked.cases[0].state,'stale');
  assert.equal(relinked.cases[0].verifies[0].acceptanceId,'AC_TWO','current meaning replaces the obsolete report link');

  entities[0].path='tests/fixture-api.test.mjs';
  await writeFixtureIndex(root,needs,entities);
  const moved=await capabilityEvidence(cap.id,root);
  assert.equal(moved.state,'stale');assert.equal(moved.cases[0].state,'not-run');
  assert.equal(moved.cases[0].file,'tests/fixture-api.test.mjs','a previous result cannot bind to a different file');
  delete needs.TEST_ONE;
  await writeFixtureIndex(root,needs,[]);
  const removed=await capabilityEvidence(cap.id,root);
  assert.equal(removed.state,'stale');assert.deepEqual(removed.cases,[],'deleted declarations are not live evidence');
});

test('已配置但缺失或失败的索引不产生通过的关联证据，真实 TAP 结果单独保留',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-case-index-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['tests','traceability'])await fs.mkdir(path.join(root,dir));
  const cap=listCapabilities().find(item=>item.id==='fixture.execute');
  for(const file of cap.testFiles)await fs.writeFile(path.join(root,file),"import test from 'node:test';test('real assertion',()=>{});\n");
  await fs.writeFile(path.join(root,'traceability/conf.py'),'# Missing build\n');
  const missing=await runCapabilityTests(cap.id,root);
  assert.equal(missing.state,'stale');assert.equal(missing.executionState,'passed');
  assert.equal(missing.passed,3);assert.equal(missing.caseCoverage.state,'unindexed');
  assert.equal((await capabilityEvidence(cap.id,root)).state,'stale','a repeat read cannot turn a missing index green');

  const needs={REQ_ONE:{id:'REQ_ONE',type:'req',parts:{AC_ONE:{id:'AC_ONE'}}},TEST_ONE:{id:'TEST_ONE',type:'test',verifies:['REQ_ONE.AC_ONE']}};
  const entities=[{path:'tests/fixture.test.mjs',needIds:['TEST_ONE'],markerLines:[1]}];
  await fs.writeFile(path.join(root,'tests/fixture.test.mjs'),"import test from 'node:test';test('[TEST_ONE] real assertion',()=>{});\n");
  await writeFixtureIndex(root,needs,entities);
  const stateFile=path.join(root,'traceability/_build/needs/index-state.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  await fs.writeFile(stateFile,JSON.stringify({...state,state:'failed',error:'failed native build'}));
  const failed=await runCapabilityTests(cap.id,root);
  assert.equal(failed.state,'stale');assert.equal(failed.executionState,'passed');
  assert.equal(failed.cases[0].state,'stale');assert.equal(failed.cases[0].observedState,'passed');
  assert.equal(failed.caseCoverage.state,'unindexed');
  assert.equal((await capabilityEvidence(cap.id,root)).cases[0].state,'stale');
});

test('empty trusted test registration never launches Node test discovery',async t=>{
  const cap={id:'fixture.empty',nodeIds:[],testFiles:[]};
  featureRegistry.capabilities.push(cap);
  t.after(()=>featureRegistry.capabilities.splice(featureRegistry.capabilities.indexOf(cap),1));
  await assert.rejects(runCapabilityTests(cap.id),/尚未登记可信测试文件/);
});
