export interface DatabaseStatement {
  bind(...values: unknown[]): DatabaseStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface DatabaseBinding { prepare(sql: string): DatabaseStatement }
export interface BucketBinding {
  put(key: string, body: ArrayBuffer, options?: { httpMetadata?: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size?: number } | null>;
  delete(key: string): Promise<void>;
}
export interface Env {
  MEDIA_BUCKET: BucketBinding;
  DB: DatabaseBinding;
  TENANT_CONFIG_JSON?: string;
  TOKEN_SIGNING_SECRET?: string;
}
type Tenant = { secret: string; allowedOrigins?: string[]; maxBytes?: number };
type TokenClaims = {
  v: 1; scope: "upload"; tenant: string; id: string; folder: string;
  contentType: "image/webp"; maxBytes: number; visibility: "public"; exp: number;
};
const MAX_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_RE = /^[a-z][a-z0-9-]{1,39}$/;
const FOLDER_RE = /^[a-z][a-z0-9-]{0,39}$/;
const textEncoder = new TextEncoder();
function json(value: unknown, status = 200, headers: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", ...headers }
  });
}
function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw Error("Invalid token");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function tenants(env: Env): Record<string, Tenant> {
  try {
    const data: unknown = JSON.parse(env.TENANT_CONFIG_JSON || "{}");
    if (!data || Array.isArray(data) || typeof data !== "object") return {};
    return data as Record<string, Tenant>;
  } catch { return {}; }
}
async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), {
    name: "HMAC", hash: "SHA-256"
  }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(message))));
}
export async function equalSecrets(a: string, b: string): Promise<boolean> {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ah = await crypto.subtle.digest("SHA-256", textEncoder.encode(a));
  const bh = await crypto.subtle.digest("SHA-256", textEncoder.encode(b));
  const left = new Uint8Array(ah); const right = new Uint8Array(bh);
  let diff = 0; for (let i=0; i<left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const payload = encode(textEncoder.encode(JSON.stringify(claims)));
  return payload + "." + await hmac(payload, secret);
}
export async function verifyToken(token: string, secret: string, now = Math.floor(Date.now()/1000)): Promise<TokenClaims | null> {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const expected = await hmac(parts[0], secret);
  if (!(await equalSecrets(expected, parts[1]))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as TokenClaims;
    if (claims.v !== 1 || claims.scope !== "upload" || !TENANT_RE.test(claims.tenant)
      || !ID_RE.test(claims.id) || !FOLDER_RE.test(claims.folder)
      || claims.contentType !== "image/webp" || claims.visibility !== "public"
      || !Number.isSafeInteger(claims.maxBytes) || claims.maxBytes < 1 || claims.maxBytes > MAX_BYTES
      || !Number.isSafeInteger(claims.exp) || claims.exp < now || claims.exp > now+300) return null;
    return claims;
  } catch { return null; }
}
export function isWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const ascii = (offset: number, s: string) => Array.from(s).every((c, i) => bytes[offset+i] === c.charCodeAt(0));
  return ascii(0,"RIFF") && ascii(8,"WEBP") && (ascii(12,"VP8 ") || ascii(12,"VP8L") || ascii(12,"VP8X"))
    && ((bytes[4] | (bytes[5]<<8) | (bytes[6]<<16) | (bytes[7]<<24)) >>> 0) === bytes.length-8;
}
async function authorize(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_SIGNING_SECRET || env.TOKEN_SIGNING_SECRET.length < 32) return fail("SERVICE_UNCONFIGURED", 503);
  if (Number(request.headers.get("content-length") || "0") > 2048) return fail("REQUEST_TOO_LARGE", 413);
  let body: { tenant?: unknown; folder?: unknown; maxBytes?: unknown; contentType?: unknown };
  try { body = await request.json() as typeof body; } catch { return fail("INVALID_JSON",400); }
  const tenant = body.tenant;
  const folder = body.folder;
  if (typeof tenant !== "string" || !TENANT_RE.test(tenant) || typeof folder !== "string" || !FOLDER_RE.test(folder)) return fail("INVALID_REQUEST",400);
  const client = tenants(env)[tenant];
  if (!client || !client.secret || client.secret.length < 32 ||
    !(await equalSecrets(request.headers.get("x-tenant-secret") || "", client.secret))) return fail("UNAUTHORIZED",401);
  if (body.contentType !== "image/webp") return fail("UNSUPPORTED_MEDIA_TYPE",415);
  const maxAllowed = Math.min(MAX_BYTES, Number.isSafeInteger(client.maxBytes) && (client.maxBytes as number)>0 ? client.maxBytes as number : MAX_BYTES);
  if (!Number.isSafeInteger(body.maxBytes) || (body.maxBytes as number) < 1 || (body.maxBytes as number) > maxAllowed) return fail("INVALID_SIZE",400);
  const claims: TokenClaims = {v:1,scope:"upload",tenant,id:crypto.randomUUID(),folder,contentType:"image/webp",maxBytes:body.maxBytes as number,visibility:"public",exp:Math.floor(Date.now()/1000)+180};
  const token = await signToken(claims, env.TOKEN_SIGNING_SECRET);
  return json({token,mediaId:claims.id,uploadUrl:"/v1/uploads/"+tenant+"/"+claims.id,
    mediaUrl:"/v1/media/"+tenant+"/"+claims.id,expiresAt:new Date(claims.exp*1000).toISOString()},201);
}
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) { await reader.cancel().catch(()=>{}); return null; }
      chunks.push(next.value);
    }
  } catch { await reader.cancel().catch(()=>{}); return null; }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk,offset); offset += chunk.byteLength; }
  return all;
}
async function upload(request: Request, env: Env, tenant: string, id: string): Promise<Response> {
  const auth = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get("authorization") || "");
  const claims = auth ? await verifyToken(auth[1],env.TOKEN_SIGNING_SECRET || "") : null;
  if (!claims || claims.tenant !== tenant || claims.id !== id) return fail("UNAUTHORIZED",401);
  if (!tenants(env)[tenant]) return fail("UNKNOWN_TENANT",403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/webp") return fail("UNSUPPORTED_MEDIA_TYPE",415);
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > claims.maxBytes) return fail("REQUEST_TOO_LARGE",413);
  const bytes = await readLimited(request, claims.maxBytes);
  if (!bytes || bytes.byteLength === 0) return fail("REQUEST_TOO_LARGE",413);
  if (!isWebP(bytes)) return fail("INVALID_WEBP",415);
  const buffer = bytes.buffer as ArrayBuffer;
  const key = "tenants/"+tenant+"/"+claims.folder+"/"+claims.id+".webp";
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO media(id, tenant, folder, object_key, status, visibility, content_type, size_bytes, created_at) VALUES(?, ?, ?, ?, 'pending', 'public', 'image/webp', ?, datetime('now'))"
  ).bind(id,tenant,claims.folder,key,buffer.byteLength).run();
  if (inserted.meta?.changes !== 1) return fail("TOKEN_ALREADY_USED",409);
  try {
    await env.MEDIA_BUCKET.put(key,buffer,{httpMetadata:{contentType:"image/webp"}});
    const result = await env.DB.prepare("UPDATE media SET status='ready' WHERE id=? AND tenant=? AND status='pending'")
      .bind(id,tenant).run();
    if (result.meta?.changes !== 1) throw new Error("Unable to finalize metadata");
  } catch {
    try {await env.MEDIA_BUCKET.delete(key);} catch {}
    try {await env.DB.prepare("DELETE FROM media WHERE id=? AND tenant=? AND status='pending'").bind(id,tenant).run();}catch {}
    return fail("UPLOAD_FAILED",503);
  }
  return json({id,tenant,url:"/v1/media/"+tenant+"/"+id},201);
}
async function media(env: Env, tenant: string, id: string): Promise<Response> {
  if (!TENANT_RE.test(tenant) || !ID_RE.test(id)) return fail("NOT_FOUND",404);
  const record = await env.DB.prepare(
    "SELECT object_key FROM media WHERE id=? AND tenant=? AND status='ready' AND visibility='public'"
  ).bind(id,tenant).first<{object_key:string}>();
  if (!record) return fail("NOT_FOUND",404);
  const object = await env.MEDIA_BUCKET.get(record.object_key);
  if (!object) return fail("NOT_FOUND",404);
  return new Response(object.body,{status:200,headers:{
    "content-type":"image/webp",
    "cache-control":"public, max-age=31536000, immutable",
    "x-content-type-options":"nosniff",
    "access-control-allow-origin":"*",
    "cross-origin-resource-policy":"cross-origin"
  }});
}
export default {
  async fetch(request: Request,env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && (url.pathname.startsWith("/v1/uploads/"))) {
      return new Response(null,{status:204,headers:{
        "access-control-allow-origin":"*","access-control-allow-methods":"PUT, OPTIONS",
        "access-control-allow-headers":"Authorization, Content-Type",
        "access-control-max-age":"600","vary":"origin"
      }});
    }
    if (url.pathname === "/health" && request.method === "GET") return json({
      status:env.MEDIA_BUCKET && env.DB ? "ok" : "degraded", service:"trigenys-storage",
      tenantCredentialsConfigured: Object.keys(tenants(env)).length > 0,
      tokenSigningConfigured:Boolean(env.TOKEN_SIGNING_SECRET && env.TOKEN_SIGNING_SECRET.length >= 32)
    });
    if (url.pathname === "/v1/uploads/authorize" && request.method === "POST") return authorize(request,env);
    const uploadMatch = /^\/v1\/uploads\/([a-z][a-z0-9-]{1,39})\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (uploadMatch && request.method === "PUT") return upload(request,env,uploadMatch[1],uploadMatch[2]);
    const mediaMatch = /^\/v1\/media\/([a-z][a-z0-9-]{1,39})\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (mediaMatch && request.method === "GET") return media(env,mediaMatch[1],mediaMatch[2]);
    return fail("NOT_FOUND",404);
  }
};
