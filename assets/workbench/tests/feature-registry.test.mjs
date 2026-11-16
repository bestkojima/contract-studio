import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFeatureRegistry, featureRegistry, featureCatalog } from '../server/feature-registry.mjs';
import { api } from '../server/api.mjs';

async function request(method,url,body,headers={}) {
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:5173','content-type':'application/json',...headers}});
  const res={setHeader(){},end(text){this.body=JSON.parse(text);}};
  await api(req,res,()=>assert.fail('Unexpected middleware fallback'));
  return res;
}

test('可信业务声明一次连接图来源、前端、路由和能力，新增声明无需宿主分支',async()=>{
  const feature={id:'text.length',alias:'length',frontend:{entry:'text',feature:'length',mode:'length'}};
  const bundle={id:'text',features:[feature],capabilities:[{id:'text.length',runPath:'/api/text',testPath:'/api/text/test',frontend:feature.frontend}],routes:[
    {method:'POST',path:'/api/text',handle:body=>({value:body.text.length})},
    {method:'POST',path:'/api/text/test',handle:body=>({value:body.input.text.length})}
  ]};
  const registry=createFeatureRegistry([bundle]);
  assert.equal(registry.resolveFeature('length'),feature);
  assert.equal(registry.resolveFeature('text.length'),feature);
  assert.deepEqual(await registry.route('POST','/api/text').handle({text:'abc'}),{value:3});
  assert.deepEqual(await registry.route('POST','/api/text/test').handle({input:{text:'hello'}}),{value:5});
  assert.equal(registry.route('POST','/api/unknown'),undefined);
  assert.throws(()=>createFeatureRegistry([bundle,bundle]),/Duplicate/);
  assert.throws(()=>createFeatureRegistry([{...bundle,routes:[]}]),/Missing trusted routes/);
});

test('blank template exposes one neutral feature and no executable capability',async()=>{
  const response=await request('GET','/api/features');
  assert.equal(response.statusCode,200);
  const {defaultFeature,features,capabilities}=response.body;
  assert.equal(defaultFeature,'project');
  assert.equal(featureRegistry.defaultTrace.id,'project');
  assert.deepEqual(features.map(feature=>feature.alias),['project']);
  const feature=features[0];
  assert.equal(feature.graph.feature.id,'project');
  assert.deepEqual(feature.graph.nodes.map(node=>node.id),['root']);
  assert.deepEqual(feature.graph.edges,[]);
  assert.equal(feature.defaultSelected,'root');
  assert.equal(feature.frontend.path,'features/project/client.tsx');
  assert.equal(feature.frontend.component,'ProjectPanel');
  assert.deepEqual(capabilities,[]);
  assert.deepEqual(featureRegistry.trials,[]);
  assert.equal(featureRegistry.route('POST','/api/unregistered'),undefined);
  assert.equal(JSON.stringify(response.body).includes('handle'),false);
  feature.title='browser change';
  assert.notEqual((await featureCatalog()).features[0].title,'browser change');
});

test('API rejects unknown registrations; the root begins unbound without fabricated evidence',async()=>{
  for(const query of ['','?feature=','?feature=project']){
    const response=await request('GET','/api/traceability'+query);
    assert.equal(response.statusCode,200);
    assert.equal(response.body.featureId,'project');
    assert.deepEqual(response.body.requirements,[]);
  }
  for(const url of ['/api/traceability?feature=unknown','/api/node-context?feature=unknown&nodeId=root'])assert.equal((await request('GET',url)).statusCode,404);
  for(const url of ['/api/traceability/build','/api/traceability/graph','/api/traceability/requirement'])assert.equal((await request('POST',url,{featureId:'unknown'})).statusCode,404);
  assert.equal((await request('GET','/api/code?nodeId=root')).statusCode,404);
  assert.deepEqual((await request('GET','/api/capabilities')).body.capabilities,[]);
  assert.equal((await request('POST','/api/capabilities/test',{capabilityId:'unregistered'})).statusCode,400);
});

test('node context preview shares saved contract, retains provenance and makes no disk change',async()=>{
  const catalog=await featureCatalog();const graph=catalog.features[0].graph;
  const before=JSON.stringify(graph);
  const saved=await request('GET','/api/node-context?feature=project&nodeId=root');
  assert.equal(saved.statusCode,200);
  assert.equal(saved.body.context.node.id,'root');
  assert.equal(saved.body.context.provenance.graph,'saved');
  assert.equal(saved.body.context.capability,null);
  assert.equal(saved.body.context.evidence,null);
  assert.ok(saved.body.context.gaps.some(gap=>gap.code==='capability.missing'));
  graph.nodes[0].description+=' draft';
  const preview=await request('POST','/api/node-context/preview',{featureId:'project',nodeId:'root',graph});
  assert.equal(preview.statusCode,200);
  assert.equal(preview.body.context.provenance.graph,'draft');
  assert.equal(preview.body.context.provenance.semanticChanges,true);
  assert.match(preview.body.markdown,/draft/);
  assert.match(preview.body.taskMarkdown,/draft/);
  assert.equal(JSON.stringify((await featureCatalog()).features[0].graph),before);
  assert.equal((await request('GET','/api/node-context?feature=project&nodeId=missing')).statusCode,404);
  assert.equal((await request('POST','/api/node-context/preview',{featureId:'project',nodeId:'root'})).statusCode,400);
  for(const url of ['/api/features','/api/node-context?feature=project&nodeId=root'])assert.equal((await request('GET',url,undefined,{origin:'https://example.org'})).statusCode,403);
  assert.equal((await request('POST','/api/node-context/preview',{featureId:'project',nodeId:'root',graph},{origin:'https://example.org'})).statusCode,403);
});
