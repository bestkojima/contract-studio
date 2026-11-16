import { buildTraceabilityIndex } from '../server/traceability.mjs';

const featureId=process.argv[2];
const result=await buildTraceabilityIndex(undefined,featureId);
const {sourceRevision,...index}=result.index;
console.log(JSON.stringify({featureId:result.featureId,index,indexedSourceFiles:Object.keys(sourceRevision??{}).length,requirements:result.requirements.length,relations:result.relations.length},null,2));
if(result.index.state!=='current')process.exitCode=1;
