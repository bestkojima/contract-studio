import type { Graph } from './workbench-types';
export function sameValue(left:unknown,right:unknown):boolean;
export function sameGraph(left:Graph,right:Graph):boolean;
export function reconcileGraphSave(current:Graph,submitted:Graph,canonical:Graph):Graph;
