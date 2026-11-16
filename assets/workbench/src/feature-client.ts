import type { ComponentType } from 'react';
import type { Graph, Run, Spec } from './workbench-types';
import type { Capability } from './CapabilityPanel';

export type FeatureDefinition = {
  id:string;alias:string;title:string;rootNodeId:string;defaultSelected:string;
  graphFile:string;requirementFile:string;rstFile:string;graph:Graph;
  frontend:{entry:string;mode:string;component:string;path:string};
  draftKeys:{graph:string;base:string;pending:string;requirements:string};
};
export type FeatureCatalog={defaultFeature:string;features:FeatureDefinition[];capabilities:Capability[]};
export type OpenFeatureRequest={mode?:string;sequence:number};
export type FeaturePanelProps={
  feature:FeatureDefinition;onRun:(run:Run)=>void;openRequest?:OpenFeatureRequest;
  runtimeOptions:Record<string,unknown>;onRuntimeOptionsChange:(options:Record<string,unknown>)=>void;
};
export type GraphLayout={offsets:Map<string,{x:number;y:number}>;sizes:Map<string,{width:number;height:number}>};
export type FeatureClient={
  Panel:ComponentType<FeaturePanelProps>;
  initialCollapsed?:(feature:FeatureDefinition)=>string[];
  layout?:(graph:Graph,collapsed:Set<string>,seed:Graph)=>GraphLayout;
  nodeAnnotation?:(node:Spec,options:Record<string,unknown>)=>string|undefined;
  sourcePath?:(node:Spec,options:Record<string,unknown>)=>string|undefined;
};

// Only local build-time modules are executable. Catalog metadata selects an entry, never a URL.
const modules=import.meta.glob<FeatureClient>('../features/*/client.tsx',{eager:true,import:'default'});
export const featureClients:Readonly<Record<string,FeatureClient>>=Object.fromEntries(
  Object.entries(modules).map(([path,client])=>[path.split('/').at(-2)!,client])
);
