import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openTraceability, TraceError } from './traceability.mjs';
import { capabilityEvidence, capabilityGraphContract } from './capabilities.mjs';
import { describeNodeContext } from '../src/node-context.mjs';
import { nodeImportance } from '../src/node-importance.mjs';
import { nodeBackend } from './backend-relations.mjs';
import { nodeProperties } from './needs-projection.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizeNode = node => node ? {...node, importance:nodeImportance(node.importance)} : null;
const semanticGraph = graph => ({...graph, nodes:graph.nodes.map(({position,size,importance,needId,code,test,...node})=>node)});
const uniqueRefs = refs => [...new Map(refs.map(ref=>[`${ref.path}:${ref.line}`,ref])).values()];
const evidenceSummary = report => {
  const {output, ...summary} = report;
  return {...summary, url:`/api/capabilities/evidence?capabilityId=${encodeURIComponent(report.capabilityId)}`};
};

function gapsFor(node, requirements, capability, index, evidence, backend) {
  const gaps = [];
  const add = (code,message) => gaps.push({code,message});
  for (const [field,label] of [['description','职责'],['input','输入'],['output','输出'],['processing','处理规则']]) {
    if (typeof node[field] !== 'string' || !node[field].trim()) add(`contract.${field}`,`补齐节点${label}`);
  }
  if (!node.acceptance?.trim() && !requirements.some(requirement=>requirement.acceptance?.length)) {
    add('contract.acceptance','在节点或关联需求中补齐验收说明');
  }
  if (!requirements.length) add('requirements.missing','关联需求');
  for (const requirement of requirements) {
    if (requirement.status !== 'confirmed') add(`requirement.${requirement.id}.confirmation`,`${requirement.id} 正文待用户确认`);
    if (requirement.acceptance?.length && requirement.acceptanceStatus !== 'confirmed') add(`requirement.${requirement.id}.acceptance-confirmation`,`${requirement.id} 验收条件待用户确认`);
  }
  if (!capability) add('capability.missing',node.capabilityId?`能力 ${node.capabilityId} 尚未登记`:'实现并登记可信能力');
  else {
    if (!backend.functions.length) add('implementation.missing','在实际函数旁引用该节点的规格 ID，并刷新索引');
    if(index.state==='current')for(const fn of backend.functions)if(fn.scopeState!=='current')add(`implementation.${fn.id}.scope`,`${fn.path}#${fn.symbol} 尚未取得唯一的 CodeLinks 函数定位`);
    if (!capability.frontend) add('frontend.missing','接入前端功能操作');
    if (!capability.testFiles?.length) add('tests.missing','登记关联测试');
  }
  for(const requirement of requirements)for(const criterion of requirement.acceptance??[]) {
    const cases=backend.testCases.filter(test=>test.verifies.some(link=>link.requirementId===requirement.id&&link.acceptanceId===criterion.id));
    if(!cases.length)add(`tests.mapping.${requirement.id}.${criterion.id}`,`${requirement.id}.${criterion.id} 尚未找到带 verifies 的测试条目`);
    else if(!cases.some(test=>test.state==='passed'))add(`tests.case.${requirement.id}.${criterion.id}`,`${requirement.id}.${criterion.id} 尚无当前通过的逐用例证据`);
  }
  if (index && !['current','unconfigured'].includes(index.state)) add('index.refresh',`需求索引为 ${index.state}，需更新关联证据`);
  if (evidence && evidence.state !== 'passed') add('tests.evidence',evidence.message || ({'not-run':'关联测试尚未运行',failed:'关联测试失败',stale:'测试证据待复验'}[evidence.state]??'核对测试证据'));
  return gaps;
}

function graphForDescription(context) {
  const nodes = [context.node,...context.incoming.map(item=>item.node),...context.outgoing.map(item=>item.node),...context.children];
  const edges = [...context.incoming.map(item=>item.edge),...context.outgoing.map(item=>item.edge),...context.internalEdges];
  return {nodes:[...new Map(nodes.map(node=>[node.id,node])).values()],edges:[...new Map(edges.map(edge=>[edge.id,edge])).values()]};
}

