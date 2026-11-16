import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { featureRegistry } from './feature-registry.mjs';
import { openTraceability } from './traceability.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reviewed project declarations; diagrams cannot register executable commands.
const registry = featureRegistry.capabilities;
export function listCapabilities() { return structuredClone(registry).map(cap=>({...cap,implementation:[],requirementIds:[]})); }
export async function indexedCapabilities(root=projectRoot) {
  return (await openTraceability(root)).capabilities();
}
function capability(id) {
  const found = registry.find(item => item.id === id);
  if (!found) throw new Error('未知的功能能力');
  return found;
}

// Saved evidence and draft previews inspect the same capability-owned contract.
export function capabilityGraphContract(graph, cap) {
  const nodes=graph.nodes.filter(node=>cap.nodeIds?.includes(node.id)||node.capabilityId===cap.id)
    .map(({position,size,importance,needId,code,test,...node})=>node);
  const ids=new Set(nodes.map(node=>node.id));
  return {nodes,edges:graph.edges?.filter(edge=>ids.has(edge.source)||ids.has(edge.target))};
}

async function filesUnder(root, dir) {
  let entries;
  try { entries = await fs.readdir(path.join(root,dir), {withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== '_build' && entry.name !== 'target') files.push(...await filesUnder(root,relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

// Metadata tracks the actual candidate without storing source code or hashing files.
async function candidate(root, cap, project) {
  project??=await openTraceability(root);
  const binding=project.capabilities().find(item=>item.id===cap.id);
  const relevant = new Set([...cap.testFiles,'server/api.mjs','server/capabilities.mjs','scripts/test-case-reporter.mjs',
    ...await filesUnder(root,'src'), ...await filesUnder(root,'features'), ...binding.implementation.map(ref=>ref.path),
    ...await filesUnder(root,'server')]);
  const files = [];
  for (const file of [...relevant].sort()) {
    try { const stat=await fs.stat(path.join(root,file)); files.push({path:file,size:stat.size,mtimeMs:stat.mtimeMs}); }
    catch (error) { if (error.code!=='ENOENT') throw error; files.push({path:file,missing:true}); }
  }
  const contracts = [];
  const data=[];
  for (const file of (await filesUnder(root,'contracts')).filter(file=>file.endsWith('.json')).sort()) {
    const value=JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
    data.push({file,value});
    if (Array.isArray(value.nodes)) {
      const contract=capabilityGraphContract(value,cap);
      if (contract.nodes.length) contracts.push({file,...contract});
    }
  }
  const nodeIds=new Set([...(cap.nodeIds??[]),...contracts.flatMap(contract=>contract.nodes?.map(node=>node.id)??[])]);
  const requirementIds=new Set(binding.requirementIds);
  for(const {file,value} of data)for(const req of value.requirements??[]) {
    if(requirementIds.has(req.id)||(req.nodeIds??[req.nodeId]).some(id=>nodeIds.has(id))) {
      requirementIds.add(req.id);
      contracts.push({file,id:req.id,title:req.title,description:req.description,nodeIds:req.nodeIds??[req.nodeId],acceptance:req.acceptance??[]});
    }
  }
  return {files,contracts,...project.capabilityContract(cap.id),
    testCases:binding.testCases.map(({id,file,files,name,verifies})=>({id,file,files,name,verifies})),
    indexReady:['current','unconfigured'].includes(project.index.state)};
}
const reportPath = (root,id) => path.join(root,'traceability','_build','test-results',`${id}.json`);
function publicReport(report) { const {candidate: _candidate,...result}=report; return result; }
function caseResults(declarations, cap, root, events=[]) {
  return declarations.map(declaration=>{
    const trusted=declaration.file&&cap.testFiles.some(file=>path.resolve(root,file)===path.resolve(root,declaration.file));
    const matches=trusted?events.filter(event=>event.id===declaration.id && event.file &&
      path.resolve(root,event.file)===path.resolve(root,declaration.file))
      :[];
    const {id:_id,name:_name,file:_file,...outcome}=matches.length===1 ? matches[0] : {
      state:'not-run',message:declaration.sourceState==='ambiguous'?'测试 ID 对应多个源码文件，无法唯一关联结果':
        !declaration.file?'测试条目尚无 CodeLinks 源码定位':!trusted?'测试源码未列入该能力的可信测试文件':
        matches.length ? '同文件存在重复测试 ID，无法唯一关联结果' : '本次运行未匹配到该测试 ID',
    };
    return {...structuredClone(declaration),...outcome};
  });
}
function staleCases(cases) {
  return cases.map(item=>item.state==='not-run' || item.state==='stale' ? item :
    {...item,state:'stale',observedState:item.state});
}
// Completeness concerns indexed test declarations only, not every requirement
// or code branch. TAP's aggregate result remains a separate execution outcome.
function caseCoverage(cases,index) {
  const counts={declared:cases.length,passed:0,failed:0,skipped:0,notRun:0,stale:0,unlinked:0};
  for(const item of cases) {
    counts[item.state==='not-run'?'notRun':item.state]++;
    if(!item.verifies.length||item.verifies.some(link=>link.state!=='linked'))counts.unlinked++;
  }
  const state=index.state!=='current'?'unindexed':!cases.length?'empty':counts.stale?'stale':
    counts.notRun||counts.skipped||counts.unlinked?'incomplete':'complete';
  return {state,...counts};
}
function coverageMessage(coverage) {
  if(coverage.state==='unindexed')return '需求索引尚未就绪；固定测试的执行结果不能作为当前需求的逐用例证据';
  if(coverage.state==='empty')return '固定测试已执行；当前索引没有关联测试条目';
  if(coverage.state==='incomplete')return `关联用例证据尚不完整：${coverage.notRun} 项未匹配，${coverage.skipped} 项跳过，${coverage.unlinked} 项缺少有效需求关联`;
}
function currentCases(declarations,cap,root,previous) {
  return caseResults(declarations,cap,root).map(item=>{
    const observed=previous.find(result=>result.id===item.id&&result.file===item.file);
    if(!observed)return item;
    const {state,observedState,line,durationMs,message}=observed;
    return {...item,state,observedState,line,durationMs,message};
  });
}
export async function capabilityEvidence(id, root=projectRoot, project) {
  const cap=capability(id);
  project??=await openTraceability(root);
  const declarations=project.capabilities().find(item=>item.id===id).testCases;
  const caseIndex={state:project.index.state,source:project.index.source};
  let report;
  try { report=JSON.parse(await fs.readFile(reportPath(root,id),'utf8')); }
  catch (error) {
    if (error.code==='ENOENT') {
      const cases=caseResults(declarations,cap,root);
      return {capabilityId:id,state:'not-run',cases,caseIndex,caseCoverage:caseCoverage(cases,caseIndex),message:'尚未运行关联测试'};
    }
    throw error;
  }
  report.cases??=caseResults(declarations,cap,root);
  const unindexed=!['current','unconfigured'].includes(project.index.state);
  if (unindexed || !isDeepStrictEqual(report.candidate,await candidate(root,cap,project))) {
    const cases=staleCases(currentCases(declarations,cap,root,report.cases));
    return {...publicReport(report),state:'stale',cases,caseIndex,caseCoverage:caseCoverage(cases,caseIndex),message:'相关代码、行为契约或需求索引已变化，请重建索引后重新运行测试'};
  }
  return {...publicReport(report),caseIndex,caseCoverage:caseCoverage(report.cases,caseIndex)};
}

function executeTests(root, testFiles, eventFile) {
  return new Promise(resolve=>{
    const args=['--test','--test-reporter=tap',
      ...(eventFile ? [`--test-reporter=${new URL('../scripts/test-case-reporter.mjs',import.meta.url).href}`,
        '--test-reporter-destination=stdout',`--test-reporter-destination=${eventFile}`] : []),...testFiles];
    const env={...process.env};
    // A caller may itself be a node:test process; this is a separate test run.
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,args,{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',message='';
    const append=chunk=>{if(output.length<200_000)output+=chunk.toString().slice(0,200_000-output.length);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const timeout=setTimeout(()=>{message='测试执行超过 60 秒，已停止本次进程';child.kill();},60_000);
    child.once('error',error=>{clearTimeout(timeout);resolve({exitCode:null,output,message:error.message,args});});
    child.once('close',exitCode=>{clearTimeout(timeout);resolve({exitCode,output,message,args});});
  });
}
const active = new Map();
export async function runCapabilityTests(id, root=projectRoot) {
  const cap=capability(id);
  if(!Array.isArray(cap.testFiles)||!cap.testFiles.length)throw new Error('该能力尚未登记可信测试文件');
  const key=`${root}:${id}`;
  if(active.has(key)) return active.get(key);
  const job=(async()=>{
    const project=await openTraceability(root);
    const declarations=project.capabilities().find(item=>item.id===id).testCases;
    const before=await candidate(root,cap,project);
    const startedAt=new Date().toISOString(), start=performance.now();
    const file=reportPath(root,id);
    await fs.mkdir(path.dirname(file),{recursive:true});
    const eventFile=file.replace(/\.json$/,'.events.jsonl');
    if (eventFile) await fs.writeFile(eventFile,'');
    const result=await executeTests(root,cap.testFiles,eventFile);
    let events=[];
    if (eventFile) {
      try { events=(await fs.readFile(eventFile,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); }
      catch (error) { result.message=[result.message,`逐用例报告读取失败：${error.message}`].filter(Boolean).join('；'); }
    }
    const changed=!isDeepStrictEqual(before,await candidate(root,cap));
    const unindexed=!['current','unconfigured'].includes(project.index.state);
    const passed=Number(result.output.match(/^# pass (\d+)\s*$/m)?.[1]??0);
    const failed=Number(result.output.match(/^# fail (\d+)\s*$/m)?.[1]??0);
    const observed=caseResults(declarations,cap,root,events);
    const cases=changed||unindexed?staleCases(observed):observed;
    const caseIndex={state:project.index.state,source:project.index.source};
    const coverage=caseCoverage(cases,caseIndex);
    const executionState=result.exitCode===0&&passed>0&&failed===0?'passed':'failed';
    const report={capabilityId:id,state:changed||unindexed?'stale':executionState,executionState,
      cases,caseIndex,caseCoverage:coverage,
      passed,failed,exitCode:result.exitCode,startedAt,completedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start),
      command:['node',...result.args],output:result.output,candidate:before,
      message:[result.message,changed?'运行期间相关代码或契约发生变化，请重新测试':coverageMessage(coverage)].filter(Boolean).join('；')||undefined};
    await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');
    return publicReport(report);
  })();
  active.set(key,job);
  try { return await job; } finally { active.delete(key); }
}
