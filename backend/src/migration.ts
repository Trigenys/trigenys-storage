/**
 * Cloudinary->R2 historical image migration, invoked only by scheduled().
 * D1 owns the candidate allowlist. This code never changes Xeption URLs.
 */
import type { Env } from "./worker.ts";

type Policy={cloud:string;prefix:string};
type Job={id:string;tenant:string;folder:string;source_url:string;media_id:string};
export type MigrationSummary={enabled:boolean;copied:number;dead:number;failed:number;blocked:number};
const MAX_BYTES=8*1024*1024;
const BATCH=5;

export function normalizedCloudinarySource(original:string, policy:Policy):string|null {
  if (!/^[a-z0-9_-]{2,70}$/.test(policy.cloud)||!/^[a-z][a-z0-9_-]{0,69}$/.test(policy.prefix)) return null;
  try {
    const u=new URL(original);
    if (u.protocol!=="https:"||u.hostname!=="res.cloudinary.com"||u.port||u.username||u.password
      ||u.search||u.hash||original.includes("%")||original.includes("\\")) return null;
    const re=new RegExp("^/"+policy.cloud+"/image/upload/((?:v[0-9]+/)?"+policy.prefix+"/[A-Za-z0-9_./-]+\\.(?:jpg|jpeg|png|webp))$","i");
    const m=re.exec(u.pathname);
    if (!m||m[1].split("/").some(p=>p==="."||p==="..")) return null;
    return "https://res.cloudinary.com/"+policy.cloud+"/image/upload/f_webp,q_85,w_2048,c_limit/"+m[1];
  } catch{return null;}
}
function policies(env:Env):Record<string,Policy>{
  try { const p:unknown=JSON.parse(env.MIGRATION_SOURCES_JSON||"{}");
    return p && typeof p==="object" && !Array.isArray(p)?p as Record<string,Policy>:{};
  } catch{return {};}
}
function isWebP(b:Uint8Array):boolean{
  if(b.length<16)return false;
  const has=(o:number,s:string)=>[...s].every((ch,i)=>b[o+i]===ch.charCodeAt(0));
  return has(0,"RIFF")&&has(8,"WEBP")&&(has(12,"VP8 ")||has(12,"VP8L")||has(12,"VP8X"))
    &&((b[4]|b[5]<<8|b[6]<<16|b[7]<<24)>>>0)===b.length-8;
}
async function getWebP(url:string,fn:typeof fetch):Promise<ArrayBuffer>{
  const response=await fn(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(20000),headers:{accept:"image/webp"}});
  if(response.status===404||response.status===410)throw Error("SOURCE_GONE");
  if([401,403,429].includes(response.status))throw Error("SOURCE_BLOCKED");
  if(!response.ok)throw Error("SOURCE_UNAVAILABLE");
  if(!(response.headers.get("content-type")||"").toLowerCase().startsWith("image/webp"))throw Error("INVALID_CONTENT_TYPE");
  if(Number(response.headers.get("content-length")||0)>MAX_BYTES)throw Error("SOURCE_OVERSIZED");
  if(!response.body)throw Error("SOURCE_EMPTY");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let count=0;
  try {for(;;){const r=await reader.read();if(r.done)break;
      count+=r.value.byteLength;
      if(count>MAX_BYTES){await reader.cancel().catch(()=>{});throw Error("SOURCE_OVERSIZED");}
      chunks.push(r.value);
    }}finally{reader.releaseLock();}
  const out=new Uint8Array(count);let offset=0;
  for(const c of chunks){out.set(c,offset);offset+=c.byteLength;}
  if(!isWebP(out))throw Error("INVALID_WEBP");
  return out.buffer as ArrayBuffer;
}
async function record(env:Env,job:Job,state:string,reason:string|null=null){
  await env.DB.prepare("UPDATE media_migrations SET status=?, last_error=?, updated_at=datetime('now'),copied_at=CASE WHEN ?='copied' THEN datetime('now') ELSE copied_at END WHERE id=? AND status='processing'")
    .bind(state,reason,state,job.id).run();
}
async function migrateOne(env:Env,job:Job,fetcher:typeof fetch):Promise<"copied"|"dead"|"failed"|"blocked">{
  try {
    const p=policies(env)[job.tenant];
    const url=p && normalizedCloudinarySource(job.source_url,p);
    if(!url||!/^[a-z][a-z0-9-]{1,39}$/.test(job.tenant)
      ||!/^[a-z][a-z0-9-]{0,39}$/.test(job.folder)
      ||!/^[0-9a-f-]{36}$/i.test(job.media_id))throw Error("INVALID_SOURCE");
    const key="tenants/"+job.tenant+"/"+job.folder+"/"+job.media_id+".webp";
    const current=await env.DB.prepare("SELECT object_key,status FROM media WHERE id=? AND tenant=?")
      .bind(job.media_id,job.tenant).first<{object_key:string;status:string}>();
    if(current && current.object_key!==key)throw Error("DESTINATION_CONFLICT");
    if(current?.status==="ready"){
      if(!await env.MEDIA_BUCKET.get(key))throw Error("DESTINATION_MISSING");
      await record(env,job,"copied");return "copied";
    }
    const bytes=await getWebP(url,fetcher);
    await env.DB.prepare("INSERT OR IGNORE INTO media(id,tenant,folder,object_key,status,visibility,content_type,size_bytes,created_at) VALUES(?,?,?,?,'pending','public','image/webp',?,datetime('now'))")
      .bind(job.media_id,job.tenant,job.folder,key,bytes.byteLength).run();
    await env.MEDIA_BUCKET.put(key,bytes,{httpMetadata:{contentType:"image/webp"}});
    const saved=await env.MEDIA_BUCKET.get(key);
    if(!saved||(saved.size!==undefined&&saved.size!==bytes.byteLength))throw Error("DESTINATION_INVALID");
    const final=await env.DB.prepare("UPDATE media SET status='ready',size_bytes=? WHERE id=? AND tenant=? AND status='pending'")
      .bind(bytes.byteLength,job.media_id,job.tenant).run();
    if(final.meta?.changes!==1)throw Error("REGISTRY_CONFLICT");
    await record(env,job,"copied");return "copied";
  }catch(e){
    const err=e instanceof Error?e.message:"MIGRATION_ERROR";
    const known=["SOURCE_GONE","SOURCE_BLOCKED","SOURCE_UNAVAILABLE","SOURCE_OVERSIZED","SOURCE_EMPTY",
      "INVALID_CONTENT_TYPE","INVALID_WEBP","INVALID_SOURCE","DESTINATION_CONFLICT","DESTINATION_MISSING",
      "DESTINATION_INVALID","REGISTRY_CONFLICT"];
    const safe=known.includes(err)?err:"MIGRATION_ERROR";
    const state=safe==="SOURCE_GONE"?"dead":safe==="SOURCE_BLOCKED"?"blocked":"failed";
    await record(env,job,state,safe);
    return state;
  }
}
export async function runMigrationBatch(env:Env,fetcher:typeof fetch=fetch):Promise<MigrationSummary>{
  const summary:MigrationSummary={enabled:env.MIGRATION_ENABLED==="true",copied:0,dead:0,failed:0,blocked:0};
  if(!summary.enabled)return summary;
  await env.DB.prepare("UPDATE media_migrations SET status='pending',updated_at=datetime('now') WHERE status='processing' AND updated_at < datetime('now','-30 minutes') AND attempts<3").run();
  for(let i=0;i<BATCH;i++){
    const job=await env.DB.prepare("SELECT id,tenant,folder,source_url,media_id FROM media_migrations WHERE status='pending' AND attempts<3 ORDER BY created_at,id LIMIT 1").first<Job>();
    if(!job)break;
    const claim=await env.DB.prepare("UPDATE media_migrations SET status='processing',attempts=attempts+1,updated_at=datetime('now') WHERE id=? AND status='pending'")
      .bind(job.id).run();
    if(claim.meta?.changes!==1)continue;
    const result=await migrateOne(env,job,fetcher);
    summary[result]++;
    if(result==="blocked")break;
  }
  return summary;
}
