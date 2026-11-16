import { featureRegistry } from './feature-registry.mjs';
import { indexedTestCases } from './indexed-tests.mjs';

const hex=value=>Buffer.from(value,'utf8').toString('hex').toUpperCase();
export const functionNeedId=ref=>`IMPL_${hex(`${ref.path}#${ref.symbol}`)}`;
export const nodeNeedId=(nodeId,feature={})=>`FUNC_${feature.specPrefix??''}${hex(nodeId)}`;
// Existing acceptance IDs may contain dots; encode only IDs that cannot be need parts.
export const acceptancePartId=id=>id.includes('.')||id.startsWith('PART_')?`PART_${hex(id)}`:id;
export const acceptanceNeedId=(requirementId,id)=>`${requirementId}.${acceptancePartId(id)}`;
const unique=values=>[...new Set(values)];
const propertiesOf=need=>typeof need.node_properties==='string'?JSON.parse(need.node_properties||'{}'):need.node_properties??{};

export function entitySpecIds(entity,needs) {
  return unique((entity.needIds??[]).flatMap(id=>needs[id]?.type==='spec'?[id]:needs[id]?.type==='impl'?(needs[id].implements??[]):[]));
}

function indexedFunctions(entities,needs,specIds) {
  const found=new Map();
  for(const entity of entities) {
    if(!entity.symbol)continue;
    const linked=entitySpecIds(entity,needs).filter(id=>specIds.has(id));
    if(!linked.length)continue;
    const id=functionNeedId(entity), previous=found.get(id);
    const ambiguous=previous&&(previous.scopeState==='ambiguous'||previous.startLine!==entity.startLine||previous.endLine!==entity.endLine);
    found.set(id,{...entity,id,scopeState:ambiguous?'ambiguous':entity.indexState,
      needIds:unique([...(previous?.needIds??[]),...(entity.needIds??[])]),
      specIds:unique([...(previous?.specIds??[]),...linked]),
      markerLines:unique([...(previous?.markerLines??[]),...(entity.markerLines??[])]),
      requirementIds:unique(linked.flatMap(specId=>needs[specId].fulfills??[]).concat(previous?.requirementIds??[]))});
  }
  return [...found.values()];
}

// Public capability metadata is a projection of the index; the registry only permits execution.
export function indexedCapabilityBindings(cap,needs,entities) {
  const specs=Object.values(needs).filter(need=>need.type==='spec'&&(
    propertiesOf(need).capabilityId===cap.id || (cap.nodeIds??[]).includes(need.node_id||need.id)));
  const specIds=new Set(specs.map(need=>need.id));
  const implementation=indexedFunctions(entities,needs,specIds);
  const requirementIds=unique(specs.flatMap(need=>need.fulfills??[]));
  const testCases=indexedTestCases(needs,entities).filter(test=>
    test.files.some(file=>(cap.testFiles??[]).includes(file)) || test.verifies.some(link=>requirementIds.includes(link.requirementId)));
  return {implementation,requirementIds,testCases,nodeIds:unique([...(cap.nodeIds??[]),...specs.map(need=>need.node_id||need.id)])};
}

