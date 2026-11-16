import { traceability, buildTraceabilityIndex, updateRequirement, updateGraph, sourceAt, isLocalRequest, isLocalWrite, TraceError } from './traceability.mjs';
import { openSource } from './editor.mjs';
import { indexedCapabilities, capabilityEvidence, runCapabilityTests } from './capabilities.mjs';

import { featureRegistry, featureCatalog, featureSource } from './feature-registry.mjs';
import { nodeContext } from './node-context.mjs';

function registeredFeature(value) {
  const feature=value==null?featureRegistry.defaultTrace:featureRegistry.resolveFeature(value);
  if(!feature)throw new TraceError('Unknown feature',404);
  return feature;
}

async function jsonBody(req, limit = 40_000) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw new Error('Payload too large');
  }
  return text ? JSON.parse(text) : {};
}
const reply = (res, status, value) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};

// Vite development/preview middleware, intentionally NO arbitrary code execution.
export async function api(req, res, next) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return next();
  try {
    if(req.method==='GET'&&url.pathname==='/api/features') {
      if(!isLocalRequest(req))return reply(res,403,{error:'Only same-origin local requests are allowed'});
      return reply(res,200,await featureCatalog());
    }
    if(req.method==='GET'&&url.pathname==='/api/node-context') {
      if(!isLocalRequest(req))return reply(res,403,{error:'Only same-origin local requests are allowed'});
      return reply(res,200,await nodeContext({featureId:registeredFeature(url.searchParams.get('feature')).id,nodeId:url.searchParams.get('nodeId')}));
    }
    if(req.method==='POST'&&url.pathname==='/api/node-context/preview') {
      if(!isLocalWrite(req))return reply(res,403,{error:'Only same-origin local JSON updates are allowed'});
      const body=await jsonBody(req,1_000_000);
      if(!body.graph)throw new TraceError('缺少预览功能图');
      return reply(res,200,await nodeContext({featureId:registeredFeature(body.featureId).id,nodeId:body.nodeId,graph:body.graph}));
    }
    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      if (!isLocalRequest(req)) return reply(res, 403, {error:'Only same-origin local requests are allowed'});
      return reply(res, 200, {capabilities:await indexedCapabilities()});
    }
    if (req.method === 'GET' && url.pathname === '/api/capabilities/evidence') {
      if (!isLocalRequest(req)) return reply(res, 403, {error:'Only same-origin local requests are allowed'});
      return reply(res, 200, await capabilityEvidence(url.searchParams.get('capabilityId')));
    }
    if (req.method === 'POST' && url.pathname === '/api/capabilities/test') {
      if (!isLocalWrite(req)) return reply(res, 403, {error:'Only same-origin local JSON updates are allowed'});
      const body = await jsonBody(req);
      return reply(res, 200, await runCapabilityTests(body.capabilityId));
    }
    if (req.method === 'POST' && url.pathname === '/api/traceability/build') {
      if (!isLocalWrite(req)) return reply(res, 403, {error:'Only same-origin local JSON updates are allowed'});
      const body = await jsonBody(req);
      if(body.featureId)body.featureId=registeredFeature(body.featureId).id;
      return reply(res,200,await buildTraceabilityIndex(undefined,body.featureId));
    }
    if (req.method === 'GET' && (url.pathname === '/api/traceability' || url.pathname === '/api/traceability/source')) {
      if (!isLocalRequest(req)) return reply(res, 403, {error: 'Only same-origin local requests are allowed'});
      if (url.pathname === '/api/traceability') {
        const feature=url.searchParams.get('feature');
        return reply(res,200,await traceability(undefined,feature?registeredFeature(feature).id:undefined));
      }
      return reply(res, 200, await sourceAt(url.searchParams.get('path'), Number(url.searchParams.get('line'))));
    }
    if (req.method === 'POST' && url.pathname === '/api/open-source') {
      if (!isLocalWrite(req) || !req.headers.origin) return reply(res, 403, {error: '仅允许本机同源页面打开编辑器'});
      return reply(res, 200, await openSource(await jsonBody(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/traceability/requirement') {
      if (!isLocalWrite(req)) return reply(res, 403, {error: 'Only same-origin local JSON updates are allowed'});
      const body=await jsonBody(req);if(body.featureId)body.featureId=registeredFeature(body.featureId).id;
      return reply(res, 200, await updateRequirement(body));
    }
    if (req.method === 'POST' && url.pathname === '/api/traceability/graph') {
      if (!isLocalWrite(req)) return reply(res, 403, {error: 'Only same-origin local JSON updates are allowed'});
      const body=await jsonBody(req,1_000_000);if(body.featureId)body.featureId=registeredFeature(body.featureId).id;
      return reply(res, 200, await updateGraph(body));
    }
    if(req.method==='GET'&&url.pathname==='/api/code') {
      const source=await featureSource(url.searchParams.get('nodeId'),url);
      return reply(res,source?200:404,source??{error:'Unbound code'});
    }
    const route=featureRegistry.route(req.method,url.pathname);
    if(route)return reply(res,200,await route.handle(req.method==='GET'?undefined:await jsonBody(req),url));
    return reply(res, 404, { error: 'Unknown API' });
  } catch (e) {
    return reply(res, e instanceof TraceError ? e.status : 400, { error: e instanceof Error ? e.message : String(e) });
  }
}
