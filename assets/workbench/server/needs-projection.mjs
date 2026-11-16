import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nodeNeedId, entitySpecIds } from './backend-relations.mjs';
import { indexedTestCases } from './indexed-tests.mjs';
import { defaultMappingRules as defaults, nodeProperties } from './needs-schema.mjs';
export { mappingRules, nodeProperties } from './needs-schema.mjs';
const parse=(text,fallback)=>text?JSON.parse(text):fallback;
export const specNodeId=(need,rules=defaults)=>need[rules.id]||need.id;
export function projectNeedsGraph(graph,needs,feature,rules=defaults,entities=[],refs=new Map()) {
  const specs=Object.values(needs).filter(need=>need.type===rules.type&&need[rules.feature]===graph.feature.id);
  specs.sort((a,b)=>(graph.nodes.findIndex(node=>node.id===specNodeId(a,rules))+1||Infinity)-(graph.nodes.findIndex(node=>node.id===specNodeId(b,rules))+1||Infinity));
  const byId=new Map(specs.map(need=>[need.id,need]));
  const original=new Map(graph.nodes.map(node=>[node.id,node]));
  const cases=indexedTestCases(needs,entities);
  const mapped=new Set();
  const nodes=specs.map((need,index)=>{
    const id=specNodeId(need,rules),before=original.get(id);
    if(mapped.has(id))throw Error(`多个规格映射到同一节点：${id}`);
    mapped.add(id);
    const fields=Object.fromEntries(Object.entries(rules.fields).filter(([,field])=>need[field]!=null).map(([key,field])=>[key,need[field]]));
    const properties=nodeProperties({...rules.defaults,...fields,...parse(need[rules.properties],{})});
    const parent=byId.get(need[rules.links.parent]?.[0])??specs.find(item=>(item[rules.links.children]??[]).includes(need.id));
    const layout=graph._needsLayout?.[id]??before??{};
    const code=entities.filter(entity=>entity.symbol&&entitySpecIds(entity,needs).includes(need.id)&&!entity.path.startsWith('tests/')).map(entity=>`${entity.path}#${entity.symbol}`);
    const requirements=need[rules.links.requirements]??[];
    const tests=[...requirements.flatMap(id=>(refs.get(id)??[]).filter(ref=>ref.path.startsWith('tests/')).map(ref=>ref.path)),
      ...cases.filter(test=>test.verifies.some(link=>requirements.includes(link.requirementId))).flatMap(test=>test.files)];
    return {...properties,id,title:need.title,needId:need.id,parentId:parent?specNodeId(parent,rules):before?.parentId??null,
      ...(code.length?{code:[...new Set(code)].join(', ')}:{}),...(tests.length?{test:[...new Set(tests)].join(', ')}:{}),
      position:layout.position??{x:(index%3)*340,y:Math.floor(index/3)*180},...(layout.size?{size:layout.size}:{})};
  });
  // Unindexed legacy nodes remain editable; an index never hides newly saved drafts.
  for(const node of graph.nodes)if(!mapped.has(node.id))nodes.push({...node});
  const edges=[];
  for(const need of specs) {
    const id=specNodeId(need,rules),authored=parse(need[rules.edges],null);
    if(authored)edges.push(...authored);
    else for(const targetId of need[rules.links.flow]??[]) {
      const target=byId.get(targetId);
      if(target)edges.push({id:`${need.id}__${targetId}`,source:id,target:specNodeId(target,rules),sourceHandle:'ok',targetHandle:'in'});
    }
  }
  for(const edge of graph.edges)if(!mapped.has(edge.source))edges.push({...edge});
  const {_needsLayout,...base}=graph;
  return {...base,nodes,edges};
}

export async function readProjectedGraph(root,feature) {
  // Retain the original module entry for existing callers; one owner interprets sources.
  const {openTraceability}=await import('./traceability.mjs');
  return (await openTraceability(root)).graph(feature);
}

