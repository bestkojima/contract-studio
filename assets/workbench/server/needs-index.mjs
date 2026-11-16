import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = 'traceability/_build/needs/needs.json';
const statePath = 'traceability/_build/needs/index-state.json';
const projectsPath = 'traceability/_build/needs/source-projects.json';
const entitiesPath = 'traceability/_build/needs/code-entities.json';
const sourceExtensions = new Set(['.mjs','.js','.ts','.tsx','.cpp','.py','.go','.java','.php','.cs','.rs']);
const buildJobs = new Map();
const exists = async file => { try { return (await fs.stat(file)).isFile(); } catch (e) { if(e.code==='ENOENT')return false; throw e; } };
export const indexConfigured = root => exists(path.join(root, 'traceability/conf.py'));

// Size and modification time describe the inspected source revision; no content hashes.
export async function sourceRevision(root) {
  const files = {};
  async function walk(relative) {
    let entries; try { entries=await fs.readdir(path.join(root,relative),{withFileTypes:true}); } catch(e) { if(e.code==='ENOENT')return; throw e; }
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.name==='_build'||entry.name==='__pycache__'||entry.name==='node_modules')continue;
      const name=`${relative}/${entry.name}`;
      if(entry.isDirectory())await walk(name);
      else if(entry.isFile()&&(sourceExtensions.has(path.extname(name))||['.json','.rst','.toml'].includes(path.extname(name)))) {
        const stat=await fs.stat(path.join(root,name));files[name]={size:stat.size,mtimeMs:stat.mtimeMs};
      }
    }
  }
  for(const dir of ['contracts','src','server','features','tests','traceability'])await walk(dir);
  for(const file of ['pyproject.toml','uv.lock','scripts/build-needs.py'])if(await exists(path.join(root,file))){const stat=await fs.stat(path.join(root,file));files[file]={size:stat.size,mtimeMs:stat.mtimeMs};}
  return files;
}

async function jsonAt(root, file) { try{return JSON.parse(await fs.readFile(path.join(root,file),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;} }
async function writeJson(root,file,value) {
  const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});
  const temp=`${target}.${process.pid}.tmp`;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,target);
}

