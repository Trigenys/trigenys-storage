import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import worker, { type Env } from "../src/worker.ts";
import { configureFirebaseDeps } from "../src/firebaseAuth.ts";

const signing = "signing-test-secret-abcdefghijklmnopqrstuvwxyz";
const xeptionSecret = "xeption-test-secret-abcdefghijklmnopqrstu";
const origin = "https://storage.example.test";
const projectId = "love-ink-test";
const ALL_MIGRATIONS = ["0001_media_registry.sql", "0002_media_variants.sql", "0003_cloudinary_migration_queue.sql", "0004_end_user_ownership.sql"];

function webp(): ArrayBuffer {
  return new Uint8Array([82,73,70,70,8,0,0,0,87,69,66,80,86,80,56,88]).buffer;
}
/** D1-compatible adapter over a real SQLite database with the repository's migrations. */
function d1(migrations: string[]): Env["DB"] {
  const db = new DatabaseSync(":memory:");
  for (const file of migrations) db.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>() { return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }; }
      };
      return statement;
    }
  };
}
let privateKey: CryptoKey;
const roles = new Map<string, string>();
beforeEach(async () => {
  roles.clear();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  configureFirebaseDeps({
    keys: createLocalJWKSet({ keys: [jwk] }),
    async fetch(input, init) {
      const url = String(input);
      const sub = /documents\/utilisateurs\/([^?]+)/.exec(url)?.[1] ?? "";
      const auth = new Headers(init?.headers).get("authorization") || "";
      // The role is read with the caller's own token (tenant rules apply).
      if (!auth.startsWith("Bearer ") || !roles.has(sub)) return new Response("{}", { status: 404 });
      return Response.json({ fields: { role: { stringValue: roles.get(sub) } } });
    }
  });
});
async function idToken(sub: string, claims: Record<string, unknown> = {}, aud = projectId, exp = "10m"): Promise<string> {
  return new SignJWT({ email_verified: true, auth_time: Math.floor(Date.now()/1000) - 5, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject(sub).setIssuer("https://securetoken.google.com/" + projectId)
    .setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
}
function setup(options: { migrations?: string[]; loveink?: Record<string, unknown> } = {}) {
  const objects = new Map<string, ArrayBuffer>();
  const env: Env = {
    DB: d1(options.migrations ?? ALL_MIGRATIONS),
    MEDIA_BUCKET: {
      async put(key, body) { objects.set(key, body); },
      async get(key) { const v = objects.get(key); return v ? { body: new Response(v).body!, size: v.byteLength } : null; },
      async delete(key) { objects.delete(key); }
    },
    TOKEN_SIGNING_SECRET: signing,
    TENANT_CONFIG_JSON: JSON.stringify({
      xeption: { secret: xeptionSecret },
      loveink: {
        auth: { type: "firebase", projectId, roles: { document: "utilisateurs/{uid}", field: "role", moderator: ["moderateur", "censeur"] } },
        uploadVisibility: "private", publicCacheControl: "public, max-age=86400", maxPendingPerSubject: 4,
        ...options.loveink
      }
    })
  };
  return { env, objects };
}
const call = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(origin + path, init), env);
async function authorize(env: Env, headers: Record<string, string>, tenant = "loveink") {
  return call(env, "/v1/uploads/authorize", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ tenant, folder: "stories", contentType: "image/webp", maxBytes: 1000 }) });
}
async function uploadAs(env: Env, sub: string): Promise<string> {
  const intent = await authorize(env, { authorization: "Bearer " + await idToken(sub) });
  assert.equal(intent.status, 201);
  const body = await intent.json() as { token: string; mediaId: string; uploadUrl: string; visibility: string };
  assert.equal(body.visibility, "private");
  const put = await call(env, body.uploadUrl, { method: "PUT", headers: { authorization: "Bearer " + body.token, "content-type": "image/webp" }, body: webp() });
  assert.equal(put.status, 201);
  return body.mediaId;
}