export function projectedRequirements(original,graph,needs,rules=defaults) {
  const specs=graph.nodes.map(node=>({node,need:needs[node.needId]})).filter(item=>item.need);
  const ids=new Set(specs.flatMap(({need})=>need[rules.links.requirements]??[]));
  const existing=new Set(original.map(req=>req.id));
  const requirements=original.map(req=>({...req,nodeIds:[...new Set([
    ...(req.nodeIds??[req.nodeId].filter(Boolean)),
    ...specs.filter(({need})=>(need[rules.links.requirements]??[]).includes(req.id)).map(({node})=>node.id)
  ])]}));
  for(const id of ids) {
    const need=needs[id];if(existing.has(id)||!need)continue;
    const description=(need.content??'').split('\n').filter(line=>!/:\s*(?:need_part|np):`/.test(line)).join('\n').trim();
    const meta=parse(need.requirement_properties,{});
    const acceptance=Object.values(need.parts??{}).map(part=>{
      const id=/^PART_(?:[A-F0-9]{2})+$/.test(part.id)?Buffer.from(part.id.slice(5),'hex').toString('utf8'):part.id;
      return {id,input:'',...meta.acceptanceDetails?.[id],expected:part.content.trim()};
    });
    const confirmed=need.status==='confirmed'&&meta.confirmedText?.title===need.title&&meta.confirmedText?.description===description;
    const acceptanceConfirmed=meta.acceptanceStatus==='confirmed'&&isDeepStrictEqual(meta.confirmedAcceptance,acceptance);
    const nodeIds=specs.filter(({need:spec})=>(spec[rules.links.requirements]??[]).includes(id)).map(({node})=>node.id);
    const {acceptanceDetails,...metadata}=meta;
    requirements.push({...metadata,id,title:need.title,description,nodeId:nodeIds[0],nodeIds,acceptance,
      revision:(meta.revision??1)+(need.status==='confirmed'&&!confirmed?1:0)+(meta.acceptanceStatus==='confirmed'&&!acceptanceConfirmed?1:0),
      status:confirmed?'confirmed':'draft',acceptanceStatus:acceptanceConfirmed?'confirmed':'draft',
      sourceDocument:`traceability/${need.docname}.rst`});
  }
  return requirements;
}

// Use Sphinx's directive location to update one source block, leaving adjacent prose intact.
export async function updateNeedSource(root,need,{title,options={},body,remove=false}) {
  const file=path.resolve(root,'traceability',`${need.docname}.rst`);
  const relative=path.relative(path.resolve(root,'traceability'),file);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('需求源路径不在 traceability 中');
  const text=await fs.readFile(file,'utf8'),lines=text.split(/\r?\n/);
  const start=need.lineno-1;
  const header=lines[start]?.match(/^(\s*)\.\.\s+(\w+)::(.*)$/);
  if(!header||header[2]!==need.type)throw Error(`需求源位置已变化，请重建索引：${need.id}`);
  let end=start+1;
  while(end<lines.length&&(!lines[end].trim()||lines[end].match(/^\s*/)[0].length>header[1].length))end++;
  const block=lines.slice(start,end);
  if(!block.some(line=>line.trim()===`:id: ${need.id}`))throw Error(`需求源 ID 已变化：${need.id}`);
  if(remove)lines.splice(start,end-start);
  else {
    const indent=header[1]+'   ',values=new Map();let bodyAt=1;
    while(bodyAt<block.length) {
      const option=block[bodyAt].match(/^\s+:([\w-]+):\s*(.*)$/);
      if(!option)break;
      values.set(option[1],option[2]);bodyAt++;
    }
    for(const [key,value] of Object.entries(options))value===null?values.delete(key):values.set(key,String(value));
    const replacement=[`${header[1]}.. ${need.type}:: ${title??header[3].trim()}`,...[...values].map(([key,value])=>`${indent}:${key}: ${value}`),
      ...(body===undefined?block.slice(bodyAt):['',...body.split('\n').map(line=>line?indent+line:''),'']), ''];
    lines.splice(start,end-start,...replacement);
  }
  await fs.writeFile(file,lines.join('\n'),'utf8');
}

export async function saveProjectedGraph(root,feature,source,current,next,needs,rules=defaults) {
  const legacyIds=new Set(source.nodes.map(node=>node.id));
  const native=current.nodes.filter(node=>!legacyIds.has(node.id)&&node.needId&&needs[node.needId]);
  const nativeIds=new Set(native.map(node=>node.id));
  // Bottom-up keeps Sphinx line locations valid when several blocks share a document.
  const behavior=node=>node?{title:node.title,parentId:node.parentId,...nodeProperties(node)}:null;
  const children=(graph,id)=>graph.nodes.filter(node=>node.parentId===id).map(node=>node.id);
  const changed=native.filter(node=>!isDeepStrictEqual(behavior(node),behavior(next.nodes.find(item=>item.id===node.id)))||
    !isDeepStrictEqual(children(current,node.id),children(next,node.id))||
    !isDeepStrictEqual(current.edges.filter(edge=>edge.source===node.id),next.edges.filter(edge=>edge.source===node.id)))
    .sort((a,b)=>needs[b.needId].lineno-needs[a.needId].lineno);
  for(const before of changed) {
    const node=next.nodes.find(item=>item.id===before.id),need=needs[before.needId];
    if(!node){await updateNeedSource(root,need,{remove:true});continue;}
    const properties=nodeProperties(node), fields={};let body;
    for(const [key,field] of Object.entries(rules.fields)) {
      if(field==='content')body=node[key]??'';
      else if(field!=='title')fields[field]=node[key]??'';
      delete properties[key];
    }
    const specId=id=>next.nodes.find(item=>item.id===id)?.needId??nodeNeedId(id,feature);
    const options={...fields,
      [rules.properties]:JSON.stringify(properties),
      [rules.links.parent]:node.parentId?(next.nodes.find(item=>item.id===node.parentId)?.needId??nodeNeedId(node.parentId,feature)):'',
      [rules.edges]:JSON.stringify(next.edges.filter(edge=>edge.source===node.id)),
      [rules.links.flow]:[...new Set(next.edges.filter(edge=>edge.source===node.id).map(edge=>specId(edge.target)))].join(', '),
      [rules.links.children]:next.nodes.filter(item=>item.parentId===node.id).map(item=>item.needId??nodeNeedId(item.id,feature)).join(', ')
    };
    await updateNeedSource(root,need,{title:node.title,options,body});
  }
  const strip=node=>{const {needId,properties,code,test,...value}=node;const old=source.nodes.find(item=>item.id===node.id);return {...value,...(old?.code?{code:old.code}:{}),...(old?.test?{test:old.test}:{})};};
  const layout={};
  for(const node of next.nodes)if(nativeIds.has(node.id))layout[node.id]={needId:node.needId,position:node.position,...(node.size?{size:node.size}:{})};
  const graph={...source,...next,nodes:next.nodes.filter(node=>!nativeIds.has(node.id)).map(strip),
    edges:next.edges.filter(edge=>!nativeIds.has(edge.source)),...(native.length?{_needsLayout:layout}:{})};
  const target=path.join(root,feature.graphFile),temp=`${target}.${process.pid}.tmp`;
  await fs.writeFile(temp,JSON.stringify(graph,null,2)+'\n','utf8');await fs.rename(temp,target);
}