export async function localMarkerReferences(root, extensions = sourceExtensions) {
  const refs = new Map();
  async function scan(relative) {
    let entries;try{entries=await fs.readdir(path.join(root,relative),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const item of entries){const name=`${relative}/${item.name}`;
      if(item.isDirectory()){if(item.name!=='_build')await scan(name);continue;}
      if(!item.isFile()||!extensions.has(path.extname(name)))continue;
      const lines=(await fs.readFile(path.join(root,name),'utf8')).split(/\r?\n/);
      lines.forEach((line,i)=>{const match=line.match(/^\s*(?:\/\/|#)\s*@need-ids:\s*([A-Za-z0-9_,\s-]+)$/);if(!match)return;
        for(const id of match[1].split(',').map(s=>s.trim()).filter(Boolean)){if(!refs.has(id))refs.set(id,[]);refs.get(id).push({path:name,line:i+1});}
      });
    }
  }
  for(const dir of ['src','server','features','tests'])await scan(dir);
  return refs;
}

export async function normalizeCodeUrl(root, url, aliases = {}) {
  if(typeof url!=='string')return null;
  const match=url.match(/^([^?#]+)#L([1-9]\d*)$/);if(!match)return null;
  let name;try{name=decodeURIComponent(match[1]).replaceAll('\\','/');}catch{return null;}
  if(name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))return null;
  const prefix=name.split('/')[0];
  if(Object.hasOwn(aliases,prefix))name=aliases[prefix]+name.slice(prefix.length);
  const absolute=path.resolve(root,name),relative=path.relative(root,absolute);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!sourceExtensions.has(path.extname(relative)))return null;
  try{
    const [realRoot,realFile]=await Promise.all([fs.realpath(root),fs.realpath(absolute)]);
    const realRelative=path.relative(realRoot,realFile);if(realRelative.startsWith('..')||path.isAbsolute(realRelative))return null;
    const lines=(await fs.readFile(realFile,'utf8')).split(/\r?\n/);const line=Number(match[2]);if(line>lines.length)return null;
    return {path:relative.replaceAll('\\','/'),line,source:'sphinx-codelinks'};
  }catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
}

export async function readNeedsIndex(root) {
  if(!await indexConfigured(root))return {index:{state:'unconfigured',source:'local-marker',path:null,message:'此项目未配置 Sphinx；使用原有本地标记索引。'},needs:{},refs:await localMarkerReferences(root),entities:[]};
  const revision=await sourceRevision(root);
  let saved,artifact,aliases,entityArtifact;
  try{[saved,artifact,aliases,entityArtifact]=await Promise.all([jsonAt(root,statePath),jsonAt(root,indexPath),jsonAt(root,projectsPath),jsonAt(root,entitiesPath)]);}catch(e){return {index:{state:'failed',source:'sphinx-needs+codelinks',path:indexPath,error:`索引文件无法读取：${e.message}`,sourceRevision:revision},needs:{},refs:new Map(),entities:[]};}
  const state=saved?.state==='failed'?'failed':!artifact?'missing':saved?.sourceRevision&&isDeepStrictEqual(saved.sourceRevision,revision)?'current':'stale';
  const index={state,source:'sphinx-needs+codelinks',path:indexPath,builtAt:saved?.builtAt??artifact?.created??null,error:saved?.state==='failed'?saved.error:undefined,sourceRevision:saved?.sourceRevision??null};
  const needs=artifact?.versions?.[artifact.current_version]?.needs??{};
  const entities=(entityArtifact?.schemaVersion===1&&Array.isArray(entityArtifact.entities)?entityArtifact.entities:[]).map(entity=>({...entity,indexState:state}));
  const scopeOf=entity=>Object.fromEntries(['symbol','signature','startLine','endLine','kind','language'].map(key=>[key,entity[key]]));
  const refs=new Map();
  for(const [id,need] of Object.entries(needs)){
    const references=[];
    for(const url of Array.isArray(need.code_url)?need.code_url:[]){
      const ref=await normalizeCodeUrl(root,url,aliases??{});
      if(ref&&!references.some(x=>x.path===ref.path&&x.line===ref.line)) {
        const line=(await fs.readFile(path.join(root,ref.path),'utf8')).split(/\r?\n/)[ref.line-1];
        const marker=line.match(/^\s*(?:\/\/|#)\s*@need-ids:\s*([A-Za-z0-9_,\s-]+)$/);
        // A stale line must never open an unrelated function after source edits.
        if(marker?.[1].split(',').map(value=>value.trim()).includes(id)){
          const entity=state==='current'?entities.find(item=>item.path===ref.path&&item.markerLines.includes(ref.line)&&item.needIds.includes(id)):null;
          const scope=entity?scopeOf(entity):null;
          references.push({...ref,indexState:state,...(scope?{scope}:{})});
        }
      }
    }
    for(const entity of entities){
      // Native declarations use CodeLinks' accepted source-page records, not a
      // second comment parser or a guess based on local-url/Git-root prefixes.
      // After edits, only a file from the successful source revision may retain
      // its old marker location; scope identity requires a current whole index.
      if(!saved?.sourceRevision?.[entity.path]||!isDeepStrictEqual(saved.sourceRevision[entity.path],revision[entity.path]))continue;
      for(const declaration of entity.declarations??[]){
        if(declaration.needId!==id)continue;
        const ref=await normalizeCodeUrl(root,`${entity.path}#L${declaration.line}`);
        if(ref&&!references.some(item=>item.path===ref.path&&item.line===ref.line))references.push({...ref,indexState:state,...(state==='current'?{scope:scopeOf(entity)}:{})});
      }
    }
    refs.set(id,references);
  }
  return {index,needs,refs,entities};
}

function execute(python,args,root) {
  return new Promise((resolve,reject)=>execFile(python,args,{cwd:root,windowsHide:true,timeout:120_000,maxBuffer:1_000_000},(error,stdout,stderr)=>{
    if(error)reject(new Error(`${error.code==='ENOENT'?'未找到项目 Python 环境，请先运行 uv sync。':`Sphinx 构建失败 (${error.signal??error.code})`}\n${stderr||stdout}`.slice(-12000)));
    else resolve({stdout,stderr});
  }));
}

export async function buildNeedsIndex(root, {python,runner=execute} = {}) {
  if(!await indexConfigured(root))return (await readNeedsIndex(root)).index;
  if(buildJobs.has(root))return buildJobs.get(root);
  const job=(async()=>{
    const previous=await jsonAt(root,statePath).catch(()=>null);
    const revision=await sourceRevision(root);
    const candidate=path.join(root,'traceability/_build/needs-candidate');
    try{
      const executable=python??path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
      await runner(executable,[path.join(ownRoot,'scripts/build-needs.py'),path.join(root,'traceability'),candidate],root);
      const artifact=JSON.parse(await fs.readFile(path.join(candidate,'needs.json'),'utf8'));
      if(!artifact.versions?.[artifact.current_version]?.needs)throw Error('Sphinx 未生成有效 needs.json');
      const aliases=JSON.parse(await fs.readFile(path.join(candidate,'source-projects.json'),'utf8'));
      const entities=JSON.parse(await fs.readFile(path.join(candidate,'code-entities.json'),'utf8'));
      if(entities.schemaVersion!==1||!Array.isArray(entities.entities))throw Error('CodeLinks 未生成有效 code-entities.json');
      await writeJson(root,indexPath,artifact);await writeJson(root,projectsPath,aliases);await writeJson(root,entitiesPath,entities);
      const state={state:'current',builtAt:new Date().toISOString(),sourceRevision:revision,creator:artifact.versions[artifact.current_version].creator};
      await writeJson(root,statePath,state);
    }catch(error){await writeJson(root,statePath,{...previous,state:'failed',attemptedAt:new Date().toISOString(),error:error.message});}
    return (await readNeedsIndex(root)).index;
  })().finally(()=>buildJobs.delete(root));
  buildJobs.set(root,job);return job;
}
