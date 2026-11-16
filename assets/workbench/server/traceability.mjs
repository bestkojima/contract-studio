import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readNeedsIndex, buildNeedsIndex, indexConfigured } from './needs-index.mjs';
import { nodeImportance } from '../src/node-importance.mjs';
import { featureRegistry } from './feature-registry.mjs';
import { backendRelations, nodeNeedId, acceptancePartId, indexedCapabilityBindings, entitySpecIds } from './backend-relations.mjs';
import { mappingRules, nodeProperties, projectNeedsGraph, projectedRequirements, saveProjectedGraph, updateNeedSource } from './needs-projection.mjs';
import { normalizeNeeds, defaultMappingRules } from './needs-schema.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function featureConfig(featureId) {
  // Legacy direct callers may use their own feature ID in the original file pair.
  // Public API callers resolve registered IDs before entering this compatibility path.
  return featureRegistry.resolveFeature(featureId)??featureRegistry.defaultTrace;
}
const nodeIdsOf = requirement => requirement.nodeIds ?? [requirement.nodeId].filter(Boolean);
const acceptanceOf = requirement => requirement.acceptance ?? [];

function validateNodeIds(value) {
  if(!Array.isArray(value)||!value.length||value.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.-]{1,120}$/.test(id)))throw new TraceError('功能节点 ID 不合法');
  return [...new Set(value)];
}
function validateAcceptance(value) {
  if(!Array.isArray(value)||value.length>100)throw new TraceError('验收条件必须是数组（最多 100 项）');
  const ids=new Set();
  return value.map(item=>{
    if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9_.-]{1,120}$/.test(item.id)||ids.has(item.id)||typeof item.input!=='string'||typeof item.expected!=='string'||!item.expected.trim()||(item.observable!==undefined&&typeof item.observable!=='string'))throw new TraceError('验收条件需包含唯一 ID、输入和预期结果');
    ids.add(item.id);
    return {id:item.id,input:item.input,expected:item.expected,...(item.observable!==undefined?{observable:item.observable}:{})};
  });
}

export class TraceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function loadRequirements(root, feature = featureConfig()) {
  const { requirementFile } = feature;
  const data = JSON.parse(await fs.readFile(path.join(root, requirementFile), 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.requirements)) throw new Error('Invalid requirements data');
  // An out-of-band edit to confirmed content must not inherit the old approval.
  for (const item of data.requirements) {
    if (item.status === 'confirmed' && (item.confirmedText?.title !== item.title || item.confirmedText?.description !== item.description)) {
      item.status = 'draft';
      item.revision += 1;
      delete item.confirmedAt;
      delete item.confirmedText;
    }
    if (item.acceptanceStatus === 'confirmed' && !isDeepStrictEqual(item.confirmedAcceptance, acceptanceOf(item))) {
      item.acceptanceStatus = 'draft';
      item.revision += 1;
      delete item.confirmedAcceptance;
      delete item.acceptanceConfirmedAt;
    }
  }
  return data;
}

export function validateGraph(graph, featureId, externalIds = []) {
  if (!graph || typeof graph !== 'object' || graph.version !== 2 || graph.feature?.id !== featureId || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new TraceError('功能图格式或 featureId 不匹配');
  if (typeof graph.feature.title !== 'string' || typeof graph.feature.goal !== 'string') throw new TraceError('功能图缺少标题或目标');
  const ids = new Set();
  for (const node of graph.nodes) {
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.title !== 'string' || !node.title.trim() || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new TraceError('功能图节点 ID、标题或位置无效');
    try { nodeImportance(node.importance); } catch (error) { throw new TraceError(`${node.id}: ${error.message}`); }
    ids.add(node.id);
  }
  const endpoints = new Set([...ids,...externalIds]);
  for (const node of graph.nodes) {
    if (node.parentId && !endpoints.has(node.parentId)) throw new TraceError(`功能图包含未找到的父节点: ${node.parentId}`);
    const parents = new Set([node.id]);
    let parent = node.parentId;
    while (parent) {
      if (parents.has(parent)) throw new TraceError(`功能图父子关系存在循环: ${node.id}`);
      parents.add(parent);
      parent = graph.nodes.find(n => n.id === parent)?.parentId;
    }
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || !endpoints.has(edge.source) || !endpoints.has(edge.target)) throw new TraceError(`功能图边 ID 或端点无效: ${edge.id}`);
    edgeIds.add(edge.id);
  }
  return graph;
}

