import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, MarkerType, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type Node as FlowNode, type NodeProps, type Edge, type Connection,
  type NodeChange, type EdgeChange, type EdgeProps, useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, ApiError } from './api';
import type { Kind, Spec, Graph, Step, Run } from './workbench-types';
import { featureClients, type FeatureDefinition, type FeatureCatalog, type FeatureClient, type OpenFeatureRequest } from './feature-client';
import { graphFocus } from './graph-focus.mjs';
import { sameValue, sameGraph, reconcileGraphSave } from './graph-state.mjs';
import { NodeDocument } from './NodeDocument';
import { resolveFeature, visibleFeatures, capabilityDestination } from './feature-navigation.mjs';
import { NodeProperties } from './NodeProperties';
import { CapabilityPanel, type Capability } from './CapabilityPanel';
import { importanceLabels, importanceLabel, nodeImportance } from './node-importance.mjs';

type TraceRef={path:string;line:number;source?:'sphinx-codelinks'|'local-marker'};
type Acceptance={id:string;input:string;expected:string;observable?:string};
type Requirement={id:string;nodeId:string;nodeIds?:string[];title:string;description:string;status:'draft'|'confirmed';revision:number;code:TraceRef[];tests:TraceRef[];acceptance?:Acceptance[];acceptanceStatus?:'draft'|'confirmed'};
type RequirementDraft={title:string;description:string;acceptance?:Acceptance[]};
type Traceability={featureId:string;source:string;projectGraph:Graph;requirements:Requirement[];sphinx:{path:string;state:'current'|'outdated'|'missing'};index?:{state:'current'|'stale'|'failed'|'missing'|'unconfigured';source:string;path:string;builtAt?:string;error?:string;sourceRevision?:unknown};ubcode?:{state:string;message:string}};
type DisplayNode=FlowNode<{spec:Spec;collapsed:boolean;hasChildren:boolean;run?:Step['status'];derived?:boolean;requirement?:Requirement;hasUnsavedRequirement:boolean;traceAvailable:boolean;toggle:(id:string)=>void;addChild:(id:string)=>void;annotation?:string},'contract'>;
const workspaceKey='contract-studio-active-workspace-v1';
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const toGraph=(text:string):Graph=>{
  const g:unknown=JSON.parse(text);
  if(!g||typeof g!=='object'||!('nodes' in g)||!('edges' in g))throw Error('不是功能图 JSON');
  const graph=g as Graph;
  if(!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))throw Error('nodes / edges 必须是数组');
  if(new Set(graph.nodes.map(n=>n.id)).size!==graph.nodes.length)throw Error('节点 ID 重复');
  for(const n of graph.nodes){if(!n.id||!n.position||!n.title)throw Error('节点缺少 id/position/title');nodeImportance(n.importance);}
  for(const e of graph.edges){if(!graph.nodes.some(n=>n.id===e.source)||!graph.nodes.some(n=>n.id===e.target))throw Error(`连线 ${e.id} 引用了不存在的节点`)}
  return graph;
};
const labelFor=(kind:Kind)=>({group:'功能组',ui:'页面',logic:'处理',async:'异步',action:'写入'}[kind]);
function NodeCard({data}:NodeProps<DisplayNode>){
  const {spec,hasChildren,collapsed,run,derived,requirement,hasUnsavedRequirement,traceAvailable,toggle,addChild,annotation}=data;
  const runLabel=run==='mock'?'○ Mock':derived?run==='ok'?'✓ 运行汇总':'! 失败汇总':run==='ok'?'✓ 已执行':run==='rejected'?'! 已拒绝':'';
  const requirementLabel=requirement?(hasUnsavedRequirement?'需求未保存':requirement.status==='confirmed'?'需求已确认':'需求待确认'):(traceAvailable?'需求未关联':'');
  const isNestedGroup=spec.parentId!==null;
  const importance=nodeImportance(spec.importance);
  const badge=<span className={`importance-badge importance-${importance}`} title={`${labelFor(spec.kind)} · ${importanceLabel(importance)}`}>{importanceLabel(importance)}</span>;
  if(spec.kind==='group' && hasChildren && !collapsed){
    return <div className={`group-heading importance-${importance} ${isNestedGroup?'nested-group-heading':''}`}>
      {isNestedGroup&&<Handle id="in" type="target" position={Position.Left} className="flow-handle"/>}
      <span className="group-identity"><span className="group-name">{spec.title}</span>{badge}{requirementLabel&&<span className={`group-requirement ${!hasUnsavedRequirement&&requirement?.status==='confirmed'?'confirmed':''}`}>{requirementLabel}</span>}{isNestedGroup&&run&&<span className={`group-run ${run}`}>{runLabel}</span>}</span>
      <span className="node-actions"><button className="node-add nodrag" aria-label={`在${spec.title}中添加节点`} onClick={e=>{e.stopPropagation();addChild(spec.id)}}>＋ 添加</button><button className="node-toggle nodrag" aria-expanded="true" onClick={(e)=>{e.stopPropagation();toggle(spec.id)}}>折叠 −</button></span>
      {isNestedGroup&&<><Handle id="ok" type="source" position={Position.Right} style={{top:'36%'}} className="flow-handle"/><Handle id="fail" type="source" position={Position.Right} style={{top:'76%',background:'#c27d56'}} className="flow-handle"/></>}
    </div>;
  }
  return <div className={`node-card node-${spec.kind} importance-${importance} ${run==='rejected'?'node-failed':''} ${run==='ok'?'node-passed':''}`}>
    <Handle id="in" type="target" position={Position.Left} className="flow-handle"/>
    <div className="node-kicker">{badge}<span>{runLabel}</span></div>
    <div className="node-name">{spec.title}</div>{requirementLabel&&<div className={`node-requirement ${!hasUnsavedRequirement&&requirement?.status==='confirmed'?'confirmed':''}`}>{requirementLabel}</div>}{annotation&&<div className="node-runtime">{annotation}</div>}
    {hasChildren&&<button className="node-toggle nodrag" aria-expanded="false" onClick={(e)=>{e.stopPropagation();toggle(spec.id)}}>展开子节点 +</button>}
    {spec.kind==='group'&&<button className="node-add nodrag" aria-label={`在${spec.title}中添加节点`} onClick={e=>{e.stopPropagation();addChild(spec.id)}}>＋ 添加</button>}
    <Handle id="ok" type="source" position={Position.Right} style={{top:'36%'}} className="flow-handle"/>
    <Handle id="fail" type="source" position={Position.Right} style={{top:'76%',background:'#c27d56'}} className="flow-handle"/>
  </div>;
}
const nodeTypes={contract:NodeCard};

function BranchEdge({id,sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition,label,style,markerEnd}:EdgeProps){
  const [path,labelX,labelY]=getSmoothStepPath({sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition});
  // Horizontal neighbours have little space between cards: place their labels above both cards.
  const captionY=Math.abs(sourceY-targetY)<25?Math.min(sourceY,targetY)-60:labelY;
  return <><BaseEdge id={id} path={path} style={style} markerEnd={markerEnd}/>{label&&<EdgeLabelRenderer><div className="branch-label" style={{transform:`translate(-50%, -50%) translate(${labelX}px, ${captionY}px)`}}>{label}</div></EdgeLabelRenderer>}</>;
}
const edgeTypes={branch:BranchEdge};

function Fit({value,focusId}:{value:number;focusId:string|null}){
  const flow=useReactFlow();
  useEffect(()=>{const t=setTimeout(()=>void flow.fitView({padding:focusId ? .08 : .06,maxZoom:focusId ? 1.05 : undefined,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180}),50);return()=>clearTimeout(t)},[flow,value,focusId]);
  return null;
}

