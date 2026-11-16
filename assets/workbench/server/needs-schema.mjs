import fs from 'node:fs/promises';
import path from 'node:path';

// This is the internal protocol, independent of a project's authored option
// names. Loading it from project configuration would change the target schema
// on restart and make normalization interpret its own output incorrectly.
export const defaultMappingRules={
  type:'spec',feature:'feature_id',id:'node_id',properties:'node_properties',edges:'node_edges',
  fields:{title:'title',description:'content',importance:'importance'},
  links:{requirements:'fulfills',children:'contains',parent:'parent_spec',flow:'flows_to'},
  defaults:{kind:'logic',importance:'normal',input:'',output:''}
};

export async function mappingRules(root) {
  try { return JSON.parse(await fs.readFile(path.join(root,'traceability/node-mapping.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT')return defaultMappingRules;throw error; }
}

export function nodeProperties(node) {
  const {id,title,parentId,position,size,code,test,needId,properties:ignored,...properties}=node;
  return properties;
}

const canonicalLinks={requirements:'fulfills',children:'contains',parent:'parent_spec',flow:'flows_to'};
// Keep the authored record available across repeated in-process normalization.
// It is not serialized into the index or the public view; writes use the raw index.
const authored=Symbol('authored need');

export function normalizeNeeds(needs,rules=defaultMappingRules) {
  if(['req','test','impl'].includes(rules.type))throw new Error('节点映射类型不能占用 req、test 或 impl');
  return Object.fromEntries(Object.entries(needs).map(([id,item])=>{
    const need=item[authored]??item;
    // Generated JSON bridges already speak the internal schema, even when a
    // project chooses other option names for its authored specifications.
    const generated=Boolean(need.contract_source);
    const mapping=generated?defaultMappingRules:rules;
    if(need.type!==mapping.type) {
      if(!generated&&need.type==='spec') {
        // "spec" is reserved for selected nodes in the canonical read model.
        // Retain an unselected authored need without granting node identity.
        const excluded={...need,type:'unmapped-spec',source_type:need.type};
        Object.defineProperty(excluded,authored,{value:need});
        return [id,excluded];
      }
      return [id,need];
    }
    // A generated body contains a literal source snapshot, including layout.
    // Its behavior description lives exclusively in node_properties.
    const fields=Object.fromEntries(Object.entries(mapping.fields).filter(([property,field])=>need[field]!=null&&!(generated&&property==='description')).map(([property,field])=>[property,need[field]]));
    const raw=need[mapping.properties];
    const properties=nodeProperties({...mapping.defaults,...fields,...(typeof raw==='string'?JSON.parse(raw||'{}'):raw??{})});
    const normalized={...need,type:'spec',
      feature_id:need[mapping.feature],node_id:need[mapping.id],node_edges:need[mapping.edges],
      title:fields.title??need.title,content:generated?(properties.description??''):(fields.description??need.content),
      importance:properties.importance,
      node_properties:JSON.stringify(properties),
      ...Object.fromEntries(Object.entries(canonicalLinks).map(([link,canonical])=>[canonical,need[mapping.links[link]]??[]]))};
    Object.defineProperty(normalized,authored,{value:need});
    return [id,normalized];
  }));
}