async function loadGraph(root, featureId, feature = featureConfig(featureId)) {
  const { graphFile } = feature;
  const graph=JSON.parse(await fs.readFile(path.join(root, graphFile), 'utf8'));
  return validateGraph(graph, featureId, Object.keys(graph._needsLayout??{}));
}

// Saving is a new operation: enforce the existing contract checker without
// imposing these additional requirements on reads of legacy graphs.
function validateGraphForSave(graph, featureId) {
  validateGraph(graph, featureId);
  for (const node of graph.nodes) {
    if (!node.input || !node.output) throw new TraceError(`功能节点缺少输入或输出: ${node.id}`);
  }
  for (const edge of graph.edges) {
    if (!['ok', 'fail'].includes(edge.sourceHandle)) throw new TraceError(`功能图边输出端口无效: ${edge.id}`);
  }
  return graph;
}

function rstText(data, graph, feature = featureConfig()) {
  const { requirementFile, graphFile } = feature;
  const esc = (s) => s.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('`', '\\`').replaceAll('|', '\\|').replaceAll('_', '\\_');
  // Hex-encoded UTF-8 is reversible and collision-free, including case and punctuation.
  const functionId = nodeId => graph._needsLayout?.[nodeId]?.needId ?? nodeNeedId(nodeId,feature);
  const lines = ['需求与功能图', '============', '', `.. 由 ${requirementFile} 和 ${graphFile} 生成；请修改源文件或使用工作台，不要直接编辑。`, '', '需求条目', '--------', ''];
  for (const r of (feature.requirementSources?.length ? data.requirements.filter(r => !r.sourceFeatureId) : data.requirements)) {
    lines.push(`.. req:: ${esc(r.title)}`, `   :id: ${r.id}`, `   :status: ${r.status}`, '', ...r.description.split('\n').map(line => `   ${esc(line)}`), '');
    if (acceptanceOf(r).length) {
      lines.push('   验收条件：', '');
      for(const item of acceptanceOf(r))lines.push(`   * :need_part:\`(${acceptancePartId(item.id)}) ${esc(`输入 ${item.input}；预期 ${item.expected}${item.observable?'；观察 '+item.observable:''}`).replaceAll('\n',' ')}\``);
      lines.push('');
    }
  }
  lines.push('项目功能图', '----------', '', `仅包含 ${graphFile} 已持久的图；浏览器画布草稿不会自动写入此文件。`, '', '.. 持久图完整快照，仅用于过期检测；来源仍以 JSON 文件为准。', `   ${JSON.stringify(graph)}`, '');
  for (const node of graph.nodes) {
    const children = graph.nodes.filter(n => n.parentId === node.id).map(n => functionId(n.id));
    const outgoing = graph.edges.filter(e => e.source === node.id);
    const destinations = [...new Set(outgoing.map(e => functionId(e.target)))];
    const requirements = data.requirements.filter(r => nodeIdsOf(r).includes(node.id)).map(r => r.id);
    lines.push(`.. spec:: ${esc(node.title)}`, `   :id: ${functionId(node.id)}`);
    if (node.importance !== undefined) lines.push(`   :importance: ${node.importance}`);
    if (requirements.length) lines.push(`   :fulfills: ${requirements.join(', ')}`);
    if (children.length) lines.push(`   :contains: ${children.join(', ')}`);
    if (destinations.length) lines.push(`   :flows_to: ${destinations.join(', ')}`);
    lines.push('', '   功能节点原始字段::', '', `      ${JSON.stringify(node)}`, '');
    if (outgoing.length) {
      lines.push('   原始业务出边（含端口、分支标签和其他字段）::', '');
      for (const edge of outgoing) lines.push(`      ${JSON.stringify(edge)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function exportNeeds(root = projectRoot, featureId) {
  const feature = featureConfig(featureId);
  const data = await combinedRequirements(root, feature);
  const graph = await loadGraph(root, data.featureId, feature);
  const target = path.join(root, feature.rstFile);
  const text = rstText(data, graph, feature);
  try { if(await fs.readFile(target,'utf8')===text)return; }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  await fs.mkdir(path.join(root, 'traceability'), { recursive: true });
  await fs.writeFile(target, text, 'utf8');
}

async function exportBuildSources(root, featureId) {
  const selected = featureId === undefined ? featureRegistry.features.map(feature=>feature.id)
    : [...(featureConfig(featureId).requirementSources??[]),featureId];
  for(const id of selected) {
    const feature = featureConfig(id);
    // Standalone projects/fixtures may contain only their own source pair.
    // Explicit rebuilding never asks them to create unrelated feature files.
    let present=true;
    for(const file of [feature.requirementFile,feature.graphFile]) {
      try { if(!(await fs.stat(path.join(root,file))).isFile())present=false; }
      catch(error) { if(error.code==='ENOENT')present=false;else throw error; }
    }
    if(present)await exportNeeds(root,id);
  }
}

async function exportNodeProperties(root) {
  const lines=[':orphan:','','节点字段投影','============','','.. 由契约源生成的 needextend 字段；请编辑契约源。',''];
  for(const feature of featureRegistry.features) {
    try { await fs.access(path.join(root,feature.requirementFile));await fs.access(path.join(root,feature.graphFile)); }
    catch(error) { if(error.code==='ENOENT')continue;throw error; }
    const data=await combinedRequirements(root,feature);
    const graph=await loadGraph(root,data.featureId,feature);
    for(const node of graph.nodes)lines.push(`.. needextend:: ${nodeNeedId(node.id,feature)}`,
      `   :feature_id: ${graph.feature.id}`,`   :node_id: ${node.id}`,
      `   :contract_source: ${feature.graphFile}`,
      ...(node.parentId?[`   :parent_spec: ${graph._needsLayout?.[node.parentId]?.needId??nodeNeedId(node.parentId,feature)}`]:[]),
      `   :node_properties: ${JSON.stringify(nodeProperties(node))}`,
      `   :node_edges: ${JSON.stringify(graph.edges.filter(edge=>edge.source===node.id))}`,'');
  }
  const text=lines.join('\n');
  const target=path.join(root,'traceability/node-properties.rst');
  try { if(await fs.readFile(target,'utf8')===text)return; }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,text,'utf8');
}

async function refreshIndex(root,options) {
  await exportNodeProperties(root);
  return buildNeedsIndex(root,options);
}

// The index build is explicit for legacy consumers. Configured workbenches also
// invoke it after saves; failures are returned as index state, never a source rollback.
export async function buildTraceabilityIndex(root = projectRoot, featureId, options) {
  return serialized(async()=>{
    await exportBuildSources(root,featureId);
    await refreshIndex(root, options);
    return traceability(root, featureId);
  });
}

// Imported requirements remain in their original files; this is a live view.
async function combinedRequirements(root, feature) {
  const own = await loadRequirements(root, feature);
  const sources = await Promise.all((feature.requirementSources??[]).map(async featureId => {
    const data = await loadRequirements(root, featureConfig(featureId));
    return data.requirements.map(r => ({...r, sourceFeatureId: featureId}));
  }));
  return {...own, requirements: [...own.requirements, ...sources.flat()]};
}

// One request owns one interpretation of the source/index pair. Consumers query
// functional views, capabilities and source; they never assemble parser records.
export async function openTraceability(root = projectRoot) {
  const raw = await readNeedsIndex(root);
  const index = {...raw.index};
  const sources = new Map();
  const graphs = new Map();
  async function sourceGraph(feature) {
    if(!graphs.has(feature.graphFile))graphs.set(feature.graphFile,fs.readFile(path.join(root,feature.graphFile),'utf8').then(JSON.parse));
    return graphs.get(feature.graphFile);
  }
  async function sourceRecord(feature) {
    if (!sources.has(feature.id)) sources.set(feature.id,(async()=>{
      const data=await combinedRequirements(root,feature);
      const graph=await sourceGraph(feature);
      validateGraph(graph,data.featureId,Object.keys(graph._needsLayout??{}));
      let state='missing';
      try { state=await fs.readFile(path.join(root,feature.rstFile),'utf8')===rstText(data,graph,feature)?'current':'outdated'; }
      catch(error) { if(error.code!=='ENOENT')throw error; }
      return {data,graph,state};
    })());
    return sources.get(feature.id);
  }
  // A successful build of old RST cannot certify newer JSON. This check applies
  // equally to source navigation, capability evidence and graph/draft queries.
  if(index.state==='current')for(const feature of featureRegistry.features) {
    try { await fs.access(path.join(root,feature.graphFile));await fs.access(path.join(root,feature.requirementFile)); }
    catch(error) { if(error.code==='ENOENT')continue;throw error; }
    if((await sourceRecord(feature)).state!=='current') {
      index.state='stale';index.message='需求源与 RST 未同步，索引尚未包含当前源内容。';
    }
  }
  const needs=normalizeNeeds(raw.needs,await mappingRules(root));
  const entities=raw.entities.map(entity=>({...entity,indexState:index.state}));
  const refs=new Map([...raw.refs].map(([id,items])=>[id,items.map(ref=>{
    if(ref.source!=='sphinx-codelinks'||index.state==='current')return ref;
    const {scope,...location}=ref;return {...location,indexState:index.state};
  })]));
  const capabilities=structuredClone(featureRegistry.capabilities).map(cap=>({...cap,
    ...indexedCapabilityBindings(cap,needs,entities),indexState:index.state}));
  const views=new Map();

  async function graphView(feature) {
    const graph=await sourceGraph(feature);
    const graphNeeds=index.state==='current'?needs:Object.fromEntries(Object.entries(needs).filter(([,need])=>!graph.nodes.some(node=>nodeNeedId(node.id,feature)===need.id)));
    return projectNeedsGraph(graph,graphNeeds,feature,defaultMappingRules,entities,refs);
  }

  async function featureView(featureId,{graph:preview}={}) {
    const feature=featureConfig(featureId);
    if(!views.has(feature.id))views.set(feature.id,(async()=>{
      const {data,state}=await sourceRecord(feature);
      const graph=await graphView(feature);
      if(index.state==='current')validateGraph(graph,data.featureId);
      const requirements=projectedRequirements(data.requirements,graph,needs,defaultMappingRules);
      const backend=backendRelations(graph,requirements,{feature,needs,entities});
      const requirementRefs=id=>{
        const related=backend.functions.filter(fn=>fn.requirementIds.includes(id));
        const tests=backend.testCases.filter(test=>test.verifies.some(link=>link.requirementId===id));
        const implementation=related.flatMap(fn=>fn.needIds.flatMap(id=>refs.get(id)??[]).filter(ref=>ref.path===fn.path&&fn.markerLines.includes(ref.line)));
        const found=[...(refs.get(id)??[]),...implementation,...tests.flatMap(test=>refs.get(test.id)??[])];
        return [...new Map(found.map(ref=>[`${ref.path}:${ref.line}`,ref])).values()];
      };
      return {featureId:data.featureId,source:feature.requirementFile,projectGraph:graph,sphinx:{path:feature.rstFile,state},index,backend,
        relations:Object.values(needs).filter(need=>need.type==='spec').map(need=>({id:need.id,title:need.title,importance:nodeImportance(need.importance),fulfills:need.fulfills??[],contains:need.contains??[],flowsTo:need.flows_to??[]})),
        ubcode:{state:'not-connected',message:'未接入（可选）'},
        requirements:requirements.map(r=>({...r,
          ...(index.state==='current'&&needs[r.id]&&!r.sourceDocument?{title:needs[r.id].title,status:needs[r.id].status}:{}),
          nodeIds:nodeIdsOf(r),acceptance:acceptanceOf(r),acceptanceStatus:r.acceptanceStatus??'draft',
          code:requirementRefs(r.id).filter(ref=>!ref.path.startsWith('tests/')),
          tests:requirementRefs(r.id).filter(ref=>ref.path.startsWith('tests/'))}))};
    })());
    const saved=await views.get(feature.id);
    if(featureId!==undefined&&saved.featureId!==featureId)throw new TraceError('需求文件的功能 ID 不匹配');
    if(preview===undefined)return saved;
    const graph=validateGraph(preview,saved.featureId);
    return {...saved,projectGraph:graph,backend:backendRelations(graph,saved.requirements,{feature,needs,entities})};
  }

  function capabilityContract(id) {
    const binding=capabilities.find(cap=>cap.id===id);
    if(!binding)throw new TraceError('未知的功能能力');
    const specifications=Object.values(needs).filter(need=>need.type==='spec'&&(
      binding.nodeIds.includes(need.node_id||need.id)||JSON.parse(need.node_properties||'{}').capabilityId===id))
      .map(need=>{
        const {position,size,importance,...properties}=JSON.parse(need.node_properties||'{}');
        return {id:need.id,title:need.title,...(need.contract_source?{}:{content:need.content}),properties,
          fulfills:need.fulfills??[],contains:need.contains??[],parent:need.parent_spec??[],flowsTo:need.flows_to??[],edges:need.node_edges??null};
      });
    const requirements=[...binding.requirementIds].sort().filter(id=>needs[id]).map(id=>{
      const need=needs[id];return {id,title:need.title,content:need.content,parts:need.parts};
    });
    return {specifications,requirements};
  }

  async function source({nodeId,path:referencePath,line}={}) {
    if(nodeId===undefined) {
      if(typeof referencePath!=='string'||!Number.isInteger(line)||line<1)throw new TraceError('Invalid source reference');
      if(![...refs.values()].flat().some(ref=>ref.path===referencePath&&ref.line===line))throw new TraceError('Source reference not found',404);
      const lines=(await fs.readFile(path.join(root,referencePath),'utf8')).split(/\r?\n/);
      const startLine=Math.max(1,line-3);
      return {path:referencePath,startLine,excerpt:lines.slice(startLine-1,Math.min(lines.length,line+18)).join('\n')};
    }
    if(typeof nodeId!=='string'||!nodeId||index.state!=='current')return null;
    const possibleIds=new Set([nodeId,...featureRegistry.features.map(feature=>nodeNeedId(nodeId,feature))]);
    const specs=Object.values(needs).filter(need=>need.type==='spec'&&(need.node_id===nodeId||possibleIds.has(need.id)));
    const ids=new Set(specs.map(need=>need.id));
    let candidates=entities.filter(entity=>entity.symbol&&entitySpecIds(entity,needs).some(id=>ids.has(id)));
    let relationSource='spec-marker';
    if(!candidates.length) {
      const requirements=new Set(specs.flatMap(need=>need.fulfills??[]));
      candidates=entities.filter(entity=>entity.symbol&&!entity.path.startsWith('tests/')&&entity.needIds.some(id=>requirements.has(id)));
      if(candidates.length!==1)return null;
      relationSource='requirement-reference';
    }
    const unique=[...new Map(candidates.map(entity=>[`${entity.path}:${entity.startLine}:${entity.endLine}`,entity])).values()];
    const entity=unique[0];
    const text=await fs.readFile(path.join(root,entity.path),'utf8');
    return {symbol:entity.symbol,file:entity.path,startLine:entity.startLine,endLine:entity.endLine,relationSource,
      excerpt:text.split(/\r?\n/).slice(entity.startLine-1,entity.endLine).join('\n').slice(0,4600),
      references:unique.map(({path,symbol,startLine,endLine})=>({path,symbol,startLine,endLine}))};
  }
  return {index,feature:featureView,graph:graphView,capabilities:()=>capabilities,capabilityContract,source};
}

export async function traceability(root = projectRoot, featureId) {
  return (await openTraceability(root)).feature(featureId);
}

let saveQueue = Promise.resolve();
function serialized(fn) {
  const task = saveQueue.then(fn);
  saveQueue = task.catch(() => {});
  return task;
}

function applyRequirementUpdate(item,body,nodeIds,acceptance) {
  if(item.revision!==body.revision)throw new TraceError('需求已被其他操作修改，请刷新后重试',409);
  const title=body.title.trim(),description=body.description.trim().replaceAll('\r\n','\n');
  const changed=item.title!==title||item.description!==description;
  const acceptanceChanged=acceptance!==undefined&&!isDeepStrictEqual(acceptanceOf(item),acceptance);
  const linksChanged=nodeIds!==undefined&&!isDeepStrictEqual(nodeIdsOf(item),nodeIds);
  const confirmAcceptance=body.confirmAcceptance===true;
  if(!(changed||linksChanged||acceptanceChanged||confirmAcceptance||(body.action==='confirm'&&item.status!=='confirmed')))return;
  Object.assign(item,{title,description,revision:item.revision+1});
  if(changed||body.action==='confirm')item.status=body.action==='confirm'?'confirmed':'draft';
  if(body.action==='confirm') {
    item.confirmedAt=new Date().toISOString();item.confirmedText={title,description};
  } else if(changed) {delete item.confirmedAt;delete item.confirmedText;}
  if(nodeIds){item.nodeIds=nodeIds;item.nodeId=nodeIds[0];}
  if(acceptance!==undefined)item.acceptance=acceptance;
  if(acceptanceChanged||confirmAcceptance) {
    item.acceptanceStatus=confirmAcceptance?'confirmed':'draft';
    if(confirmAcceptance){item.confirmedAcceptance=acceptanceOf(item);item.acceptanceConfirmedAt=new Date().toISOString();}
    else {delete item.confirmedAcceptance;delete item.acceptanceConfirmedAt;}
  }
}

async function updateAuthoredRequirement(root,body,nodeIds,acceptance) {
  const view=await traceability(root,body.featureId);
  const item=view.requirements.find(req=>req.id===body.id&&req.sourceDocument);
  if(!item)throw new TraceError('Requirement not found',404);
  if(view.index.state!=='current')throw new TraceError('原生需求索引已过期，请先重建索引再保存',409);
  // The relationship is owned by spec.fulfills, never a second requirement-side table.
  if(nodeIds&&!isDeepStrictEqual(nodeIdsOf(item),nodeIds))throw new TraceError('请在规格文档中修改 fulfills 关联，再重建索引');
  applyRequirementUpdate(item,body,undefined,acceptance);
  const {needs}=await readNeedsIndex(root);
  const {id,title,description,nodeId,nodeIds:linked,sourceDocument,code,tests,acceptance:criteria,status,...metadata}=item;
  metadata.acceptanceDetails=Object.fromEntries(criteria.map(({id,input,observable})=>[id,{input,...(observable!==undefined?{observable}:{})}]));
  const esc=text=>text.replaceAll('\\','\\\\').replaceAll('`','\\`').replaceAll('\n',' ');
  const parts=criteria.map(ac=>`* :need_part:\`(${acceptancePartId(ac.id)}) ${esc(ac.expected)}\``);
  await updateNeedSource(root,needs[id],{title,options:{status,requirement_properties:JSON.stringify(metadata)},
    body:[description,...(parts.length?['',...parts]:[])].join('\n')});
  await refreshIndex(root);
  return traceability(root,body.featureId);
}

export function updateRequirement(body, root = projectRoot) {
  return serialized(async () => {
    if (!body || !['save', 'confirm', 'create'].includes(body.action) || typeof body.id !== 'string') throw new TraceError('Invalid update request');
    if (body.action !== 'create' && !Number.isInteger(body.revision)) throw new TraceError('Invalid revision');
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || /[\r\n]/.test(body.title)) throw new TraceError('需求标题须为 1–200 字且不能换行');
    if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 5000) throw new TraceError('需求描述须为 1–5000 字');
    const isCombined = Boolean(featureConfig(body.featureId).requirementSources?.length);
    const combined = isCombined ? await combinedRequirements(root, featureConfig(body.featureId)) : null;
    if (isCombined && body.action === 'create' && combined.requirements.some(r => r.id === body.id)) throw new TraceError('需求 ID 已存在', 409);
    const owner = isCombined && body.action !== 'create' ? combined.requirements.find(r => r.id === body.id)?.sourceFeatureId : undefined;
    const feature = featureConfig(owner ?? body.featureId);
    const data = await loadRequirements(root, feature);
    const featureId = owner ?? body.featureId ?? data.featureId;
    if (data.featureId !== featureId) throw new TraceError('需求文件的功能 ID 不匹配');
    if (body.featureId && !isCombined && body.featureId !== data.featureId) throw new TraceError('当前功能图不匹配需求来源', 409);
    const nodeIds = body.nodeIds === undefined ? undefined : validateNodeIds(body.nodeIds);
    const acceptance = body.acceptance === undefined ? undefined : validateAcceptance(body.acceptance);
    if (body.action === 'create') {
      const linked = nodeIds ?? validateNodeIds([body.nodeId]);
      if (body.featureId !== data.featureId || !/^REQ_[A-Z0-9_]+$/.test(body.id) || body.id.length > 100) throw new TraceError('需求 ID 或功能节点 ID 不合法');
      if (data.requirements.some(r => r.id === body.id)||(await readNeedsIndex(root)).needs[body.id]) throw new TraceError('需求 ID 已存在', 409);
      data.requirements.push({id: body.id, nodeId: linked[0], ...(nodeIds?{nodeIds}:{}), title: body.title.trim(), description: body.description.trim().replaceAll('\r\n', '\n'), status: 'draft', revision: 1,...(acceptance?{acceptance,acceptanceStatus:'draft'}:{})});
      await persist(root, data, feature);
      if (await indexConfigured(root)) await refreshIndex(root);
      return traceability(root, featureId);
    }
    const item = data.requirements.find(r => r.id === body.id);
    if (!item) return updateAuthoredRequirement(root,body,nodeIds,acceptance);
    applyRequirementUpdate(item,body,nodeIds,acceptance);
    await persist(root,data,feature);
    if (isCombined && owner) await exportNeeds(root, body.featureId);
    if (await indexConfigured(root)) await refreshIndex(root);
    return traceability(root, isCombined ? body.featureId : featureId);
  });
}