function formatDocument(context) {
  const {node,requirements,capability,evidence} = context;
  const schema = value => value ? `\n\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\`` : '';
  const source = context.provenance.graph === 'draft' ? '浏览器草稿，尚未保存到项目' : '项目功能图';
  const refs = values => values.map(ref=>`- ${ref.path}:${ref.line}${ref.source?` (${ref.source})`:''}`).join('\n');
  const evidenceLabels = {'not-run':'尚未运行',passed:'测试通过',failed:'测试失败',stale:'待复验'};
  return [
    `# ${node.title}`,
    `节点：${node.id} · 所属：${[...context.ancestors,node].map(item=>item.title).join(' / ')}`,
    `来源：${source}；需求来自项目已保存内容。`,
    `## 功能描述\n${node.description||'待填写'}`,
    `## 输入\n${node.input||'待填写'}${schema(node.inputSchema)}`,
    `## 处理\n${node.processing||'待填写'}`,
    `## 输出\n${node.output||'待填写'}${schema(node.outputSchema)}`,
    `## 异常\n${node.errors?.join('\n')||'未列出'}`,
    `## 节点验收说明\n${node.acceptance?.trim()||(requirements.some(requirement=>requirement.acceptance?.length)?'见关联需求中的验收条件。':'待填写')}`,
    describeNodeContext(graphForDescription(context),node.id),
    `## 关联需求\n${requirements.map(requirement=>[
      `### ${requirement.id} · ${requirement.title}`,
      `状态：${requirement.status==='confirmed'?'正文已确认':'正文待确认'}；验收：${requirement.acceptanceStatus==='confirmed'?'已确认':'待确认'}`,
      requirement.description,
      ...(requirement.acceptance??[]).map(item=>`- ${item.id}：输入 ${item.input}；预期 ${item.expected}${item.observable?'；观察 '+item.observable:''}`)
    ].join('\n')).join('\n\n')||'待关联'}`,
    `## 实现函数\n${context.implementation.map(ref=>`- ${ref.path}#${ref.symbol} · ${ref.startLine??'?'}–${ref.endLine??'?'} · ${ref.scopeState}`).join('\n')||'待实现'}`,
    `## 后端连接\n${context.backend.calls.map(call=>`- 声明调用：${call.callerRef.path}#${call.callerRef.symbol} → ${call.calleeRef.path}#${call.calleeRef.symbol}`).join('\n')||'未发现 calls 声明'}\n节点出入边描述数据流；实际调用记录由已登记执行器提供。${context.backend.trial?'\n试运行适配器：'+context.backend.trial.description+schema(context.backend.trial.inputSchema):''}`,
    `## 验收用例\n${context.backend.testCases.map(test=>`- ${test.id} · ${test.name} · ${test.state}\n  ${test.verifies.map(link=>link.needId+' ['+link.state+']').join(', ')}`).join('\n')||'尚未解析到 verifies 测试条目'}`,
    `## 前端入口\n${context.frontend?`${context.frontend.component} · ${context.frontend.path} · 模式 ${context.frontend.mode??'默认'}`:'前端待接入'}`,
    `## 源码定位\n${refs(context.code)||'待关联'}`,
    `## 相关测试\n${refs(context.tests)||capability?.testFiles?.join('\n')||'待关联'}`,
    `## 实际测试证据\n${evidence?[
      `状态：${evidenceLabels[evidence.state]??evidence.state}`,
      evidence.message,
      evidence.completedAt?`记录时间：${evidence.completedAt}`:null,
      evidence.passed!==undefined?`${evidence.passed} 通过 / ${evidence.failed??0} 失败`:null,
      `证据：${evidence.url}`
    ].filter(Boolean).join('\n'):'能力尚未登记'}`,
    `## 追踪上下文\n项目：${context.feature.id}\n需求源：${context.source}\n索引：${context.index?.source??'未读取'} / ${context.index?.state??'未读取'}\nRST：${context.sphinx?.state??'未读取'}\nubCode：${context.ubcode?.message??context.ubcode?.state??'未读取'}`,
    `## 待补齐\n${context.gaps.map(gap=>`- ${gap.message}`).join('\n')||'当前契约、绑定与证据未发现待补项。'}`
  ].join('\n\n');
}