// Semantic edges come exclusively from Needs items and CodeLinks source markers.
export function backendRelations(graph,requirements,{feature={},needs={},entities=[],registry=featureRegistry}={}) {
  const nodes=graph.nodes.map(node=>{
    const specId=node.needId??(needs[node.id]?.type==='spec'?node.id:nodeNeedId(node.id,feature));
    const capability=(node.capabilityId?registry.capabilities.find(cap=>cap.id===node.capabilityId):registry.capabilities.find(cap=>cap.nodeIds?.includes(node.id)))??null;
    return {nodeId:node.id,specId,capabilityId:capability?.id??null,
      requirementIds:needs[specId]?.fulfills??[],functionIds:[],input:node.input,output:node.output,
      inputSchema:node.inputSchema??null,outputSchema:node.outputSchema??null,
      trial:registry.trials.find(item=>item.capabilityId===capability?.id)??null};
  });
  const functions=indexedFunctions(entities,needs,new Set(nodes.map(node=>node.specId)));
  for(const fn of functions)fn.nodeIds=nodes.filter(node=>fn.specIds.includes(node.specId)).map(node=>node.nodeId);
  for(const node of nodes)node.functionIds=functions.filter(fn=>fn.specIds.includes(node.specId)).map(fn=>fn.id);
  // Optional design-level calls belong to impl Needs. Runtime calls remain execution evidence.
  const calls=[];
  const byNeed=new Map();
  for(const fn of functions)for(const id of fn.needIds)if(needs[id]?.type==='impl')byNeed.set(id,fn.id);
  for(const [id,caller] of byNeed)for(const target of needs[id].calls??[]) {
    const callee=byNeed.get(target);
    if(callee&&!calls.some(call=>call.caller===caller&&call.callee===callee))calls.push({caller,callee,source:'needs-declaration'});
  }
  const requirementIds=new Set(requirements.map(requirement=>requirement.id));
  const testCases=indexedTestCases(needs,entities).filter(test=>test.verifies.some(link=>requirementIds.has(link.requirementId))).map(test=>{
    const relatedNodes=nodes.filter(node=>test.verifies.some(link=>node.requirementIds.includes(link.requirementId)));
    const capabilityIds=unique(relatedNodes.map(node=>node.capabilityId).filter(Boolean));
    return {...test,capabilityId:capabilityIds.length===1?capabilityIds[0]:null,capabilityIds,
      relatedFunctionIds:functions.filter(fn=>test.verifies.some(link=>fn.requirementIds.includes(link.requirementId))).map(fn=>fn.id),
      relationSource:'requirement-binding'};
  });
  return {nodes,functions,calls,
    flows:graph.edges.map(edge=>({...edge,sourceKind:'contract-data-flow'})),testCases,
    requirements:requirements.map(r=>({id:r.id,nodeIds:nodes.filter(node=>node.requirementIds.includes(r.id)).map(node=>node.nodeId),
      functionIds:functions.filter(fn=>fn.requirementIds.includes(r.id)).map(fn=>fn.id),
      acceptance:(r.acceptance??[]).map(ac=>({...ac,needId:acceptanceNeedId(r.id,ac.id),
        testCaseIds:testCases.filter(test=>test.verifies.some(link=>link.requirementId===r.id&&link.acceptanceId===ac.id)).map(test=>test.id)}))}))};
}

export function nodeBackend(relations,nodeId,evidence) {
  const node=relations.nodes.find(item=>item.nodeId===nodeId);
  const ids=new Set(node?.functionIds??[]);
  const requirements=new Set(node?.requirementIds??[]);
  const capabilityNodes=relations.nodes.filter(item=>node?.capabilityId&&item.capabilityId===node.capabilityId);
  const relatedIds=new Set(capabilityNodes.flatMap(item=>item.functionIds));
  return {...node,
    functions:relations.functions.filter(fn=>ids.has(fn.id)),
    relatedFunctions:relations.functions.filter(fn=>relatedIds.has(fn.id)&&!ids.has(fn.id)),
    calls:relations.calls.filter(call=>ids.has(call.caller)||ids.has(call.callee)).map(call=>{
      const ref=id=>{const fn=relations.functions.find(item=>item.id===id);return {path:fn.path,symbol:fn.symbol};};
      return {...call,callerRef:ref(call.caller),calleeRef:ref(call.callee)};
    }),
    flows:relations.flows.filter(flow=>flow.source===nodeId||flow.target===nodeId),
    testCases:relations.testCases.filter(test=>test.verifies.some(link=>requirements.has(link.requirementId))).map(test=>({
      ...test,state:'not-run',...(evidence?.cases??[]).find(result=>result.id===test.id),
      verifies:test.verifies,relatedFunctionIds:test.relatedFunctionIds,relationSource:test.relationSource
    }))};
}
