import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizedCloudinarySource, runMigrationBatch } from "../src/migration.ts";
import type { Env } from "../src/worker.ts";
const policy={cloud:"dli0kdkg9",prefix:"xeption"};
const sample="https://res.cloudinary.com/dli0kdkg9/image/upload/v1781204553/xeption/photo-1.jpg";
test("cloudinary URL allowlist prevents SSRF and transforms only original xeption images",()=>{
  assert.equal(normalizedCloudinarySource(sample,policy),
    "https://res.cloudinary.com/dli0kdkg9/image/upload/f_webp,q_85,w_2048,c_limit/v1781204553/xeption/photo-1.jpg");
  const invalid=[
    "https://res.cloudinary.com.evil.test/dli0kdkg9/image/upload/xeption/x.jpg",
    "http://res.cloudinary.com/dli0kdkg9/image/upload/xeption/x.jpg",
    "https://res.cloudinary.com/dli0kdkg9/video/upload/xeption/x.mp4",
    "https://res.cloudinary.com/dli0kdkg9/image/upload/f_auto/xeption/x.jpg",
    "https://res.cloudinary.com/dli0kdkg9/image/upload/v1/anotherapp/x.jpg",
    "https://res.cloudinary.com/dli0kdkg9/image/upload/v1/xeption/x.jpg?url=https://evil.test",
    "https://res.cloudinary.com/dli0kdkg9/image/upload/xeption/%2e%2e/private.jpg",
    "https://res.cloudinary.com/anothercloud/image/upload/xeption/x.jpg"
  ];
  invalid.forEach(u=>assert.equal(normalizedCloudinarySource(u,policy),null,u));
});
test("migration disabled by default: no D1 or R2 calls",async()=>{
  const env={DB:{prepare:()=>{throw Error("D1 should not be touched")}},MEDIA_BUCKET:null} as unknown as Env;
  const result=await runMigrationBatch(env,async()=>{throw Error("fetch should not run")});
  assert.deepEqual(result,{enabled:false,copied:0,dead:0,failed:0,blocked:0});
});
type Row={id:string;tenant:string;folder:string;source_url:string;media_id:string;status:string;attempts:number;last_error?:string|null};
function fakeEnv():{env:Env;job:Row;objects:Map<string,ArrayBuffer>;media:Map<string,{object_key:string;status:string}>}{
  const job:Row={id:"177fcc34-f9f7-4d46-a171-113f7b919555",tenant:"xeption",folder:"products",
    source_url:sample,media_id:"82caea7e-0e19-4e6f-a243-58c1707bd8fd",status:"pending",attempts:0};
  const media=new Map<string,{object_key:string;status:string}>();
  const objects=new Map<string,ArrayBuffer>();
  const DB:Env["DB"]={
    prepare(sql:string){
      let args:unknown[]=[];
      const stmt={
        bind(...v:unknown[]){args=v;return stmt;},
        async first<T>(){
          if(sql.startsWith("SELECT id,tenant"))return (job.status==="pending"&&job.attempts<3?job:null) as T|null;
          if(sql.startsWith("SELECT object_key"))return (media.get(String(args[0]))||null) as T|null;
          throw Error("Unexpected SELECT "+sql);
        },
        async run(){
          if(sql.startsWith("UPDATE media_migrations SET status='pending'"))return {meta:{changes:0}};
          if(sql.startsWith("UPDATE media_migrations SET status='processing'")){
            if(job.status!=="pending")return {meta:{changes:0}};
            job.status="processing";job.attempts++;return {meta:{changes:1}};
          }
          if(sql.startsWith("UPDATE media_migrations SET status=?")){
            job.status=String(args[0]);job.last_error=args[1] as string;return {meta:{changes:1}};
          }
          if(sql.startsWith("INSERT OR IGNORE INTO media(")){
            if(media.has(String(args[0])))return {meta:{changes:0}};
            media.set(String(args[0]),{object_key:String(args[3]),status:"pending"});
            return {meta:{changes:1}};
          }
          if(sql.startsWith("UPDATE media SET status='ready'")){
            const row=media.get(String(args[1]));
            if(!row||row.status!=="pending")return {meta:{changes:0}};
            row.status="ready";return {meta:{changes:1}};
          }
          throw Error("Unexpected SQL "+sql);
        }
      };
      return stmt;
    }
  };
  const MEDIA_BUCKET:Env["MEDIA_BUCKET"]={
    async put(key:string,body:ArrayBuffer){objects.set(key,body);},
    async get(key:string){const b=objects.get(key);return b?{size:b.byteLength,body:new Response(b).body!}:null;},
    async delete(key:string){objects.delete(key);}
  };
  const env:Env={DB,MEDIA_BUCKET,MIGRATION_ENABLED:"true",MIGRATION_SOURCES_JSON:JSON.stringify({xeption:policy})};
  return {env,job,objects,media};
}
const webp=Uint8Array.from([82,73,70,70,8,0,0,0,87,69,66,80,86,80,56,88]);
test("one job succeeds, saves ready R2 media and will not fetch again",async()=>{
  const {env,job,objects,media}=fakeEnv();
  let count=0;
  const fetcher=async()=>{count++;return new Response(webp.buffer,{status:200,headers:{"content-type":"image/webp"}})};
  const a=await runMigrationBatch(env,fetcher as typeof fetch);
  assert.equal(a.copied,1);assert.equal(job.status,"copied");assert.equal(job.attempts,1);
  assert.equal(objects.size,1);assert.equal(media.get(job.media_id)?.status,"ready");
  const b=await runMigrationBatch(env,fetcher as typeof fetch);
  assert.equal(b.copied,0);assert.equal(count,1);
});
test("dead source recorded without creating a broken public image",async()=>{
  const {env,job,media}=fakeEnv();
  const fetcher=async()=>new Response("missing",{status:404});
  const r=await runMigrationBatch(env,fetcher as typeof fetch);
  assert.equal(r.dead,1);assert.equal(job.status,"dead");assert.equal(media.size,0);
});
test("403 origin immediately stops the batch and never publishes a media record",async()=>{
  const {env,job,media}=fakeEnv();
  const r=await runMigrationBatch(env,(async()=>new Response("quota",{status:403})) as typeof fetch);
  assert.equal(r.blocked,1);assert.equal(job.status,"blocked");assert.equal(media.size,0);
});
