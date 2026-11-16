import type { Importance } from './node-importance.mjs';
export type Kind = 'group' | 'ui' | 'logic' | 'async' | 'action';
export type Spec = {
  id:string; parentId:string|null; title:string; kind:Kind; description:string; importance?:Importance;
  position:{x:number;y:number}; size?:{width:number;height:number};
  input:string;output:string;errors:string[];fixture:Record<string,unknown>;code:string;test:string;processing?:string;acceptance?:string;inputSchema?:Record<string,unknown>;outputSchema?:Record<string,unknown>;capabilityId?:string;
};
export type Link = {id:string;source:string;target:string;sourceHandle?:string;targetHandle?:string;label:string};
export type Graph={version:number;feature:{id:string;title:string;goal:string};nodes:Spec[];edges:Link[]};
export type Step={nodeId:string;input:unknown;output:unknown;elapsedMs:number;status:'ok'|'rejected'|'mock';adapter?:string;derived?:boolean};
export type Run={runId?:string;mode?:string;trace?:Step[];result?:Record<string,unknown>;ui?:{tone:string;message:string};nodeId?:string;output?:unknown;simulated?:boolean;elapsedMs?:number;error?:string};
