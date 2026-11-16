import fs from 'node:fs';
import assert from 'node:assert/strict';
import { listCapabilities } from '../server/capabilities.mjs';
import { nodeImportance } from '../src/node-importance.mjs';
const capabilities=new Set(listCapabilities().map(cap=>cap.id));
for(const file of fs.readdirSync('contracts').filter(name=>name.endsWith('.json'))) {
  const graph=JSON.parse(fs.readFileSync(`contracts/${file}`,'utf8'));
  if(!Array.isArray(graph.nodes))continue;
  assert.equal(graph.version,2,`${file}: unsupported graph version`);
  const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
  assert.equal(nodes.size,graph.nodes.length,`${file}: duplicate node ID`);
  for(const node of graph.nodes) {
    nodeImportance(node.importance);
    assert.ok(node.id&&node.title&&node.position&&Number.isFinite(node.position.x)&&Number.isFinite(node.position.y),`${file}: invalid node ${node.id}`);
    if(node.capabilityId)assert.ok(capabilities.has(node.capabilityId),`${file}: unknown capability ${node.capabilityId}`);
    const visited=new Set([node.id]);let parent=node.parentId;
    while(parent){assert.ok(nodes.has(parent)&&!visited.has(parent),`${file}: invalid parent chain for ${node.id}`);visited.add(parent);parent=nodes.get(parent).parentId;}
  }
  const edges=new Set();
  for(const edge of graph.edges){assert.ok(edge.id&&!edges.has(edge.id)&&nodes.has(edge.source)&&nodes.has(edge.target),`${file}: invalid edge ${edge.id}`);edges.add(edge.id);}
  console.log(`Graph OK: ${file} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
}