function CreateRequirement({node,onCreate}:{node:Spec;onCreate:(nodeId:string,id:string,title:string,description:string)=>Promise<void>}){
  const [id,setId]=useState('');
  const [title,setTitle]=useState(node.title);
  const [description,setDescription]=useState(node.description);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const create=async()=>{
    setBusy(true);setError('');
    try{await onCreate(node.id,id,title,description)}catch(e){setError(String(e))}finally{setBusy(false)}
  };
  return <div className="requirements-body">
    <div className="requirement-empty"><strong>此节点尚无需求</strong><p>为它创建一条草稿，确认前保留修改空间。</p></div>
    <div className="field"><label htmlFor="new-req-id">需求 ID</label><input id="new-req-id" value={id} onChange={e=>setId(e.target.value)} placeholder="例如 REQ_NEW_FEATURE"/></div>
    <div className="field"><label htmlFor="new-req-title">需求标题</label><input id="new-req-title" value={title} onChange={e=>setTitle(e.target.value)}/></div>
    <div className="field"><label htmlFor="new-req-description">需求描述</label><textarea id="new-req-description" rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></div>
    <button className="primary-button" onClick={()=>void create()} disabled={busy||!id.trim()||!title.trim()||!description.trim()}>{busy?'创建中…':'创建并关联草稿'}</button>
    <p className="micro">项目需求会保存到文件；画布草稿需点击“保存到项目”，也可导出 JSON。创建需求不会自动实现或测试功能。</p>
    {error&&<div className="notice notice-error" role="alert">{error}</div>}
  </div>;
}

type SourcePreview={path:string;startLine:number;excerpt:string};
type SourceEditor='vscode'|'notepad';
type OpenSourceResult={opened:boolean;editor:SourceEditor;lineJumped:boolean;message:string};
const sourceEditorKey='contract-studio-source-editor-v1';

function TraceReference({reference,editor,onEditorChange}:{reference:TraceRef;editor:SourceEditor;onEditorChange:(editor:SourceEditor)=>void}){
  const [expanded,setExpanded]=useState(false);
  const [preview,setPreview]=useState<SourcePreview|null>(null);
  const [loading,setLoading]=useState(false);
  const [previewError,setPreviewError]=useState('');
  const [opening,setOpening]=useState(false);
  const [openMessage,setOpenMessage]=useState('');
  const [openError,setOpenError]=useState('');
  const loadPreview=async()=>{
    if(loading)return;
    setLoading(true);setPreviewError('');
    try{setPreview(await api<SourcePreview>(`/api/traceability/source?path=${encodeURIComponent(reference.path)}&line=${reference.line}`))}
    catch(e){setPreviewError(e instanceof Error?e.message:String(e))}
    finally{setLoading(false)}
  };
  const show=()=>{if(expanded){setExpanded(false);return}setExpanded(true);if(!preview)void loadPreview()};
  const openInEditor=async()=>{
    setOpening(true);setOpenMessage('');setOpenError('');
    try{const result=await api<OpenSourceResult>('/api/open-source',{path:reference.path,line:reference.line,editor});setOpenMessage(result.message)}
    catch(e){setOpenError(e instanceof Error?e.message:String(e))}
    finally{setOpening(false)}
  };
  return <div className={`trace-reference ${expanded?'is-expanded':''}`}>
    <button type="button" className="trace-ref" aria-expanded={expanded} onClick={()=>void show()}>
      <span>{reference.path}{reference.source==='local-marker'&&<small className="reference-origin">本地标记</small>}</span><b>第 {reference.line} 行 <span className="trace-chevron" aria-hidden="true">⌄</span></b>
    </button>
    <div className="trace-expand" aria-hidden={!expanded}><div className="trace-expand-inner"><div className="trace-preview-panel">
      <div className="trace-preview-toolbar">
        <label>打开方式<select aria-label={`选择 ${reference.path} 的编辑器`} value={editor} onChange={e=>{onEditorChange(e.target.value as SourceEditor);setOpenError('');setOpenMessage('')}}><option value="vscode">VS Code</option><option value="notepad">记事本</option></select></label>
        <button type="button" className="trace-open" disabled={opening} onClick={()=>void openInEditor()}>{opening?'正在打开…':'在编辑器打开 ↗'}</button>
      </div>
      {editor==='notepad'&&<p className="trace-editor-hint">记事本打开文件后，请按 Ctrl+G 跳到第 {reference.line} 行。</p>}
      {openError&&<div className="notice notice-error" role="alert">{openError}</div>}
      {openMessage&&<div className="trace-open-message" role="status">{openMessage}</div>}
      {loading?<div className="trace-preview-status" role="status">正在读取代码…</div>:previewError?<div className="notice notice-error" role="alert">无法读取代码：{previewError} <button className="link-button" onClick={()=>void loadPreview()}>重试</button></div>:preview&&<div className="trace-code" aria-label={`${preview.path} 代码预览`}><div className="trace-code-caption">代码预览 · 从第 {preview.startLine} 行</div><pre className="trace-code-lines">{preview.excerpt.split('\n').map((line,i)=>{const number=preview.startLine+i;return <span className={`trace-code-line ${number===reference.line?'is-target':''}`} key={number}><span className="trace-line-number" aria-hidden="true">{number}</span><span>{line||' '}</span></span>})}</pre></div>}
    </div></div></div>
  </div>;
}

