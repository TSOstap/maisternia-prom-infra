/** ENG-29 — налаштування сервера mm-ops оператором (локально). Адреса й ключі — з файла --env (MM_OPS_URL, ADMIN_KEY; поза репозиторієм),
 *  нічого з них не друкується.
 *
 *    inputs  --env=<mm-ops.env> --MM_OWNER_VALUES=<файл> … — завантажити погоджені файли (config/ops-inputs.json): спершу локальна
 *            перевірка SHA-256 = відбитку з маніфесту, потім звірка SHA, порахованого сервером. Інший файл — відмова.
 *    w2-migrate --env=<mm-ops.env> --from=<каталог FileStore> — перенести стан W2 з однохостового сховища в Durable Object:
 *            лише якщо в джерелі немає чинної оренди й незавершених планів; сервер приймає лише в ПОРОЖНЄ сховище; потім вивантаження й
 *            порівняння ключ-у-ключ (значення й версії); лише після збігу — позначка MOVED-TO-DO.json у каталозі джерела (однохостовий
 *            запис після цього заборонено координатором W2). Файли джерела не змінюються й не видаляються. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const parse = (t) => Object.fromEntries(t.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const die = (m) => { console.error("ВІДМОВА: " + m); process.exit(2); };
const cmd = process.argv[2];
const cfg = parse(fs.readFileSync(arg("env") || die("потрібен --env"), "utf8"));
if (!/^https:\/\//.test(cfg.MM_OPS_URL || "") || (cfg.ADMIN_KEY || "").length < 20) die("у файлі --env немає MM_OPS_URL / ADMIN_KEY");
const call = async (method, p, body, raw = false) => {
  const res = await fetch(new URL(p, cfg.MM_OPS_URL), { method, redirect: "error", headers: { authorization: "Bearer " + cfg.ADMIN_KEY, "content-type": raw ? "text/plain; charset=utf-8" : "application/json" }, ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data };
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

if (cmd === "inputs") {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config", "ops-inputs.json"), "utf8"));
  for (const [v, x] of Object.entries(manifest.inputs)) {
    const file = arg(v);
    if (!file) { console.log(`${x.name}: пропущено (немає --${v}=)`); continue; }
    const buf = fs.readFileSync(file);
    if (sha(buf) !== x.sha256) die(`${x.name}: SHA-256 файла ≠ погодженому в config/ops-inputs.json`);
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").compare(buf) !== 0 || text.charCodeAt(0) === 0xfeff) die(`${x.name}: файл не чистий UTF-8 без BOM — сервер змінив би байти`);
    const r = await call("PUT", "/admin/inputs/" + x.name, text, true);
    const ok = r.status === 200 && r.data?.result?.sha256 === x.sha256;
    console.log(`${x.name}: ${ok ? "OK (SHA сервера = погодженому)" : "ПОМИЛКА HTTP " + r.status}`);
    if (!ok) process.exitCode = 1;
  }
} else if (cmd === "w2-migrate") {
  const dir = arg("from") || die("потрібен --from=<каталог FileStore>");
  if (fs.existsSync(path.join(dir, "MOVED-TO-DO.json"))) die("сховище вже перенесено (MOVED-TO-DO.json)");
  const entries = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    if (f.endsWith(".lock") || f.endsWith(".tmp")) die("у каталозі є замок / тимчасовий файл — інший процес пише: " + f);
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    entries.push({ key: decodeURIComponent(f.slice(0, -5)), value: d.value ?? null, version: String(d.version) });
  }
  if (fs.readdirSync(dir).some((f) => /\.(lock|tmp)$/.test(f))) die("у каталозі є замок / тимчасовий файл — інший процес пише");
  const now = Date.now();
  for (const e of entries) {
    if (e.key.startsWith("state/write-lease/") && e.value && !e.value.released && now < Number(e.value.expiresAt) + 200_000) die(`чинна оренда ${e.key} (token ${e.value.token}) — дочекайтеся завершення запуску`);
    if ((e.key === "state/run-plan/current.json" || e.key === "state/transfer-new92/plan.json") && e.value?.status && !["DONE", "ABANDONED"].includes(e.value.status)) die(`незавершений план ${e.key} (${e.value.status}) — спершу завершіть / відновіть локально`);
  }
  const seeded = await call("POST", "/admin/w2-seed", { entries });
  if (seeded.status !== 200) die(`сервер відмовив (HTTP ${seeded.status}${seeded.data?.error?.code ? ", " + seeded.data.error.code : ""}) — нічого не перенесено`);
  const dump = await call("GET", "/admin/w2-dump");
  const got = new Map((dump.data?.entries || []).map((e) => [e.key, e]));
  const diff = entries.filter((e) => { const g = got.get(e.key); return !g || g.version !== e.version || JSON.stringify(g.value) !== JSON.stringify(e.value); });
  if (diff.length || got.size !== entries.length) die(`звірка після перенесення не збіглася (${diff.length} ключів, на сервері ${got.size} / ${entries.length}) — позначку НЕ поставлено; локальне сховище лишається чинним`);
  const marker = { movedAt: new Date().toISOString(), to: "Cloudflare Durable Object mm-ops (ENG-29)", keys: entries.length, sha256: Object.fromEntries(entries.map((e) => [e.key, sha(JSON.stringify(e.value))])) };
  fs.writeFileSync(path.join(dir, "MOVED-TO-DO.json"), JSON.stringify(marker, null, 1));
  console.log(`Перенесено ключів: ${entries.length}; звірка ключ-у-ключ OK; позначку MOVED-TO-DO.json поставлено`);
} else die("команда: inputs | w2-migrate");
