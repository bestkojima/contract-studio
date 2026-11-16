import { useEffect, useState } from 'react';

export type Capability = {
  id:string;title:string;nodeIds:string[];rootNodeId:string;runPath:string;testPath:string;
  frontend?:{entry:string;feature:string;component:string;path:string;mode?:string};implementation:{path:string;symbol:string}[];
  testFiles:string[];requirementIds:string[];
};
export type TestEvidence = {capabilityId:string;state:'not-run'|'passed'|'failed'|'stale';passed?:number;failed?:number;durationMs?:number;startedAt?:string;completedAt?:string;exitCode?:number;output?:string;command?:string[];message?:string};
async function evidenceRequest(path:string,body?:unknown):Promise<TestEvidence>{
  const response=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error??`HTTP ${response.status}`);return data;
}
export function CapabilityPanel({capability,onOpen}:{capability?:Capability;onOpen:(capability:Capability)=>void}){
  const [evidence,setEvidence]=useState<TestEvidence|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const id=capability?.id;
  useEffect(()=>{
    let live=true;setEvidence(null);setError('');setBusy(false);
    if(id)void evidenceRequest(`/api/capabilities/evidence?capabilityId=${encodeURIComponent(id)}`).then(value=>{if(live)setEvidence(value)}).catch(reason=>{if(live)setError(String(reason))});
    return()=>{live=false};
  },[id]);
  if(!capability)return <div className="capability-pending"><strong>待实现</strong><p>在节点属性中完善契约，导出开发任务交给 Codex。接入实际能力后，即可试运行。</p></div>;
  const runTests=async()=>{
    setBusy(true);setError('');
    try{setEvidence(await evidenceRequest('/api/capabilities/test',{capabilityId:capability.id}))}catch(reason){setError(String(reason))}finally{setBusy(false)}
  };
  const labels={ 'not-run':'尚未运行',passed:'测试通过',failed:'测试失败',stale:'代码已变化 · 待复验' };
  return <div className="capability-panel">
    <div className="capability-heading"><div><span className="eyebrow">前后端对应</span><h3>{capability.title}</h3></div><code>{capability.id}</code></div>
    <dl className="capability-map">
      <div><dt>后端入口</dt><dd><code>{capability.runPath}</code></dd></div>
      <div><dt>实现函数</dt><dd>{capability.implementation.map(ref=><span key={`${ref.path}:${ref.symbol}`}><b>{ref.symbol}</b><code>{ref.path}</code></span>)}</dd></div>
      <div><dt>前端入口</dt><dd>{capability.frontend?<><span>{capability.frontend.component}</span><button className="link-button" onClick={()=>onOpen(capability)}>前往功能 ↓</button></>:<strong className="field-error">前端待接入</strong>}</dd></div>
      <div><dt>关联测试</dt><dd>{capability.testFiles.length?capability.testFiles.map(file=><code key={file}>{file}</code>):<span>测试待接入</span>}</dd></div>
    </dl>
    <div className="test-evidence">
      <div className="test-evidence-heading"><strong>实际测试证据</strong><span className={`evidence-status ${evidence?.state??'not-run'}`}>{evidence?labels[evidence.state]:'正在读取'}</span></div>
      {evidence?.completedAt&&<p className="micro">{new Date(evidence.completedAt).toLocaleString()} · {evidence.passed??0} 通过 / {evidence.failed??0} 失败{evidence.durationMs!==undefined?` · ${evidence.durationMs} ms`:''}</p>}
      {evidence?.message&&<p className="micro">{evidence.message}</p>}
      <button className="primary-button" disabled={busy||!capability.testFiles.length} onClick={()=>void runTests()}>{busy?'正在运行测试…':'运行关联测试'}</button>
      {error&&<div className="notice notice-error" role="alert">{error}</div>}
      {evidence?.output&&<details className="test-output"><summary>查看测试报告</summary><pre>{evidence.command?.join(' ')}{'\n\n'}{evidence.output}</pre></details>}
    </div>
  </div>;
}
