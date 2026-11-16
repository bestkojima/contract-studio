import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import project from '../features/project/server.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Add a reviewed feature bundle here. Neither graph data nor HTTP can add handlers.
export function createFeatureRegistry(bundles) {
  const features=bundles.flatMap(bundle=>bundle.features??[]);
  const capabilities=bundles.flatMap(bundle=>bundle.capabilities??[]);
  const routes=bundles.flatMap(bundle=>bundle.routes??[]);
  const trials=bundles.flatMap(bundle=>bundle.trials??[]);
  const unique=(items,key,label)=>{
    const seen=new Set();
    for(const item of items){const value=key(item);if(!value||seen.has(value))throw Error(`Duplicate or missing ${label}: ${value}`);seen.add(value);}
  };
  unique(features,item=>item.id,'feature ID');unique(features,item=>item.alias,'feature alias');
  unique(capabilities,item=>item.id,'capability ID');unique(routes,item=>`${item.method} ${item.path}`,'route');
  const resolveFeature=value=>features.find(feature=>feature.id===value||feature.alias===value);
  for(const feature of features)for(const source of feature.requirementSources??[])if(!resolveFeature(source))throw Error(`Unknown requirement source: ${source}`);
  for(const cap of capabilities){
    if(!routes.some(route=>route.path===cap.runPath&&route.method==='POST')||!routes.some(route=>route.path===cap.testPath&&route.method==='POST'))throw Error(`Missing trusted routes: ${cap.id}`);
    if(cap.frontend&&!resolveFeature(cap.frontend.feature))throw Error(`Unknown frontend feature: ${cap.id}`);
  }
  return {
    features,capabilities,resolveFeature,
    trials,
    defaultFeature:features.find(feature=>feature.defaultUi)??features[0],
    defaultTrace:features.find(feature=>feature.defaultTrace)??features[0],
    route:(method,url)=>routes.find(route=>route.method===method&&route.path===url),
    sourceOverride(nodeId,url){
      for(const bundle of bundles){const override=bundle.codeOverride?.(nodeId,url);if(override!==undefined)return override;}
      return undefined;
    }
  };
}

export const featureRegistry=createFeatureRegistry([project]);

export async function featureCatalog(root=projectRoot) {
  const {openTraceability}=await import('./traceability.mjs');
  const project=await openTraceability(root);
  return {
    defaultFeature:featureRegistry.defaultFeature.alias,
    features:await Promise.all(featureRegistry.features.map(async feature=>({...structuredClone(feature),graph:await project.graph(feature)}))),
    capabilities:project.capabilities()
  };
}

export async function featureSource(nodeId,url,root=projectRoot) {
  const override=featureRegistry.sourceOverride(nodeId,url);
  if(override!==undefined){
    if(!override)return null;
    const source=await fs.readFile(override.absoluteFile,'utf8');
    return {symbol:override.symbol,file:path.relative(root,override.absoluteFile).replaceAll('\\','/'),excerpt:source.slice(0,6000)};
  }
  if(typeof nodeId!=='string'||!nodeId)return null;
  const {openTraceability}=await import('./traceability.mjs');
  return (await openTraceability(root)).source({nodeId});
}
