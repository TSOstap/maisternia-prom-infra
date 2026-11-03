/** Токен Google для сервісного акаунта на сервері Cloudflare (рішення власника 03.11: «Ціни й наявність» — на Cloudflare, без хвилин
 *  GitHub). OAuth 2.0 для сервер-серверних застосунків: JWT (RS256, ключ сервісного акаунта) → https://oauth2.googleapis.com/token
 *  (grant_type jwt-bearer) → токен доступу на ≤ 1 год. Підпис — WebCrypto (RSASSA-PKCS1-v1_5, SHA-256).
 *  Ключ — лише секрет Worker GOOGLE_SA_KEY (JSON ключа); нікуди не друкується. Дозволено лише акаунт mm-sheets-copy (у TEST — редактор,
 *  у LIVE — читач); інший акаунт у секреті — відмова. */

export const ALLOWED_SA = "mm-sheets-copy@maisternia-prom-infra.iam.gserviceaccount.com";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
function pemToDer(pem) {
  const body = String(pem).replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Розбір секрету: JSON ключа сервісного акаунта; лише дозволений акаунт. */
export function parseServiceKey(raw) {
  let k;
  try { k = JSON.parse(String(raw || "")); } catch { throw new Error("секрет GOOGLE_SA_KEY не є JSON ключа сервісного акаунта"); }
  if (k?.type !== "service_account" || !k.client_email || !k.private_key) throw new Error("секрет GOOGLE_SA_KEY: не ключ сервісного акаунта");
  if (k.client_email !== ALLOWED_SA) throw new Error("секрет GOOGLE_SA_KEY: дозволено лише сервісний акаунт тестової копії");
  return { email: k.client_email, privateKey: k.private_key, keyId: k.private_key_id || "" };
}

/** Підписаний JWT для обміну на токен. */
export async function signedAssertion({ email, privateKey, keyId }, { scope = SHEETS_SCOPE, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(keyId ? { kid: keyId } : {}) };
  const claims = { iss: email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const input = b64urlText(JSON.stringify(header)) + "." + b64urlText(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return input + "." + b64url(sig);
}

/** Джерело токена з кешем (оновлення за 5 хв до закінчення). fetchImpl — для тестів. */
export function googleTokenSource(rawKey, { fetchImpl = (...a) => fetch(...a), now = () => Date.now(), scope = SHEETS_SCOPE } = {}) {
  const sa = parseServiceKey(rawKey);
  let cached = null;
  return async () => {
    if (cached && now() < cached.until) return cached.token;
    const assertion = await signedAssertion(sa, { scope, now: now() });
    const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error("Google не видав токен (HTTP " + res.status + (j.error ? ", " + String(j.error).slice(0, 60) : "") + ")");
    cached = { token: j.access_token, until: now() + Math.max(60, Number(j.expires_in || 3600) - 300) * 1000 };
    return cached.token;
  };
}