function RequirementPanel({node,compatible,requirement,draft,traceability,loading,error,onRefresh,onSave,onCreate,onDraftChange,onDiscard}:{
  node:Spec;compatible:boolean;requirement?:Requirement;traceability:Traceability|null;loading:boolean;error:string;
  draft?:RequirementDraft;onDraftChange:(id:string,draft:RequirementDraft)=>void;onDiscard:(id:string)=>void;
  onRefresh:()=>void;onSave:(requirement:Requirement,title:string,description:string,action:'save'|'confirm',acceptance?:Acceptance[],confirmAcceptance?:boolean)=>Promise<void>;
  onCreate:(nodeId:string,id:string,title:string,description:string)=>Promise<void>;
}){
  const [busy,setBusy]=useState(false);
  const [formError,setFormError]=useState('');
  const [editor,setEditor]=useState<SourceEditor>(()=>{try{return localStorage.getItem(sourceEditorKey)==='notepad'?'notepad':'vscode'}catch{return 'vscode'}});
  const changeEditor=(next:SourceEditor)=>{setEditor(next);try{localStorage.setItem(sourceEditorKey,next)}catch{/* The current selection still works in this view. */}};
  if(loading)return <div className="empty">正在读取需求与代码关联…</div>;
  if(error)return <div className="trace-unavailable"><div className="notice notice-error">无法读取需求关联：{error}</div><button className="link-button" onClick={onRefresh}>重新读取</button></div>;
  if(!traceability)return <div className="empty">尚未读取需求关联。</div>;
  if(!compatible)return <div className="empty">当前画布属于其他功能，项目需求不会按同名节点自动关联。</div>;
  if(!requirement)return <CreateRequirement key={node.id} node={node} onCreate={onCreate}/>;
  const title=draft?.title??requirement.title;
  const description=draft?.description??requirement.description;
  const acceptance=draft?.acceptance??requirement.acceptance??[];
  const changed=title!==requirement.title||description!==requirement.description;
  const acceptanceChanged=!sameValue(acceptance,requirement.acceptance??[]);
  const addAcceptance=()=>{let number=1;while(acceptance.some(item=>item.id===`${requirement.id}_AC_${number}`))number++;editAcceptance([...acceptance,{id:`${requirement.id}_AC_${number}`,input:'',expected:''}])};
  const editAcceptance=(next:Acceptance[])=>onDraftChange(requirement.id,{title,description,acceptance:next});
  const save=async(action:'save'|'confirm',confirmAcceptance=false)=>{
    setBusy(true);setFormError('');
    try{await onSave(requirement,title,description,action,acceptance,confirmAcceptance)}catch(e){setFormError(String(e))}finally{setBusy(false)}
  };
  const links=(label:string,refs:TraceRef[])=><div className="trace-links"><div className="trace-links-heading">{label} <span>{refs.length}</span></div>{refs.length?refs.map((ref,i)=><TraceReference key={`${ref.path}:${ref.line}:${i}`} reference={ref} editor={editor} onEditorChange={changeEditor}/>):<div className="trace-missing">尚未发现关联标记</div>}</div>;
  return <div className="requirements-body">
    <div className="requirement-meta"><span className="requirement-id">{requirement.id}</span><span className={`requirement-status ${!changed&&requirement.status==='confirmed'?'confirmed':'draft'}`}>{changed?'有未保存修改':requirement.status==='confirmed'?'已确认':'草稿 · 待确认'}</span></div>
    <div className="trace-section-title">关联证据 <span>{traceability.index?.source==='sphinx-needs+codelinks'?'Sphinx-Needs / CodeLinks':'本地标记索引'}</span></div>
    {links('实现代码',requirement.code)}{links('相关测试',requirement.tests)}
    <p className="micro">列出的是发现的源码标记，不表示测试已经运行或验证通过。</p>
    <div className="field"><label htmlFor="requirement-title">需求标题</label><input id="requirement-title" value={title} onChange={e=>onDraftChange(requirement.id,{title:e.target.value,description,acceptance})}/></div>
    <div className="field"><label htmlFor="requirement-description">需求描述</label><textarea id="requirement-description" rows={4} value={description} onChange={e=>onDraftChange(requirement.id,{title,description:e.target.value,acceptance})}/></div>
    <div className="acceptance-heading"><strong>验收条件</strong><span className={`requirement-status ${!acceptanceChanged&&requirement.acceptanceStatus==='confirmed'?'confirmed':'draft'}`}>{!acceptanceChanged&&requirement.acceptanceStatus==='confirmed'?'已确认':'待确认'}</span></div>
    {acceptance.map((item,index)=><fieldset className="acceptance-item" key={index}><legend>条件 {index+1}</legend>{(['id','input','expected','observable'] as const).map(field=><div className="field" key={field}><label>{({id:'条件 ID',input:'输入',expected:'预期结果',observable:'可观察行为'} as const)[field]}<input aria-label={`条件${index+1}${field}`} value={item[field]??''} onChange={event=>editAcceptance(acceptance.map((entry,i)=>i===index?{...entry,[field]:event.target.value}:entry))}/></label></div>)}<button className="link-button danger-link" onClick={()=>editAcceptance(acceptance.filter((_,i)=>i!==index))}>移除此条件</button></fieldset>)}
    <div className="requirement-actions"><button className="link-button" onClick={addAcceptance}>＋ 添加验收条件</button><button onClick={()=>void save('save',true)} disabled={busy||!acceptance.length||acceptance.some(item=>!item.id.trim()||!item.input.trim()||!item.expected.trim())||(!acceptanceChanged&&requirement.acceptanceStatus==='confirmed')}>确认验收条件</button></div>
    <div className="requirement-actions"><button onClick={()=>void save('save')} disabled={busy||(!changed&&!acceptanceChanged)||!title.trim()||!description.trim()}>保存草稿</button><button className="primary-button" onClick={()=>void save('confirm')} disabled={busy||(!changed&&requirement.status==='confirmed')||!title.trim()||!description.trim()}>{busy?'保存中…':'确认这条需求'}</button>{(changed||acceptanceChanged)&&<button className="link-button" onClick={()=>onDiscard(requirement.id)} disabled={busy}>放弃修改</button>}</div>
    <p className="micro">确认记录当前文字；修改后需重新确认。画布修改先保存在浏览器，需手动保存到项目；业务代码不会自动改写。</p>
    {formError&&<div className="notice notice-error" role="alert">{formError} <button className="link-button" onClick={onRefresh}>重新读取</button></div>}
    <div className="trace-source">需求文件：{traceability.source} · RST 源文件：{traceability.sphinx.state==='current'?'已同步':traceability.sphinx.state==='outdated'?'待同步':'缺失'}</div>
  </div>;
}

