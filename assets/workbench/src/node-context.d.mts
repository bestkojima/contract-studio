import type { Importance } from './node-importance.mjs';
type ContextNode = {
  id:string; parentId:string|null; title:string; kind:string; description:string;
  input:string; output:string; inputSchema?:Record<string,unknown>; outputSchema?:Record<string,unknown>; importance?:Importance;
};
type ContextEdge = {id:string;source:string;target:string;sourceHandle?:string;targetHandle?:string;label:string};
export function describeNodeContext(graph:{nodes:ContextNode[];edges:ContextEdge[]},nodeId:string):string;
