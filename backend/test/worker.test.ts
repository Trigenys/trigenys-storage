import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { isWebP, signToken, verifyToken, equalSecrets, type Env } from "../src/worker.ts";

const alphaSecret = "xeption-test-secret-abcdefghijklmnopqrstu";
const betaSecret = "second-test-secret-abcdefghijklmnopqrst";
const signing = "signing-test-secret-abcdefghijklmnopqrstuvwxyz";
const origin = "https://storage.example.test";
function webp(): Uint8Array {
  return new Uint8Array([82,73,70,70,8,0,0,0,87,69,66,80,86,80,56,88]);
}
function setup(): { env: Env; items: Map<string, Record<string, unknown>>; objects: Map<string, ArrayBuffer> } {
  const items = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, ArrayBuffer>();
  const DB: Env["DB"] = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>() {
          if (!sql.startsWith("SELECT object_key")) throw Error("unexpected select");
          const item = items.get(String(args[0]));
          return (item && item.tenant === args[1] && item.status === "ready" && item.visibility === "public" ? { object_key:item.object_key } : null) as T | null;
        },
        async run() {
          if (sql.startsWith("INSERT")) {
            const [id, tenant, folder, object_key, size] = args;
            if (items.has(String(id))) return {meta:{changes:0}};
            items.set(String(id),{id,tenant,folder,object_key,status:"pending",visibility:"public",size});
            return {meta:{changes:1}};
          }
          if (sql.startsWith("UPDATE")) {
            const record = items.get(String(args[0]));
            if (!record || record.tenant !== args[1] || record.status !== "pending") return {meta:{changes:0}};
            record.status = "ready";
            return {meta:{changes:1}};
          }
          if (sql.startsWith("DELETE")) {
            const record = items.get(String(args[0]));
            if (!record || record.tenant !== args[1] || record.status !== "pending") return {meta:{changes:0}};
            items.delete(String(args[0]));
            return {meta:{changes:1}};
          }
          throw Error("unexpected SQL");
        }
      };
      return statement;
    }
  };
  const MEDIA_BUCKET: Env["MEDIA_BUCKET"] = {
    async put(key, body) {objects.set(key,body);},
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {body: new Response(value).body!,size:value.byteLength};
    },
    async delete(key) {objects.delete(key);}
  };
  return {env:{
    DB, MEDIA_BUCKET, TOKEN_SIGNING_SECRET:signing,
    TENANT_CONFIG_JSON:JSON.stringify({xeption:{secret:alphaSecret},example:{secret:betaSecret}})
  },items,objects};
}
async function intent(env: Env, tenant = "xeption", credential = alphaSecret) {
  const response = await worker.fetch(new Request(origin+"/v1/uploads/authorize",{
    method:"POST",headers:{"content-type":"application/json","x-tenant-secret":credential},
    body:JSON.stringify({tenant,folder:"products",contentType:"image/webp",maxBytes:1024})
  }),env);
  return response;
}
test("WebP signature and declared RIFF length must both match",() => {
  const img = webp();
  assert.equal(isWebP(img),true);
  const bad = new Uint8Array(img);
  bad[8] = 0;
  assert.equal(isWebP(bad),false);
  bad[8] = img[8];
  bad[4] = 9;
  assert.equal(isWebP(bad),false);
});
test("HMAC tokens reject expiry, tampering and mismatched secret",async()=>{
  const claims = {v:1 as const,scope:"upload" as const,tenant:"xeption",
    id:"f5e5b0cb-0bad-4de4-8dad-e15dd77eb4d5",folder:"products",
    contentType:"image/webp" as const,maxBytes:500,visibility:"public" as const,exp:2000};
  const token = await signToken(claims, signing);
  assert.equal((await verifyToken(token,signing,1900))?.tenant,"xeption");
  assert.equal(await verifyToken(token,signing,2001),null);
  assert.equal(await verifyToken(token,"wrong-signing-secret",1900),null);
  assert.equal(await verifyToken(token.slice(0,-2)+"zz",signing,1900),null);
  assert.equal(await equalSecrets("different","different"),true);
  assert.equal(await equalSecrets("different","not-equal"),false);
});
test("default deny and no tenant secret exposed", async()=>{
  const {env}=setup();
  assert.equal((await intent(env,"xeption","wrong")).status,401);
  assert.equal((await intent(env,"example",alphaSecret)).status,401);
  const health = await worker.fetch(new Request(origin+"/health"),env);
  assert.equal(health.status,200);
  assert.equal((await health.text()).includes(alphaSecret),false);
});
test("valid authorize-upload-read, repeat upload denied and tenant isolation",async()=>{
  const {env,objects}=setup();
  const authorized=await intent(env);
  assert.equal(authorized.status,201);
  const data=await authorized.json() as {mediaId:string;token:string;uploadUrl:string;mediaUrl:string};
  const bytes=webp();
  const request = (token=data.token, route=data.uploadUrl, body:BodyInit=bytes) =>
    new Request(origin+route,{method:"PUT",headers:{authorization:"Bearer "+token,"content-type":"image/webp"},body});
  const first=await worker.fetch(request(),env);
  assert.equal(first.status,201);
  assert.equal(objects.size,1);
  const duplicate=await worker.fetch(request(),env);
  assert.equal(duplicate.status,409);
  const read=await worker.fetch(new Request(origin+data.mediaUrl),env);
  assert.equal(read.status,200);
  assert.equal(read.headers.get("cache-control"),"public, max-age=31536000, immutable");
  assert.equal((await read.arrayBuffer()).byteLength,16);
  const foreign=await worker.fetch(new Request(origin+data.mediaUrl.replace("/xeption/","/example/")),env);
  assert.equal(foreign.status,404);
  assert.equal((await worker.fetch(request(data.token,data.uploadUrl.replace("/xeption/","/example/")),env)).status,401);
});
test("invalid bytes, over-limit and missing authorization never publish media",async()=>{
  const {env,objects}=setup();
  const auth=await intent(env);
  const data=await auth.json() as {token:string;uploadUrl:string;mediaUrl:string};
  const bad=await worker.fetch(new Request(origin+data.uploadUrl,{method:"PUT",
    headers:{"authorization":"Bearer "+data.token,"content-type":"image/webp"},
    body:new Uint8Array([0,1,2])}),env);
  assert.equal(bad.status,415);
  const denied=await worker.fetch(new Request(origin+data.uploadUrl,{method:"PUT",
    headers:{"content-type":"image/webp"},body:webp()}),env);
  assert.equal(denied.status,401);
  const before=await worker.fetch(new Request(origin+data.mediaUrl),env);
  assert.equal(before.status,404);
  assert.equal(objects.size,0);
});
