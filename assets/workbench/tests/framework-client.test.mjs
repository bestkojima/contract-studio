import test from 'node:test';
import assert from 'node:assert/strict';
import { graphFocus } from '../src/graph-focus.mjs';
import { sameGraph, reconcileGraphSave } from '../src/graph-state.mjs';
import { resolveFeature, visibleFeatures, capabilityDestination } from '../src/feature-navigation.mjs';

const feature=(alias,entry)=>({id:`${alias}.feature`,alias,frontend:{entry}});
const catalog={defaultFeature:'project',features:[feature('project','project-ui'),feature('secondary','secondary'),feature('detail','project-ui'),feature('new-feature','new-ui')]};
test('工作区导航按登记目录解析分组入口与新增功能，能力跳转不内置模式表',()=>{
  assert.equal(resolveFeature(catalog,'detail',null).alias,'detail');
  assert.equal(resolveFeature(catalog,'detail.feature',null).alias,'detail');
  assert.equal(resolveFeature(catalog,null,'detail').alias,'project');
  assert.equal(resolveFeature(catalog,null,'secondary').alias,'secondary');
  assert.equal(resolveFeature(catalog,'new-feature',null).frontend.entry,'new-ui');
  assert.deepEqual(visibleFeatures(catalog,'detail').map(item=>item.alias),['project','secondary','detail','new-feature']);
  const capability={frontend:{entry:'new-ui',feature:'new-feature',mode:'future-mode'}};
  assert.equal(capabilityDestination(catalog,capability).alias,'new-feature');
  assert.equal(capabilityDestination(catalog,{frontend:{entry:'missing',feature:'untrusted'}}),undefined);
});

const node=(id,parentId=null)=>({id,title:`标题 ${id}`,parentId,position:{x:5000,y:9000},kind:'logic'});
test('聚焦只投影当前节点、直连与直接子节点，并保留父功能上下文；不修改原图',()=>{
  const graph={nodes:[node('root'),node('group','root'),node('selected','group'),node('input','group'),node('ok','group'),node('fail','group'),node('child','selected'),node('deep','child'),node('unrelated','root')],edges:[{source:'input',target:'selected'},{source:'selected',target:'ok'},{source:'selected',target:'fail'}]};
  const before=JSON.stringify(graph);
  const view=graphFocus(graph,'selected');
  assert.deepEqual([...view.ids],['selected','input','ok','fail','child']);
  assert.deepEqual(view.ancestors.map(item=>item.id),['root','group']);
  assert.deepEqual(view.positions.get('selected'),{x:300,y:40});
  assert.ok(view.positions.get('input').x<view.positions.get('selected').x);
  assert.ok(view.positions.get('ok').x>view.positions.get('selected').x);
  assert.equal(JSON.stringify(graph),before);
  assert.deepEqual(graphFocus(graph,'root').ancestors,[]);
  assert.equal(graphFocus(graph,'missing').ids.size,0);
});

test('聚焦功能组的直接子节点横排，继续增加时使用三列网格',()=>{
  const graph={nodes:[node('group'),...['one','two','three','four','five'].map(id=>node(id,'group'))],edges:[{source:'one',target:'two'},{source:'two',target:'three'}]};
  const view=graphFocus(graph,'group');
  const positions=['one','two','three','four','five'].map(id=>view.positions.get(id));
  assert.deepEqual(positions.slice(0,3),[{x:20,y:240},{x:300,y:240},{x:580,y:240}]);
  assert.deepEqual(positions.slice(3),[{x:160,y:420},{x:440,y:420}]);
  assert.equal(graph.edges.filter(edge=>view.ids.has(edge.source)&&view.ids.has(edge.target)).length,2);
});

const submittedGraph=()=>({version:2,feature:{id:'project',title:'项目',goal:'定义功能'},nodes:[{id:'root',title:'项目功能',parentId:null,kind:'group',position:{x:0,y:0},input:'输入',output:'输出',code:'',test:'',capabilityId:undefined}],edges:[]});
const canonicalGraph=graph=>({...structuredClone(graph),nodes:graph.nodes.map(({code,test,capabilityId,...node})=>({...node,needId:`SPEC_${node.id}`}))});

test('保存成功采纳服务端规范图；派生定位与可选空字段不造成永久草稿，重载保持同步',()=>{
  const submitted=submittedGraph(),canonical=canonicalGraph(submitted);
  const current=structuredClone(submitted);
  const settled=reconcileGraphSave(current,JSON.parse(JSON.stringify(submitted)),canonical);
  assert.deepEqual(settled,canonical);
  assert.equal(settled.nodes[0].needId,'SPEC_root');
  assert.equal(Object.hasOwn(settled.nodes[0],'code'),false);
  assert.equal(sameGraph(settled,canonical),true);
  assert.equal(sameGraph(JSON.parse(JSON.stringify(settled)),JSON.parse(JSON.stringify(canonical))),true);
  assert.equal(Object.hasOwn(current.nodes[0],'code'),true);
});

test('保存期间继续修改属性或添加节点时，确认只前进基线，不覆盖后续草稿',()=>{
  const submitted=submittedGraph(),canonical=canonicalGraph(submitted);
  const current=structuredClone(submitted);
  current.nodes[0].title='保存期间的新名称';
  current.nodes.push({...node('child','root'),input:'子输入',output:'子输出'});
  const settled=reconcileGraphSave(current,submitted,canonical);
  assert.equal(settled,current);
  assert.equal(settled.nodes[0].title,'保存期间的新名称');
  assert.equal(settled.nodes.length,2);
  assert.equal(sameGraph(settled,canonical),false);
  const nextCanonical=canonicalGraph(settled);
  assert.equal(sameGraph(reconcileGraphSave(settled,settled,nextCanonical),nextCanonical),true);
});

test('重载时可确认规范化后的待保存快照，实际内容差异仍需要保留与核对',()=>{
  const pending=submittedGraph(),project=canonicalGraph(pending);
  assert.equal(sameGraph(project,pending),true);
  assert.deepEqual(reconcileGraphSave(pending,pending,project),project);
  project.nodes[0].output='其他写入者的新输出';
  assert.equal(sameGraph(project,pending),false);
});
