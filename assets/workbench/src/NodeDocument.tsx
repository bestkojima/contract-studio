import { useEffect, useState } from 'react';
import type { Graph } from './workbench-types';

type DocumentResponse={context:{provenance:{graph:'saved'|'draft';requirements:'saved'}};markdown:string;taskMarkdown:string};
export function NodeDocument({featureId,graph,nodeId,dirty,sourceVersion}:{featureId:string;graph:Graph;nodeId:string;dirty:boolean;sourceVersion:unknown}) {
  const [state,setState]=useState<{key:string;response?:DocumentResponse;error?:string}>({key:''});
  const key=JSON.stringify([featureId,nodeId,dirty,graph,sourceVersion]);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    const timer=setTimeout(()=>{
      const url=dirty?'/api/node-context/preview':`/api/node-context?feature=${encodeURIComponent(featureId)}&nodeId=${encodeURIComponent(nodeId)}`;
      void fetch(url,{signal:controller.signal,...(dirty?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({featureId,graph,nodeId})}:{})})
        .then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error??`HTTP ${response.status}`);return value as DocumentResponse})
        .then(response=>{if(active)setState({key,response})})
        .catch(reason=>{if(active)setState({key,error:String(reason)})});
    },120);
    return()=>{active=false;clearTimeout(timer);controller.abort()};
  },[key,retry]);
  const current=state.key===key?state:undefined;
  const download=(task=false)=>{
    if(!current?.response)return;
    const url=URL.createObjectURL(new Blob([task?current.response.taskMarkdown:current.response.markdown],{type:'text/markdown;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=`${nodeId}${task?'.codex-task':''}.md`;link.click();URL.revokeObjectURL(url);
  };
  return <div className="inspector-body"><p className="micro">{dirty?'当前画布草稿预览 · 需求来自已保存项目':'项目节点上下文'} · 文档与开发任务共享同一份上下文。</p>
    <div className="document-actions"><button className="primary-button" disabled={!current?.response} onClick={()=>download()}>导出节点说明</button><button className="primary-button secondary" disabled={!current?.response} onClick={()=>download(true)}>导出 Codex 开发任务</button></div>
    {current?.error?<div className="notice notice-error" role="alert">上下文读取失败：{current.error} <button className="link-button" onClick={()=>setRetry(value=>value+1)}>重试</button></div>:current?.response?<pre className="node-document">{current.response.markdown}</pre>:<div className="empty" role="status">正在生成当前节点上下文…</div>}
  </div>;
}
