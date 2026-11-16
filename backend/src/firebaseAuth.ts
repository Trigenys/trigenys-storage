import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Tenant end-user authentication with Firebase Authentication ID tokens.
 * Lets an application without a trusted backend (e.g. a static Firebase Hosting site)
 * request upload intents directly from the browser. Configured per tenant, no fork.
 */
export type FirebaseAuthConfig = {
  type: "firebase";
  projectId: string;
  /** Reject tokens whose e-mail is not verified. Defaults to true. */
  requireVerifiedEmail?: boolean;
  /** Optional moderator lookup in a Firestore document readable by the user. */
  roles?: { document: string; field: string; moderator: string[] };
};
export type FirebaseUser = { subject: string; token: string };

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const PROJECT_RE = /^[a-z][a-z0-9-]{4,29}$/;
const SUBJECT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DOC_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_{}-]+)+$/;

type Deps = { keys: JWTVerifyGetKey; fetch: typeof fetch };
let deps: Deps | null = null;
/** Test seam: inject a local key set and a fake fetch. */
export function configureFirebaseDeps(next: Partial<Deps> | null): void {
  deps = next ? { keys: next.keys ?? defaults().keys, fetch: next.fetch ?? defaults().fetch } : null;
}
let remoteKeys: JWTVerifyGetKey | null = null;
function defaults(): Deps {
  remoteKeys ??= createRemoteJWKSet(new URL(JWKS_URL));
  return { keys: remoteKeys, fetch: (input, init) => fetch(input, init) };
}
const current = (): Deps => deps ?? defaults();

export function isFirebaseConfig(value: unknown): value is FirebaseAuthConfig {
  const c = value as FirebaseAuthConfig | undefined;
  if (!c || c.type !== "firebase" || typeof c.projectId !== "string" || !PROJECT_RE.test(c.projectId)) return false;
  if (c.roles === undefined) return true;
  return typeof c.roles.document === "string" && DOC_RE.test(c.roles.document) && c.roles.document.includes("{uid}")
    && typeof c.roles.field === "string" && /^[A-Za-z0-9_]{1,64}$/.test(c.roles.field)
    && Array.isArray(c.roles.moderator) && c.roles.moderator.every((r) => typeof r === "string");
}

export function bearer(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(request.headers.get("authorization") || "");
  return match ? match[1] : null;
}

/** Verifies signature, issuer, audience, expiry and subject. Returns null on any failure (fail closed). */
export async function verifyFirebaseToken(token: string, config: FirebaseAuthConfig): Promise<FirebaseUser | null> {
  if (token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, current().keys, {
      algorithms: ["RS256"],
      issuer: "https://securetoken.google.com/" + config.projectId,
      audience: config.projectId,
      clockTolerance: 30
    });
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.sub !== "string" || !SUBJECT_RE.test(payload.sub)) return null;
    if (typeof payload.auth_time === "number" && payload.auth_time > now + 30) return null;
    if (config.requireVerifiedEmail !== false && payload.email_verified !== true) return null;
    return { subject: payload.sub, token };
  } catch {
    return null;
  }
}

/** Reads the user's role from Firestore with the user's own token, so the tenant's security rules apply. */
export async function isModerator(user: FirebaseUser, config: FirebaseAuthConfig): Promise<boolean> {
  const roles = config.roles;
  if (!roles || roles.moderator.length === 0) return false;
  const path = roles.document.replace("{uid}", encodeURIComponent(user.subject));
  const url = "https://firestore.googleapis.com/v1/projects/" + config.projectId
    + "/databases/(default)/documents/" + path + "?mask.fieldPaths=" + encodeURIComponent(roles.field);
  try {
    const response = await current().fetch(url, { headers: { authorization: "Bearer " + user.token } });
    if (!response.ok) return false;
    const doc = await response.json() as { fields?: Record<string, { stringValue?: unknown }> };
    const role = doc.fields?.[roles.field]?.stringValue;
    return typeof role === "string" && roles.moderator.includes(role);
  } catch {
    return false;
  }
}