export function updateGraph(body, root = projectRoot) {
  return serialized(async () => {
    if (!body || !body.featureId || !body.expectedGraph || !body.graph) throw new TraceError('缺少功能图或基线');
    const feature = featureConfig(body.featureId);
    const data = await loadRequirements(root, feature);
    if (body.featureId !== data.featureId) throw new TraceError('功能图不匹配');
    const source = await loadGraph(root, data.featureId, feature);
    const currentView=await traceability(root,data.featureId);
    const current=currentView.projectGraph;
    const comparable=graph=>({...graph,nodes:graph.nodes.map(({needId,code,test,properties,...node})=>node)});
    if (!isDeepStrictEqual(comparable(current), comparable(body.expectedGraph))) throw new TraceError('项目图已被其他操作修改，请先处理冲突', 409);
    const graph = validateGraphForSave(body.graph, data.featureId);
    const native=current.nodes.some(node=>!source.nodes.some(item=>item.id===node.id));
    if(native&&currentView.index.state!=='current')throw new TraceError('原生规格索引已过期，请先重建索引再保存',409);
    const {needs}=await readNeedsIndex(root);
    await saveProjectedGraph(root,feature,source,current,graph,needs,await mappingRules(root));
    await exportNeeds(root, data.featureId);
    if (await indexConfigured(root)) await refreshIndex(root);
    return traceability(root, data.featureId);
  });
}

async function persist(root, data, feature) {
  const target = path.join(root, feature.requirementFile);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(temp, target);
  await exportNeeds(root, data.featureId);
}

export async function sourceAt(referencePath, line, root = projectRoot) {
  return (await openTraceability(root)).source({path:referencePath,line});
}

export function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== host.origin) return false;
    return true;
  } catch { return false; }
}

export function isLocalWrite(req) {
  return isLocalRequest(req) && (req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json';
}