function Studio({feature,catalog,client,onFeatureChange,openRequest}:{feature:FeatureDefinition;catalog:FeatureCatalog;client:FeatureClient;onFeatureChange:(alias:string,mode?:string)=>void;openRequest?:OpenFeatureRequest}){
  const original=feature.graph;
  const workspaceAlias=feature.alias;
  const {rootNodeId:rootId,defaultSelected}=feature;
  const {graph:JSON_KEY,base:GRAPH_BASE_KEY,pending:GRAPH_PENDING_KEY,requirements:REQUIREMENT_DRAFT_KEY}=feature.draftKeys;
  const traceUrl=`/api/traceability?feature=${encodeURIComponent(feature.id)}`;
  const FeaturePanel=client.Panel;
  const [initial]=useState(()=>{
    let graph=clone(original),hasDraft=false,base:Graph|null=null,rawDraft='',draftError='';
    try{rawDraft=localStorage.getItem(JSON_KEY)??'';if(rawDraft){hasDraft=true;graph=toGraph(rawDraft)}}catch(error){draftError=String(error)}
    try{const text=localStorage.getItem(GRAPH_BASE_KEY);if(text)base=toGraph(text)}catch{/* A missing baseline requires explicit reconciliation. */}
    return {graph,hasDraft,base,rawDraft,draftError};
  });
  const [draftReadError,setDraftReadError]=useState(initial.draftError);
  const [graph,setGraph]=useState<Graph>(initial.graph);
  const [graphBase,setGraphBase]=useState<Graph|null>(initial.base);
  const [graphReady,setGraphReady]=useState(false);
  const [graphBusy,setGraphBusy]=useState(false);
  const [graphMessage,setGraphMessage]=useState<{tone:'success'|'error';text:string}|null>(null);
  const graphRef=useRef(graph);graphRef.current=graph;
  const graphBaseRef=useRef(graphBase);graphBaseRef.current=graphBase;
  const graphInitialized=useRef(false);
  const [selectedId,setSelectedId]=useState(defaultSelected);
  const [runtimeOptions,setRuntimeOptions]=useState<Record<string,unknown>>({});
  const capabilities=catalog.capabilities;
  const [traceability,setTraceability]=useState<Traceability|null>(null);
  const [requirementDrafts,setRequirementDrafts]=useState<Record<string,RequirementDraft>>(()=>{try{const saved=JSON.parse(localStorage.getItem(REQUIREMENT_DRAFT_KEY)??'{}');return saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{}}catch{return {}}});
  const [traceLoading,setTraceLoading]=useState(true);
  const [traceError,setTraceError]=useState('');
  const [indexBusy,setIndexBusy]=useState(false);
  const [indexError,setIndexError]=useState('');
  const refreshTraceability=useCallback(()=>{
    setTraceLoading(true);setTraceError('');
    void api<Traceability>(traceUrl).then(data=>{
      const project=toGraph(JSON.stringify(data.projectGraph));
      setTraceability(data);
      let pending:Graph|null=null;
      try{const text=localStorage.getItem(GRAPH_PENDING_KEY);if(text)pending=toGraph(text)}catch{/* A malformed pending record cannot establish a baseline. */}
      if(pending){
        if(sameGraph(project,pending)){const submitted=pending;setGraph(current=>reconcileGraphSave(current,submitted,project));setGraphBase(clone(project));setGraphMessage({tone:'success',text:'画布已保存到项目；业务代码不会自动改变。'});localStorage.removeItem(GRAPH_PENDING_KEY)}
        else{setGraphMessage({tone:'error',text:'上次保存未确认成功，浏览器草稿仍在；请核对项目图后再操作。'});localStorage.removeItem(GRAPH_PENDING_KEY)}
      }
      if(!graphInitialized.current){
        if(!initial.hasDraft){setGraph(clone(project));setGraphBase(clone(project))}
        else if(sameGraph(graphRef.current,project))setGraphBase(clone(project));
        graphInitialized.current=true;setGraphReady(true);
      }else if(!graphBaseRef.current&&sameGraph(graphRef.current,project))setGraphBase(clone(project));
    }).catch(e=>{setTraceError(String(e));graphInitialized.current=true;setGraphReady(true)}).finally(()=>setTraceLoading(false));
  },[initial.hasDraft,traceUrl,GRAPH_PENDING_KEY]);
  useEffect(()=>{refreshTraceability()},[refreshTraceability]);
  const saveRequirement=async(requirement:Requirement,title:string,description:string,action:'save'|'confirm',acceptance?:Acceptance[],confirmAcceptance=false)=>{
    const updated=await api<Traceability>('/api/traceability/requirement',{featureId:traceability?.featureId,id:requirement.id,title,description,revision:requirement.revision,action,acceptance,confirmAcceptance});
    setTraceability(updated);
    setRequirementDrafts(old=>{const next={...old};delete next[requirement.id];return next});
  };
  const discardDraft=(id:string)=>setRequirementDrafts(old=>{const next={...old};delete next[id];return next});
  const changeDraft=(id:string,draft:RequirementDraft)=>setRequirementDrafts(old=>({...old,[id]:draft}));
  const createRequirement=async(nodeId:string,id:string,title:string,description:string)=>{
    const updated=await api<Traceability>('/api/traceability/requirement',{featureId:traceability?.featureId,id,nodeId,title,description,action:'create'});
    setTraceability(updated);
  };
  const initialCollapsed=()=>new Set<string>(client.initialCollapsed?.(feature)??[]);
  const [collapsed,setCollapsed]=useState<Set<string>>(initialCollapsed);
  const [tab,setTab]=useState<'property'|'document'|'requirement'|'test'|'code'|'trace'>('property');
  const [importanceView,setImportanceView]=useState(false);
  const [focusId,setFocusId]=useState<string|null>(null);
  const [activeRequirementId,setActiveRequirementId]=useState('');
  const [linkRequirementId,setLinkRequirementId]=useState('');
  const [creatingRequirement,setCreatingRequirement]=useState(false);
  const [linkBusy,setLinkBusy]=useState(false);
  const [linkError,setLinkError]=useState('');
  const [panelOpen,setPanelOpen]=useState(false);
  const [fixture,setFixture]=useState('');
  const [mode,setMode]=useState<'mock'|'dry-run'|'sandbox'>('dry-run');
  const [nodeResult,setNodeResult]=useState<Run|null>(null);
  const [trace,setTrace]=useState<Step[]>([]);
  const [source,setSource]=useState<{file:string;symbol:string;excerpt:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [fitVersion,setFitVersion]=useState(0);
  const fileRef=useRef<HTMLInputElement>(null);
  const selected=graph.nodes.find(n=>n.id===selectedId);
  const compatible=!!traceability&&graph.feature?.id===traceability.featureId;
  const selectedRequirements=compatible?traceability?.requirements.filter(r=>(r.nodeIds??[r.nodeId]).includes(selectedId))??[]:[];
  const selectedRequirement=selectedRequirements.find(requirement=>requirement.id===activeRequirementId)??selectedRequirements[0];
  const selectedCapability=selected?.capabilityId?capabilities.find(capability=>capability.id===selected.capabilityId):capabilities.find(capability=>capability.nodeIds.includes(selectedId));
  const degree={in:graph.edges.filter(x=>x.target===selectedId).length,out:graph.edges.filter(x=>x.source===selectedId).length};
  useEffect(()=>{if(!draftReadError)localStorage.setItem(JSON_KEY,JSON.stringify(graph))},[graph,draftReadError]);
  useEffect(()=>{if(draftReadError)return;if(graphBase)localStorage.setItem(GRAPH_BASE_KEY,JSON.stringify(graphBase));else localStorage.removeItem(GRAPH_BASE_KEY)},[graphBase,draftReadError]);
  useEffect(()=>{localStorage.setItem(REQUIREMENT_DRAFT_KEY,JSON.stringify(requirementDrafts))},[requirementDrafts]);
  useEffect(()=>{setGraphMessage(null)},[graph]);
  useEffect(()=>{setFixture(JSON.stringify(selected?.fixture??{},null,2));setNodeResult(null);setError('');setSource(null);setActiveRequirementId('');setCreatingRequirement(false);setLinkRequirementId('');setLinkError('')},[selectedId]);
  useEffect(()=>{if(!panelOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLTextAreaElement))setPanelOpen(false)};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[panelOpen]);
  useEffect(()=>{
    if(tab!=='code'||!selected)return;
    let live=true;
    const custom=client.sourcePath?.(selected,runtimeOptions);
    const ref=selectedRequirement?.code[0];
    const path=custom??(ref?`/api/traceability/source?path=${encodeURIComponent(ref.path)}&line=${ref.line}`:undefined);
    if(!path){setSource(null);return}
    void api<{path?:string;file?:string;symbol?:string;excerpt:string}>(path).then(data=>{if(live)setSource({file:data.path??data.file??'',symbol:data.symbol??selected.id,excerpt:data.excerpt})}).catch(()=>{if(live)setSource(null)});
    return()=>{live=false};
  },[selectedId,tab,runtimeOptions,client,selectedRequirement]);
  const toggle=useCallback((id:string)=>{setCollapsed(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next})},[]);
  const byId=useMemo(()=>new Map(graph.nodes.map(n=>[n.id,n])),[graph.nodes]);
  const focus=useMemo(()=>focusId?graphFocus(graph,focusId):null,[graph,focusId]);
  const toggleNode=useCallback((id:string)=>{if(focusId)setFocusId(id);else toggle(id);setSelectedId(id)},[toggle,focusId]);
  const hidden=useCallback((n:Spec)=>{let p=n.parentId;const walked=new Set<string>();while(p&&!walked.has(p)){if(collapsed.has(p))return true;walked.add(p);p=byId.get(p)?.parentId??null}return false},[collapsed,byId]);
  const statuses=useMemo(()=>Object.fromEntries(trace.map(t=>[t.nodeId,t.status])),[trace]);
  const derivedNodes=useMemo(()=>new Set(trace.filter(step=>step.derived).map(step=>step.nodeId)),[trace]);
  const activeEdges=useMemo(()=>{
    const active=new Map<string,'ok'|'rejected'>();
    const isWithin=(nodeId:string,ancestorId:string)=>{
      const seen=new Set<string>();
      let current:string|null|undefined=nodeId;
      while(current&&!seen.has(current)){
        if(current===ancestorId)return true;
        seen.add(current);current=byId.get(current)?.parentId;
      }
      return false;
    };
    for(let i=1;i<trace.length;i++){
      const from=trace[i-1],to=trace[i];
      if(from.status==='mock'||to.status==='mock')continue;
      const handle=from.status==='rejected'?'fail':'ok';
      for(const edge of graph.edges)if(isWithin(from.nodeId,edge.source)&&isWithin(to.nodeId,edge.target)&&(edge.sourceHandle??'ok')===handle)active.set(edge.id,from.status);
    }
    return active;
  },[graph.edges,trace,byId]);
  const layout=useMemo(()=>client.layout?.(graph,collapsed,original)??{offsets:new Map(),sizes:new Map()},[client,graph,collapsed,original]);
  const addChild=useCallback((parentId:string)=>{
    if(!graphReady)return;
    const id=`step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    setGraph(g=>{
      const parent=g.nodes.find(n=>n.id===parentId);
      if(!parent||parent.kind!=='group')return g;
      const children=g.nodes.filter(n=>n.parentId===parentId);
      const y=Math.max(80,...children.map(n=>n.position.y+(n.size?.height??120)+28));
      const node:Spec={id,parentId,title:'新功能节点',kind:'logic',importance:'normal',description:'',position:{x:35,y},input:'待填写',output:'待填写',processing:'',acceptance:'',errors:[],fixture:{},code:'',test:''};
      const size={width:Math.max(parent.size?.width??0,970),height:Math.max(parent.size?.height??0,y+160)};
      return {...g,nodes:[...g.nodes.map(n=>n.id===parentId?{...n,size}:n),node]};
    });
    setCollapsed(old=>{const next=new Set(old);next.delete(parentId);return next});
    setSelectedId(id);setFocusId(id);setPanelOpen(true);setTab('property');setFitVersion(n=>n+1);
  },[graphReady]);
  const flowNodes=useMemo<DisplayNode[]>(()=>[...graph.nodes].sort((a,b)=>{const depth=(node:Spec)=>{let value=0,p=node.parentId;const seen=new Set<string>();while(p&&!seen.has(p)){seen.add(p);value++;p=byId.get(p)?.parentId??null}return value};return depth(a)-depth(b)}).map(n=>{
    const hasChildren=graph.nodes.some(x=>x.parentId===n.id);
    const folded=hasChildren&&collapsed.has(n.id);
    const displacement=layout.offsets.get(n.id);
    const projected=focus?.positions.get(n.id);
    return {id:n.id,type:'contract',parentId:focus?undefined:n.parentId??undefined,position:projected??(displacement?{x:n.position.x-displacement.x,y:n.position.y-displacement.y}:n.position),
      style:{width:focus?232:!folded&&layout.sizes.has(n.id)?layout.sizes.get(n.id)!.width:hasChildren&&!folded?(n.size?.width??970):n.kind==='group'?230:176,height:focus?130:!folded&&layout.sizes.has(n.id)?layout.sizes.get(n.id)!.height:hasChildren&&!folded?(n.size?.height??415):n.kind==='group'?120:116},
      hidden:focus?!focus.ids.has(n.id):hidden(n),selected:n.id===selectedId,
      className:importanceView?(nodeImportance(n.importance)==='normal'?'importance-muted':'importance-emphasis'):undefined,
      data:{spec:n,hasChildren,collapsed:focus?hasChildren:folded,run:statuses[n.id],derived:derivedNodes.has(n.id),requirement:compatible&&!traceError&&!traceLoading?traceability?.requirements.find(r=>(r.nodeIds??[r.nodeId]).includes(n.id)):undefined,hasUnsavedRequirement:compatible&&!!traceability?.requirements.some(r=>(r.nodeIds??[r.nodeId]).includes(n.id)&&!!requirementDrafts[r.id]&&(requirementDrafts[r.id].title!==r.title||requirementDrafts[r.id].description!==r.description||!sameValue(requirementDrafts[r.id].acceptance??r.acceptance??[],r.acceptance??[]))),traceAvailable:compatible&&!traceError&&!traceLoading,toggle:toggleNode,addChild,annotation:client.nodeAnnotation?.(n,runtimeOptions)},
    };
  }),[graph.nodes,byId,collapsed,hidden,selectedId,statuses,derivedNodes,toggleNode,addChild,client,runtimeOptions,traceability,requirementDrafts,compatible,traceError,traceLoading,layout,focus,importanceView]);
  const flowEdges=useMemo<Edge[]>(()=>graph.edges.map(e=>({
    ...e,id:e.id,sourceHandle:e.sourceHandle??'ok',targetHandle:e.targetHandle??'in',type:'branch',
    hidden:focus?!(focus.ids.has(e.source)&&focus.ids.has(e.target)):hidden(byId.get(e.source)!)||hidden(byId.get(e.target)!),
    animated:activeEdges.has(e.id),style:{stroke:activeEdges.get(e.id)==='rejected'?'#c45f40':activeEdges.has(e.id)?'#178367':'#94a3b8',strokeWidth:activeEdges.has(e.id)?2.5:1.5},
    markerEnd:{type:MarkerType.ArrowClosed,color:'#94a3b8',width:16,height:16}
  })),[graph.edges,byId,hidden,activeEdges,focus]);
  const onNodesChange=useCallback((changes:NodeChange<DisplayNode>[])=>{
    if(focusId)return;
    setGraph(g=>{let updated=g.nodes;for(const c of changes){if(c.type==='position'&&c.position){updated=updated.map(n=>{if(n.id!==c.id)return n;const delta=layout.offsets.get(n.id);return {...n,position:delta?{x:c.position!.x+delta.x,y:c.position!.y+delta.y}:c.position!}})}}return updated===g.nodes?g:{...g,nodes:updated}});
  },[layout,focusId]);
  const onEdgesChange=useCallback((changes:EdgeChange[])=>{
    const deleted=new Set(changes.filter(x=>x.type==='remove').map(x=>x.id));
    if(deleted.size)setGraph(g=>({...g,edges:g.edges.filter(e=>!deleted.has(e.id))}));
  },[]);
  const onConnect=useCallback((c:Connection)=>{
    if(!c.source||!c.target||c.source===c.target)return;
    const id=`edge-${Date.now()}`;
    setGraph(g=>({...g,edges:[...g.edges,{id,source:c.source,target:c.target,sourceHandle:c.sourceHandle??'ok',targetHandle:c.targetHandle??'in',label:c.sourceHandle==='fail'?'失败':'下一步'}]}));
  },[]);
  const update=(patch:Partial<Spec>)=>{setGraph(g=>({...g,nodes:g.nodes.map(n=>n.id===selectedId?{...n,...patch}:n)}));if(patch.parentId)setCollapsed(old=>{const next=new Set(old);next.delete(patch.parentId!);return next})};
  const remove=()=>{
    if(selectedId===rootId)return;
    const removed=new Set([selectedId]);let changed=true;
    while(changed){changed=false;for(const node of graph.nodes)if(node.parentId&&removed.has(node.parentId)&&!removed.has(node.id)){removed.add(node.id);changed=true}}
    if(removed.size>1&&!window.confirm(`删除「${selected?.title}」和它的 ${removed.size-1} 个子节点？此操作先修改浏览器草稿。`))return;
    setGraph(g=>({...g,nodes:g.nodes.filter(n=>!removed.has(n.id)),edges:g.edges.filter(e=>!removed.has(e.source)&&!removed.has(e.target))}));setSelectedId(rootId);if(focusId&&removed.has(focusId))setFocusId(null);
  };
  const runSelected=async()=>{
    if(!selected||!selectedCapability)return;setError('');setBusy(true);
    try{const input=JSON.parse(fixture);
      const nodeId=selectedCapability.nodeIds.includes(selected.id)?selected.id:selectedCapability.rootNodeId;
      const result=await api<Run>(selectedCapability.testPath,{nodeId,input,mode,...runtimeOptions});setNodeResult(result);
      setTrace(result.trace??[]);
    }catch(e){setError(String(e))}finally{setBusy(false)};
  };
  const projectGraph=traceability?.projectGraph;
  const graphConflict=!!graphBase&&!!projectGraph&&!sameGraph(graphBase,projectGraph);
  const graphCompatible=!!projectGraph&&graph.feature?.id===traceability?.featureId;
  const graphDirty=!!graphBase&&!sameGraph(graph,graphBase);
  const saveGraph=async()=>{
    if(draftReadError||!graphBase||!graphCompatible||graphConflict)return;
    const saved=clone(graph);
    setGraphBusy(true);setGraphMessage(null);
    try{
      // A Vite reload can occur while the server persists the imported JSON file.
      localStorage.setItem(JSON_KEY,JSON.stringify(saved));
      localStorage.setItem(GRAPH_BASE_KEY,JSON.stringify(graphBase));
      localStorage.setItem(REQUIREMENT_DRAFT_KEY,JSON.stringify(requirementDrafts));
      localStorage.setItem(GRAPH_PENDING_KEY,JSON.stringify(saved));
      const updated=await api<Traceability>('/api/traceability/graph',{featureId:traceability!.featureId,graph:saved,expectedGraph:graphBase});
      const canonical=toGraph(JSON.stringify(updated.projectGraph));
      setTraceability(updated);setGraph(current=>reconcileGraphSave(current,saved,canonical));setGraphBase(clone(canonical));localStorage.removeItem(GRAPH_PENDING_KEY);
      setGraphMessage({tone:'success',text:'画布已保存到项目；业务代码不会自动改变。'});
    }catch(e){
      if(e instanceof ApiError){localStorage.removeItem(GRAPH_PENDING_KEY);if(e.status===409)refreshTraceability()}
      setGraphMessage({tone:'error',text:e instanceof ApiError&&e.status===409?'项目图已变更，未覆盖。草稿仍在，请加载项目图或核对后重新设定基线。':`保存未确认：${String(e)}。草稿仍在，请重新读取项目状态。`});
    }finally{setGraphBusy(false)}
  };
  const loadProjectGraph=async()=>{
    setGraphBusy(true);
    try{
      const current=await api<Traceability>(traceUrl);
      const project=toGraph(JSON.stringify(current.projectGraph));
      setTraceability(current);setTraceError('');
      if((draftReadError||!sameGraph(graph,project))&&!window.confirm('加载项目图会替换当前浏览器画布草稿。请先导出需要保留的草稿。确定继续吗？'))return;
      setDraftReadError('');setFocusId(null);setGraph(clone(project));setGraphBase(clone(project));setSelectedId(project.nodes[0]?.id??'');setCollapsed(initialCollapsed());setTrace([]);setFitVersion(n=>n+1);
      setGraphMessage({tone:'success',text:'已读取项目图。'});
    }catch(e){setGraphMessage({tone:'error',text:`无法读取项目图：${String(e)}。浏览器草稿未改变。`})}finally{setGraphBusy(false)}
  };
  const rebaseGraph=async()=>{
    if(!window.confirm('保留当前浏览器草稿，并以最新项目图为基线？之后点击“保存到项目”会用整个草稿覆盖项目图。建议先导出并核对两份内容。'))return;
    setGraphBusy(true);
    try{
      const current=await api<Traceability>(traceUrl);
      if(graph.feature?.id!==current.featureId)throw Error('当前画布功能与项目不匹配');
      setTraceability(current);setTraceError('');setGraphBase(clone(current.projectGraph));
      setGraphMessage({tone:'success',text:'已保留草稿并更新基线；确认无误后点击“保存到项目”。'});
    }catch(e){setGraphMessage({tone:'error',text:`无法更新基线：${String(e)}。浏览器草稿未改变。`})}finally{setGraphBusy(false)}
  };
  const exportGraph=()=>{const blob=new Blob([draftReadError?initial.rawDraft:JSON.stringify(graph,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`contract.${workspaceAlias}${draftReadError?'.invalid-draft':''}.json`;a.click();URL.revokeObjectURL(url)};
  const importGraph=async(file?:File)=>{if(!file)return;try{const g=toGraph(await file.text());setDraftReadError('');setFocusId(null);setGraph(g);setSelectedId(g.nodes[0]?.id??'');setTrace([]);setCollapsed(initialCollapsed());setFitVersion(n=>n+1);setGraphMessage(null)}catch(e){setGraphMessage({tone:'error',text:`无法导入画布：${String(e)}`})}};
  const selectNode=(id:string)=>{setSelectedId(id);setError('');setPanelOpen(true);setTab('property')};
  const selectedPath:Spec[]=[];
  {let current=selected;const seen=new Set<string>();while(current&&!seen.has(current.id)){seen.add(current.id);selectedPath.unshift(current);current=current.parentId?byId.get(current.parentId):undefined}}
  const onFullRun=(run:Run)=>{setTrace(run.trace??[]);setNodeResult(run);setError('')};
  const buildIndex=async()=>{setIndexBusy(true);setIndexError('');try{setTraceability(await api<Traceability>('/api/traceability/build',{featureId:traceability?.featureId??graph.feature.id}))}catch(reason){setIndexError(String(reason))}finally{setIndexBusy(false)}};
  const linkRequirement=async()=>{
    const requirement=traceability?.requirements.find(item=>item.id===linkRequirementId);if(!requirement)return;
    setLinkBusy(true);setLinkError('');
    try{const nodeIds=[...new Set([...(requirement.nodeIds??[requirement.nodeId]),selectedId])];setTraceability(await api<Traceability>('/api/traceability/requirement',{featureId:traceability!.featureId,id:requirement.id,title:requirement.title,description:requirement.description,revision:requirement.revision,action:'save',nodeIds}));setActiveRequirementId(requirement.id);setCreatingRequirement(false);setLinkRequirementId('')}catch(reason){setLinkError(String(reason))}finally{setLinkBusy(false)}
  };
  const openCapability=(capability:Capability)=>{
    const destination=capabilityDestination(catalog,capability);
    if(!destination||!featureClients[destination.frontend.entry]){setError('该能力的前端入口尚未注册。');return}
    onFeatureChange(destination.alias,capability.frontend?.mode);setPanelOpen(false);
  };
  const graphStatus=!graphReady?'正在读取项目图…':traceError?'无法读取项目图，浏览器草稿仍可编辑':!graphCompatible?'画布功能与项目图不匹配':graphConflict?'项目图已变更，本地草稿未覆盖':!graphBase?'浏览器草稿缺少项目基线':graphDirty?'浏览器草稿 · 未保存到项目':'已与项目图同步';
  return <div className="studio-shell">
    <header className="topbar"><div className="brand"><div className="brand-symbol">◇</div><div><strong>Contract Studio</strong><span>让功能可见，让实现可验</span></div></div><div className="top-actions"><button onClick={()=>void saveGraph()} disabled={!!draftReadError||!graphReady||graphBusy||!!traceError||!graphCompatible||!graphBase||graphConflict||!graphDirty} className="save-project">{graphBusy?'处理中…':'保存到项目'}</button><button onClick={exportGraph}>导出 JSON</button><button onClick={()=>fileRef.current?.click()} disabled={!graphReady}>导入</button><button onClick={()=>{if(draftReadError&&!window.confirm('重置会替换被拒绝的草稿，请先导出需要保留的原稿。继续吗？'))return;setDraftReadError('');setFocusId(null);setGraph(clone(original));setSelectedId(defaultSelected);setCollapsed(initialCollapsed());setTrace([]);setFitVersion(n=>n+1)}} disabled={!graphReady}>重置画布</button><input hidden type="file" ref={fileRef} accept=".json,application/json" onChange={e=>{void importGraph(e.target.files?.[0]);e.target.value=''}}/></div></header>
    <div className="subheader"><div className="workspace-switcher"><label htmlFor="studio-workspace">功能工作区</label><select id="studio-workspace" value={workspaceAlias} onChange={e=>onFeatureChange(e.target.value)}>{visibleFeatures(catalog,workspaceAlias).map(item=><option key={item.alias} value={item.alias}>{item.title}</option>)}</select></div><span className="sub-caption">需求 · 功能图 · 实现与测试</span></div>
    <div className="workspace">
      <section className={`canvas with-feature-panel ${focus?'is-focused':''}`}>
        <div className="canvas-header"><strong>功能流程</strong><span>点击节点编辑 · 双击空白处添加</span><button onClick={()=>toggle(rootId)}>{collapsed.has(rootId)?'展开功能组':'折叠功能组'}</button></div>
        <div className="graph-view-controls" role="group" aria-label="图视图"><button aria-pressed={importanceView} onClick={()=>setImportanceView(value=>!value)}>重点视图</button><button disabled={!selected} onClick={()=>{setFocusId(selectedId);setPanelOpen(false);setFitVersion(value=>value+1)}}>聚焦节点</button><button onClick={()=>{setFocusId(null);setFitVersion(value=>value+1)}}>{focus?'返回总览':'适合画布'}</button><span>{focus?'局部投影 · 布局只读，原图位置保持不变':importanceView?'突出核心与关键逻辑，保留全部连线':'全图 · 拖动节点可调整项目布局'}</span></div>
        {focus&&<nav className="focus-path" aria-label="聚焦节点的所属功能"><span>所在功能</span>{focus.ancestors.map(item=><button key={item.id} onClick={()=>{setFocusId(item.id);setSelectedId(item.id)}}>{item.title} ›</button>)}<strong>{byId.get(focusId!)?.title??'项目根节点'}</strong></nav>}
        <div className="importance-legend" aria-label="逻辑重要性图例"><span>逻辑重要性</span>{Object.entries(importanceLabels).map(([value,label])=><span className={`importance-badge importance-${value}`} key={value}>{label}</span>)}</div>
        <div className={`graph-sync ${graphConflict||!graphBase?'attention':''}`} role="status"><span>{graphStatus}</span><div><button onClick={refreshTraceability} disabled={!graphReady||graphBusy||traceLoading}>刷新状态</button><button onClick={()=>void loadProjectGraph()} disabled={!graphReady||graphBusy}>读取项目图</button>{graphCompatible&&(graphConflict||!graphBase)&&<button onClick={()=>void rebaseGraph()} disabled={graphBusy}>保留草稿并更新基线</button>}</div></div>
        <div className={`index-status ${traceability?.index?.state??'missing'}`} role="status"><span><b>需求索引</b> · {indexBusy?'正在构建…':traceability?.index?({current:'已构建 · 当前',stale:'源已变化 · 待重建',failed:'构建失败',missing:'尚未构建',unconfigured:'未配置构建工具'} as const)[traceability.index.state]:'正在读取'}{traceability?.index?.source==='local-marker'?' · 本地标记兼容视图':' · Sphinx-Needs / CodeLinks'}</span><button className="link-button" disabled={indexBusy||traceLoading||!traceability} onClick={()=>void buildIndex()}>重建索引</button></div>
        {traceability?.ubcode&&<div className="index-tool-note">ubCode：{traceability.ubcode.message}</div>}
        {(indexError||traceability?.index?.error)&&<div className="graph-message error" role="alert">{indexError||traceability?.index?.error}</div>}
        {draftReadError&&<div className="graph-message error" role="alert">浏览器草稿读取被拒绝：{draftReadError}。原始草稿已保留，当前显示项目图且暂停自动保存；“导出 JSON”可备份原稿，再读取项目图或导入修正版。</div>}
        {graphMessage&&<div className={`graph-message ${graphMessage.tone}`} role={graphMessage.tone==='error'?'alert':'status'}>{graphMessage.text}</div>}
        <ReactFlow style={focus?{height:Math.max(480,...[...focus.positions.values()].map(position=>position.y+230))}:undefined} nodes={flowNodes} edges={flowEdges} nodesDraggable={graphReady&&!focusId} nodesConnectable={graphReady} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,n)=>selectNode(n.id)} onNodeDoubleClick={(_,n)=>{if(graph.nodes.some(x=>x.parentId===n.id))toggleNode(n.id)}} onPaneClick={(event)=>{if(event.detail===2&&graphReady)addChild(rootId)}} fitView fitViewOptions={{padding:.06}} minZoom={.2} maxZoom={1.5} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} deleteKeyCode={null} defaultEdgeOptions={{type:'branch'}}>
          <Background gap={22} size={1} color="#e6ebf0"/><Controls position="bottom-left" showInteractive={false}/>
          <Fit value={fitVersion} focusId={focusId}/>
        </ReactFlow>
        <div className="canvas-footer"><span>在功能组里添加节点，也可双击空白处添加。连线表示业务数据与分支。</span><span>当前显示 {flowNodes.filter(node=>!node.hidden).length} 节点 · {flowEdges.filter(edge=>!edge.hidden).length} 条边 <small>全图 {graph.nodes.length} 节点 · {graph.edges.length} 条边</small></span></div>
        <div className="feature-outlet" id="feature-outlet"><FeaturePanel feature={feature} onRun={onFullRun} runtimeOptions={runtimeOptions} onRuntimeOptionsChange={options=>{setRuntimeOptions(options);setNodeResult(null);setSource(null);setTrace([])}} openRequest={openRequest}/></div>
      </section>
      <aside className={`right-side node-drawer ${panelOpen?'is-open':''}`} aria-label="节点详情">
        <section className="inspector" hidden={!panelOpen}>
          <div className="panel-heading"><div><div className="eyebrow">节点检查器</div><h2>{selected?.title??'选择节点'}</h2></div><div className="degree">入 {degree.in} / 出 {degree.out}</div><button type="button" className="drawer-close" aria-label="关闭节点详情" onClick={()=>setPanelOpen(false)}>×</button></div>
          {selected&&<>
            {selectedPath.length>1&&<nav className="node-path" aria-label="功能层级">{selectedPath.map((part,index)=><span key={part.id}>{index>0&&<span className="path-separator" aria-hidden="true">›</span>}{index===selectedPath.length-1?<strong aria-current="location">{part.title}</strong>:<button type="button" onClick={()=>selectNode(part.id)}>{part.title}</button>}</span>)}</nav>}
            <p className="description">{selected.description}</p>
            <div className="info-pair"><span>输入</span><b>{selected.input}</b></div><div className="info-pair"><span>输出</span><b>{selected.output}</b></div>
            <div className="tabs">{(['property','document','requirement','test','trace','code'] as const).map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t==='property'?'节点属性':t==='document'?'文档与任务':t==='requirement'?'需求关联':t==='test'?'运行与测试':t==='trace'?'日志':'实现映射'}</button>)}</div>
            {tab==='property'&&<NodeProperties key={selected.id} node={selected} nodes={graph.nodes} capabilities={capabilities} onPatch={update} onSave={()=>void saveGraph()} saving={graphBusy} canSave={!draftReadError&&graphDirty&&!graphConflict&&graphCompatible&&!!graphBase&&!!selected.title.trim()} onRemove={selected.id===rootId?undefined:remove}/>}
            {tab==='document'&&<NodeDocument featureId={feature.id} graph={graph} nodeId={selected.id} dirty={!projectGraph||!sameGraph(graph,projectGraph)} sourceVersion={traceability}/>}
            {tab==='requirement'&&<>
              {compatible&&!traceLoading&&!traceError&&<div className="requirement-picker">
                {selectedRequirements.length>0&&<div className="field"><label htmlFor="node-requirement">关联需求 · {selectedRequirements.length} 条</label><select id="node-requirement" value={creatingRequirement?'':selectedRequirement?.id??''} onChange={event=>{setActiveRequirementId(event.target.value);setCreatingRequirement(false)}}>{creatingRequirement&&<option value="">正在创建新需求</option>}{selectedRequirements.map(requirement=><option key={requirement.id} value={requirement.id}>{requirement.id} · {requirement.title}</option>)}</select></div>}
                <details><summary>关联已有需求或新增需求</summary><div className="requirement-link-row"><select aria-label="选择已有需求" value={linkRequirementId} onChange={event=>setLinkRequirementId(event.target.value)}><option value="">选择已有需求</option>{traceability?.requirements.filter(requirement=>!(requirement.nodeIds??[requirement.nodeId]).includes(selectedId)).map(requirement=><option key={requirement.id} value={requirement.id}>{requirement.id} · {requirement.title}</option>)}</select><button className="link-button" disabled={!linkRequirementId||linkBusy||!projectGraph?.nodes.some(node=>node.id===selectedId)} onClick={()=>void linkRequirement()}>关联</button></div><button className="link-button" onClick={()=>setCreatingRequirement(true)}>＋ 创建新需求</button>{!projectGraph?.nodes.some(node=>node.id===selectedId)&&<p className="micro">先将新节点保存到项目，再关联需求。</p>}</details>
                {linkError&&<div className="notice notice-error" role="alert">{linkError}</div>}
              </div>}
              <RequirementPanel key={`${selected.id}:${creatingRequirement?'new':selectedRequirement?.id??'new'}:${selectedRequirement?.revision??0}`} node={selected} compatible={compatible} requirement={creatingRequirement?undefined:selectedRequirement} draft={!creatingRequirement&&selectedRequirement?requirementDrafts[selectedRequirement.id]:undefined} traceability={traceability} loading={traceLoading} error={traceError} onRefresh={refreshTraceability} onSave={saveRequirement} onCreate={async(...args)=>{await createRequirement(...args);setActiveRequirementId(args[1]);setCreatingRequirement(false)}} onDraftChange={changeDraft} onDiscard={discardDraft}/>
            </>}
            {tab==='test'&&<div className="inspector-body">
              <CapabilityPanel key={selectedCapability?.id??selected.id} capability={selectedCapability} onOpen={openCapability}/>
              <div className="property-section-title">节点试运行</div>
              <div className="field"><label>试运行输入 JSON</label><textarea className="json-area" rows={5} spellCheck={false} value={fixture} onChange={e=>setFixture(e.target.value)}/></div>
              <button className="link-button" onClick={()=>{try{const fixtureObj=JSON.parse(fixture);if(!fixtureObj||typeof fixtureObj!=='object'||Array.isArray(fixtureObj))throw Error('Fixture 必须是对象');update({fixture:fixtureObj});setError('')}catch(e){setError(String(e))}}}>将输入保存为节点 Fixture</button>
              <div className="mode-line"><label><input type="radio" checked={mode==='mock'} onChange={()=>setMode('mock')}/> Mock</label><label><input type="radio" checked={mode==='dry-run'} onChange={()=>setMode('dry-run')}/> Dry-run</label><label><input type="radio" checked={mode==='sandbox'} onChange={()=>setMode('sandbox')}/> Sandbox</label></div>
              <div className="row-actions"><button className="primary-button" onClick={()=>void runSelected()} disabled={busy||!selectedCapability}>{busy?'运行中…':selectedCapability?'试运行节点':'待实现 · 暂不可运行'}</button></div>
              {error&&<div className="notice notice-error">{error}</div>}
              {nodeResult&&<div className="result"><span className="result-head">运行结果 {nodeResult.simulated?'（仅 Mock）':''}</span><pre>{JSON.stringify(nodeResult.output??nodeResult.result??nodeResult,null,2)}</pre></div>}
            </div>}
            {tab==='trace'&&<div className="inspector-body"><div className="micro">执行记录区分真实运行、汇总与 Mock；Mock 只展示模拟结果。</div>{trace.length?trace.map((s,i)=><div className={`trace-step ${s.nodeId===selectedId?'highlight':''}`} key={i}><div className="trace-line"><b>{s.nodeId}</b><span>{s.status} · {s.derived?'根据实际运行汇总':`${s.elapsedMs}ms`} {s.adapter?`· ${s.adapter}`:''}</span></div>{!s.derived&&<details><summary>查看输入输出</summary><pre>{JSON.stringify({input:s.input,output:s.output},null,2)}</pre></details>}</div>):<div className="empty">运行已接入的功能或节点后，在这里查看执行记录。</div>}</div>}
            {tab==='code'&&<div className="inspector-body"><div className="property-section-title">实际能力与函数</div>{selectedCapability?<><div className="code-ref">{selectedCapability.id} · {selectedCapability.runPath}</div>{selectedCapability.implementation.map(reference=><div className="code-ref" key={`${reference.path}:${reference.symbol}`}><strong>{reference.symbol}</strong><br/>{reference.path}</div>)}<div className="code-ref">前端：{selectedCapability.frontend?`${selectedCapability.frontend.component} / ${selectedCapability.frontend.mode??'默认'}`:'待接入'}</div></>:<div className="capability-pending">此节点尚未绑定实际能力。</div>}<div className="property-section-title">节点定位</div><div className="code-ref">{selected.code||'尚未绑定实现位置'}</div><div className="code-ref">{selected.test||'尚未绑定测试位置'}</div>{source?<pre className="source">{source.excerpt}</pre>:<div className="empty">在需求关联中查看当前索引的代码与测试位置。</div>}</div>}
          </>}
        </section>
      </aside>
    </div>
    <footer className="footer"><span>Contract JSON 是意图；实际运行与测试才是证据。</span><span>需求追踪 · React Flow · Sphinx-Needs</span></footer>
  </div>;
}
export default function App(){
  const [catalog,setCatalog]=useState<FeatureCatalog|null>(null);
  const [error,setError]=useState('');
  const [alias,setAlias]=useState<string|null>(null);
  const [openRequest,setOpenRequest]=useState<OpenFeatureRequest>();
  useEffect(()=>{let live=true;void api<FeatureCatalog>('/api/features').then(data=>{if(live)setCatalog(data)}).catch(reason=>{if(live)setError(String(reason))});return()=>{live=false}},[]);
  const feature=catalog?resolveFeature(catalog,alias??new URLSearchParams(window.location.search).get('feature'),sessionStorage.getItem(workspaceKey)):undefined;
  const changeFeature=(next:string,mode?:string)=>{
    sessionStorage.setItem(workspaceKey,next);
    const url=new URL(window.location.href);
    if(url.searchParams.has('feature')){url.searchParams.set('feature',next);window.history.replaceState(null,'',url)}
    setAlias(next);setOpenRequest(mode?{mode,sequence:Date.now()}:undefined);
    if(mode)requestAnimationFrame(()=>document.getElementById('feature-outlet')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
  };
  if(error)return <main className="catalog-state" role="alert"><h1>工作区目录读取失败</h1><p>{error}</p><button className="primary-button" onClick={()=>window.location.reload()}>重新读取</button></main>;
  if(!catalog||!feature)return <main className="catalog-state" role="status">正在读取功能工作区…</main>;
  const client=featureClients[feature.frontend.entry];
  if(!client)return <main className="catalog-state" role="alert">前端入口 {feature.frontend.entry} 尚未注册。请添加对应 features/{feature.frontend.entry}/client.tsx。</main>;
  return <ReactFlowProvider key={feature.alias}><Studio feature={feature} catalog={catalog} client={client} onFeatureChange={changeFeature} openRequest={openRequest}/></ReactFlowProvider>;
}
