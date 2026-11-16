import { useState } from 'react';
import { importanceLabels, nodeImportance, type Importance } from './node-importance.mjs';

export type PropertyNode = {
  id:string; title:string; parentId:string|null; kind:'group'|'ui'|'logic'|'async'|'action'; importance?:Importance;
  description:string; input:string; output:string; processing?:string; acceptance?:string;
  errors:string[]; inputSchema?:Record<string,unknown>; outputSchema?:Record<string,unknown>;
  capabilityId?:string; position:{x:number;y:number}; size?:{width:number;height:number};
};
type CapabilityChoice = {id:string;title:string;nodeIds:string[]};
const kinds = {group:'功能组',ui:'界面',logic:'处理步骤',async:'异步处理',action:'写入操作'} as const;

function SchemaField({label,value,onChange}:{label:string;value?:Record<string,unknown>;onChange:(schema:Record<string,unknown>|undefined)=>void}) {
  const [text,setText] = useState(value ? JSON.stringify(value,null,2) : '');
  const [error,setError] = useState('');
  const change = (next:string) => {
    setText(next);
    try {
      const parsed:unknown=next.trim()?JSON.parse(next):undefined;
      if(parsed!==undefined&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))throw Error('结构定义需为 JSON 对象');
      setError('');onChange(parsed as Record<string,unknown>|undefined);
    } catch { setError('JSON 尚未完整，结构定义未应用。'); }
  };
  return <div className="field"><label>{label}<textarea aria-label={label} className="json-area" rows={5} value={text} onChange={event=>change(event.target.value)} aria-invalid={!!error} spellCheck={false} placeholder={'{"type":"object","properties":{}}'}/></label>{error&&<span className="field-error" role="status">{error}</span>}</div>;
}

export function NodeProperties({node,nodes,capabilities,onPatch,onSave,saving,canSave,onRemove}:{
  node:PropertyNode;nodes:PropertyNode[];capabilities:CapabilityChoice[];
  onPatch:(patch:Partial<PropertyNode>)=>void;onSave:()=>void;saving:boolean;canSave:boolean;onRemove?:()=>void;
}) {
  const descendants = new Set([node.id]);
  let changed=true;
  while(changed){changed=false;for(const item of nodes)if(item.parentId&&descendants.has(item.parentId)&&!descendants.has(item.id)){descendants.add(item.id);changed=true}}
  const parents=nodes.filter(item=>item.kind==='group'&&!descendants.has(item.id));
  const hasChildren=nodes.some(item=>item.parentId===node.id);
  const registered=capabilities.find(cap=>cap.nodeIds.includes(node.id));
  return <div className="inspector-body node-properties">
    <div className="property-section-title">身份与结构 <code>{node.id}</code></div>
    <div className="field"><label htmlFor="node-title">节点名称</label><input id="node-title" value={node.title} onChange={event=>onPatch({title:event.target.value})}/></div>
    <div className="property-grid">
      <div className="field"><label htmlFor="node-kind">节点类型</label><select id="node-kind" value={node.kind} onChange={event=>{const kind=event.target.value as PropertyNode['kind'];onPatch({kind,...(kind==='group'&&!node.size?{size:{width:970,height:415}}:{})})}}>{Object.entries(kinds).map(([id,title])=><option key={id} value={id} disabled={hasChildren&&id!=='group'}>{title}</option>)}</select></div>
      <div className="field"><label htmlFor="node-parent">所属功能组</label><select id="node-parent" value={node.parentId??''} disabled={!node.parentId} onChange={event=>onPatch({parentId:event.target.value,position:{x:35,y:90}})}>{!node.parentId&&<option value="">项目根节点</option>}{parents.map(parent=><option key={parent.id} value={parent.id}>{parent.title}</option>)}</select></div>
    </div>
    <div className="field"><label htmlFor="node-importance">逻辑重要性</label><select id="node-importance" className={`importance-select importance-${nodeImportance(node.importance)}`} value={nodeImportance(node.importance)} onChange={event=>onPatch({importance:nodeImportance(event.target.value)})}>{Object.entries(importanceLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
    <div className="property-section-title">行为契约</div>
    <div className="field"><label htmlFor="node-description">职责与描述</label><textarea id="node-description" rows={3} value={node.description} onChange={event=>onPatch({description:event.target.value})}/></div>
    <div className="field"><label htmlFor="node-input">输入</label><input id="node-input" value={node.input} onChange={event=>onPatch({input:event.target.value})}/></div>
    <div className="field"><label htmlFor="node-processing">处理规则</label><textarea id="node-processing" rows={2} value={node.processing??''} onChange={event=>onPatch({processing:event.target.value})}/></div>
    <div className="field"><label htmlFor="node-output">输出</label><input id="node-output" value={node.output} onChange={event=>onPatch({output:event.target.value})}/></div>
    <div className="field"><label htmlFor="node-errors">异常及反馈（每行一项）</label><textarea id="node-errors" rows={2} value={node.errors.join('\n')} onChange={event=>onPatch({errors:event.target.value.split('\n')})}/></div>
    <div className="field"><label htmlFor="node-acceptance">节点验收说明</label><textarea id="node-acceptance" rows={3} value={node.acceptance??''} onChange={event=>onPatch({acceptance:event.target.value})}/></div>
    <details className="contract-editor"><summary>结构化输入与输出</summary><SchemaField label="输入结构 JSON" value={node.inputSchema} onChange={inputSchema=>onPatch({inputSchema})}/><SchemaField label="输出结构 JSON" value={node.outputSchema} onChange={outputSchema=>onPatch({outputSchema})}/></details>
    <div className="field"><label htmlFor="node-capability">实际运行能力</label><select id="node-capability" value={node.capabilityId??''} onChange={event=>onPatch({capabilityId:event.target.value||undefined})}><option value="">{registered?`使用项目绑定：${registered.title}`:'待实现 · 尚未绑定'}</option>{capabilities.map(cap=><option key={cap.id} value={cap.id}>{cap.title}</option>)}</select></div>
    <div className="property-save"><span>浏览器草稿</span><button className="primary-button" disabled={!canSave||saving} onClick={onSave}>{saving?'保存中…':'保存到项目'}</button>{onRemove&&<button className="link-button danger-link" onClick={onRemove}>删除节点</button>}</div>
  </div>;
}
