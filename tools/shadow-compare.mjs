/** C3-2: локальне порівняння ТІНЬОВОГО YML (Cloudflare) з ЧИННИМ YML Apps Script. Лише читання (GET), лише на ПК власника.
 *
 *  node tools/shadow-compare.mjs --live-url-file=<файл з адресою чинного YML> --details=<папка поза репо>
 *    [--cf-env=<cloudflare.env>] [--shadow-key-file=~/.mm-feed-poc/shadow-key.txt]
 *
 *  Адреси, ключі й товарні дані не виводяться: у консоль — лише агрегати; ID розбіжностей — тільки у файл --details.
 *  У GitHub Actions не запускається (чинна адреса YML — не в секретах репозиторію). */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.GITHUB_ACTIONS === "true") { console.error("Лише локально"); process.exit(2); }
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const read = (f) => fs.readFileSync(f, "utf8").trim();
const liveUrl = read(arg("live-url-file")).split(/\s+/).find((x) => /^https:\/\//.test(x));
if (!liveUrl) throw new Error("у файлі немає https-адреси");
const env = read(arg("cf-env", "E:/Prom Maisternia Market/Матеріали/API/cloudflare.env"));
const g = (k) => new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, "m").exec(env)?.[1];
const token = g("CLOUDFLARE_API_TOKEN"), account = g("CLOUDFLARE_ACCOUNT_ID");
const shadowKey = read(arg("shadow-key-file", path.join(os.homedir(), ".mm-feed-poc", "shadow-key.txt")));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const digestNoDate = (xml) => sha(xml.replace(/^(<\?xml version="1\.0" encoding="UTF-8"\?>\n<yml_catalog date=")[^"]*"/, '$1"'));

async function get(url) {
  const t = Date.now();
  const r = await fetch(url, { redirect: "follow", headers: { "accept-encoding": "identity" } });
  const text = await r.text();
  return { status: r.status, text, ms: Date.now() - t, bytes: Buffer.byteLength(text) };
}
const TAG = (n) => new RegExp(`<${n}>([^<]*)</${n}>`);
function offerMap(xml) {
  const m = new Map();
  for (const x of xml.matchAll(/<offer id="(\d+)" available="(true|false)"[^>]*>([\s\S]*?)<\/offer>/g)) {
    const b = x[3];
    m.set(x[1], { available: x[2], price: TAG("price").exec(b)?.[1] ?? null, oldprice: TAG("oldprice").exec(b)?.[1] ?? null, qty: TAG("quantity_in_stock").exec(b)?.[1] ?? null,
      rest: sha(b.replace(TAG("price"), "").replace(TAG("oldprice"), "").replace(TAG("quantity_in_stock"), "")) });
  }
  return m;
}

const sub = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: { authorization: `Bearer ${token}` } })).json()).result?.subdomain;
const shadowUrl = `https://mm-feed-poc.${sub}.workers.dev/feeds/main.xml?key=${encodeURIComponent(shadowKey)}`;
const statusUrl = `https://mm-feed-poc.${sub}.workers.dev/feeds/main/status?key=${encodeURIComponent(shadowKey)}`;
const st = await (await fetch(statusUrl)).json().catch(() => ({}));
const [live, shadow] = await Promise.all([get(liveUrl), get(shadowUrl)]);
if (live.status !== 200 || shadow.status !== 200) {
  console.log(JSON.stringify({ liveStatus: live.status, shadowStatus: shadow.status }));
  process.exit(1);
}
const L = offerMap(live.text), S = offerMap(shadow.text);
const d = { onlyLive: [], onlyShadow: [], available: [], price: [], oldprice: [], quantity: [], otherContent: [] };
for (const [id, a] of L) {
  const b = S.get(id);
  if (!b) { d.onlyLive.push(id); continue; }
  if (a.available !== b.available) d.available.push(id);
  if (a.price !== b.price) d.price.push(id);
  if (a.oldprice !== b.oldprice) d.oldprice.push(id);
  if (a.qty !== b.qty) d.quantity.push(id);
  if (a.rest !== b.rest) d.otherContent.push(id);
}
for (const id of S.keys()) if (!L.has(id)) d.onlyShadow.push(id);
const liveDate = /<yml_catalog date="([^"]*)"/.exec(live.text)?.[1] ?? null;
const shadowDate = /<yml_catalog date="([^"]*)"/.exec(shadow.text)?.[1] ?? null;
const summary = {
  at: new Date().toISOString(),
  live: { bytes: live.bytes, ms: live.ms, offers: L.size, date: liveDate, sourceDigest: digestNoDate(live.text).slice(0, 16) },
  shadow: { bytes: shadow.bytes, ms: shadow.ms, offers: S.size, date: shadowDate, sourceDigest: digestNoDate(shadow.text).slice(0, 16), version: st.version ?? null, shaMatchesManifest: sha(shadow.text) === st.sha256 },
  byteIdenticalExceptDate: digestNoDate(live.text) === digestNoDate(shadow.text),
  diffCounts: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])),
};
if (arg("details")) {
  fs.mkdirSync(arg("details"), { recursive: true });
  fs.writeFileSync(path.join(arg("details"), `compare-${summary.at.replace(/[:.]/g, "-")}.json`), JSON.stringify({ ...summary, ids: d }, null, 1));
}
console.log(JSON.stringify(summary, null, 1));