// Read-only snapshots for the workbench, document export and the current Agent.
export async function nodeContext({featureId,nodeId,graph:preview} = {}, root = projectRoot) {
  if (typeof nodeId !== 'string' || !nodeId) throw new TraceError('缺少节点 ID');
  const project=await openTraceability(root);
  const saved=await project.feature(featureId);
  const view=preview===undefined?saved:await project.feature(featureId,{graph:preview});
  const graph=view.projectGraph;
  const nodes = new Map(graph.nodes.map(node=>[node.id,normalizeNode(node)]));
  const node = nodes.get(nodeId);
  if (!node) throw new TraceError(`未找到节点：${nodeId}`,404);
  const ancestors = [];
  for (let parent = nodes.get(node.parentId); parent; parent = nodes.get(parent.parentId)) ancestors.unshift(parent);
  const incoming = graph.edges.filter(edge=>edge.target===nodeId).map(edge=>({edge,node:nodes.get(edge.source)}));
  const outgoing = graph.edges.filter(edge=>edge.source===nodeId).map(edge=>({edge,node:nodes.get(edge.target)}));
  const children = [...nodes.values()].filter(item=>item.parentId===nodeId);
  const childIds = new Set(children.map(item=>item.id));
  const requirements = saved.requirements.filter(requirement=>(requirement.nodeIds??[requirement.nodeId]).includes(nodeId));
  const capabilities=project.capabilities();
  const capability = (node.capabilityId ? capabilities.find(item=>item.id===node.capabilityId) : capabilities.find(item=>item.nodeIds.includes(nodeId))) ?? null;
  const draft = !isDeepStrictEqual(graph,saved.projectGraph);
  const semanticChanges = draft && !isDeepStrictEqual(semanticGraph(graph),semanticGraph(saved.projectGraph));
  const evidenceContractChanges = Boolean(capability) && draft && !isDeepStrictEqual(
    capabilityGraphContract(graph,capability),capabilityGraphContract(saved.projectGraph,capability));
  const savedEvidence = capability ? evidenceSummary(await capabilityEvidence(capability.id,root,project)) : null;
  const evidence = savedEvidence && evidenceContractChanges ? {...savedEvidence,
    state:savedEvidence.state==='not-run'?'not-run':'stale',
    cases:savedEvidence.cases?.map(test=>test.state==='not-run'?test:{...test,observedState:test.observedState??test.state,state:'stale'}),
    coversCurrentGraph:false,
    message:'当前草稿中该能力的行为契约已变化；项目测试记录尚未覆盖这份草稿。'
  } : savedEvidence ? {...savedEvidence,coversCurrentGraph:savedEvidence.state==='passed'} : null;
  const backend=nodeBackend(view.backend,nodeId,evidence);
  const context = {
    feature:graph.feature,node,properties:nodeProperties(node),parent:ancestors.at(-1)??null,ancestors,incoming,outgoing,children,
    internalEdges:graph.edges.filter(edge=>childIds.has(edge.source)&&childIds.has(edge.target)),
    requirements,capability,implementation:backend.functions,relatedImplementation:backend.relatedFunctions,backend,frontend:capability?.frontend??null,
    code:uniqueRefs(requirements.flatMap(requirement=>requirement.code??[])),
    tests:uniqueRefs(requirements.flatMap(requirement=>requirement.tests??[])),
    provenance:{graph:draft?'draft':'saved',requirements:'saved',semanticChanges,evidenceContractChanges},
    source:saved.source,index:saved.index,sphinx:saved.sphinx,ubcode:saved.ubcode,
    evidence,savedEvidence,
    gaps:gapsFor(node,requirements,capability,saved.index,evidence,backend)
  };
  const markdown = formatDocument(context);
  const taskMarkdown = [
    `# Codex 开发任务：${node.title}`,
    '围绕节点契约开展本次获准的工作。实现按职责划分，保留既有调用；需要确认的需求交由用户决定。',
    markdown,
    '## 使用此快照\n开始前读取项目当前节点上下文，核对快照之后的变化。草稿先通过框架保存；实施、运行测试和前端验证遵循本次任务授权。'
  ].join('\n\n');
  return {context,markdown,taskMarkdown};
}
