import type { Graph } from './workbench-types';
export function graphFocus(graph:Graph,nodeId:string):{ids:Set<string>;positions:Map<string,{x:number;y:number}>;ancestors:{id:string;title:string}[]};
