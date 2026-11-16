export class ApiError extends Error{constructor(message:string,readonly status:number){super(message)}}
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const r=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json(); if(!r.ok)throw new ApiError(d.error||`HTTP ${r.status}`,r.status);return d as T;
}