test("firebase user: upload stays private, visible to owner and moderators only", async () => {
  const { env } = setup();
  roles.set("mod1", "moderateur");
  const id = await uploadAs(env, "author1");
  assert.equal((await call(env, "/v1/media/loveink/" + id)).status, 404);
  const own = await call(env, "/v1/media/loveink/" + id, { headers: { authorization: "Bearer " + await idToken("author1") } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  assert.equal((await call(env, "/v1/media/loveink/" + id, { headers: { authorization: "Bearer " + await idToken("other") } })).status, 404);
  assert.equal((await call(env, "/v1/media/loveink/" + id + "/w800", { headers: { authorization: "Bearer " + await idToken("mod1") } })).status, 200);
});

test("moderator publishes and withdraws; owners cannot publish", async () => {
  const { env } = setup();
  roles.set("mod1", "censeur");
  const id = await uploadAs(env, "author1");
  const publish = (sub: string, visibility: string) => idToken(sub).then((t) => call(env, "/v1/media/loveink/" + id + "/visibility",
    { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify({ visibility }) }));
  assert.equal((await publish("author1", "public")).status, 404);
  assert.equal((await publish("mod1", "public")).status, 200);
  assert.equal((await publish("mod1", "public")).status, 200, "idempotent");
  const pub = await call(env, "/v1/media/loveink/" + id);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("cache-control"), "public, max-age=86400");
  assert.equal((await publish("mod1", "private")).status, 200);
  assert.equal((await call(env, "/v1/media/loveink/" + id)).status, 404);
});

test("owner deletes; deletion is idempotent and removes objects", async () => {
  const { env, objects } = setup();
  const id = await uploadAs(env, "author1");
  const del = async (sub: string) => call(env, "/v1/media/loveink/" + id, { method: "DELETE", headers: { authorization: "Bearer " + await idToken(sub) } });
  assert.equal((await del("intruder")).status, 404);
  assert.equal(objects.size, 1);
  assert.equal((await del("author1")).status, 204);
  assert.equal(objects.size, 0);
  assert.equal((await del("author1")).status, 204, "retry is a no-op");
  assert.equal((await call(env, "/v1/media/loveink/" + id, { headers: { authorization: "Bearer " + await idToken("author1") } })).status, 404);
});

test("invalid ID tokens are rejected (audience, expiry, unverified e-mail, foreign key)", async () => {
  const { env } = setup({ loveink: { auth: { type: "firebase", projectId } } });
  const bad = [
    await idToken("u1", {}, "other-project"),
    await idToken("u1", {}, projectId, "-1m"),
    await idToken("u1", { email_verified: false }),
    await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject("u1")
      .setIssuer("https://securetoken.google.com/" + projectId).setAudience(projectId).setExpirationTime("10m")
      .sign((await generateKeyPair("RS256")).privateKey)
  ];
  for (const token of bad) assert.equal((await authorize(env, { authorization: "Bearer " + token })).status, 401);
  assert.equal((await authorize(env, {})).status, 401);
});

test("unverified e-mail is accepted only when the tenant opts out", async () => {
  const { env } = setup({ loveink: { auth: { type: "firebase", projectId, requireVerifiedEmail: false } } });
  assert.equal((await authorize(env, { authorization: "Bearer " + await idToken("u1", { email_verified: false }) })).status, 201);
});

test("pending uploads are capped per user", async () => {
  const { env } = setup({ loveink: { maxPendingPerSubject: 1 } });
  await uploadAs(env, "author1");
  assert.equal((await authorize(env, { authorization: "Bearer " + await idToken("author1") })).status, 429);
  assert.equal((await authorize(env, { authorization: "Bearer " + await idToken("author2") })).status, 201);
});

test("backend tenants are unchanged, even before migration 0004", async () => {
  const { env } = setup({ migrations: ALL_MIGRATIONS.slice(0, 2) });
  assert.equal((await authorize(env, { authorization: "Bearer " + await idToken("u1") }, "xeption")).status, 401);
  const intent = await authorize(env, { "x-tenant-secret": xeptionSecret }, "xeption");
  assert.equal(intent.status, 201);
  const body = await intent.json() as { token: string; uploadUrl: string; mediaUrl: string; visibility: string };
  assert.equal(body.visibility, "public");
  const put = await call(env, body.uploadUrl, { method: "PUT", headers: { authorization: "Bearer " + body.token, "content-type": "image/webp" }, body: webp() });
  assert.equal(put.status, 201);
  const got = await call(env, body.mediaUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("cache-control"), "public, max-age=31536000, immutable");
  // A wrong secret on a Firebase tenant is not silently downgraded to token auth.
  assert.equal((await authorize(env, { "x-tenant-secret": "wrong", authorization: "Bearer " + await idToken("u1") })).status, 401);
});
