/** ENG-25 (Hermes ENG-24 N1) — канонічні ключі сховищ і фізична ідентичність ключа.
 *
 *  Причина N1: файлові системи Windows (NTFS) і macOS (APFS за замовчуванням) не розрізняють регістр, а Windows ще й відкидає
 *  кінцеві крапки й пробіли в іменах і має імена пристроїв (CON, NUL, COM1 …). Тож різні рядки ключа можуть адресувати ОДИН файл
 *  («STATE/catalog-controls/checkpoint.json» і «state/catalog-controls/checkpoint.json»). Захисти сховищ (печатка точки, квитки,
 *  оренди, CAS, fencing) порівнювали ключі як рядки — будь-який другий запис того самого файлу їх обходив.
 *
 *  Правило:
 *   • сховище приймає ЛИШЕ канонічний запис ключа (інакше — INVALID_KEY), тож кожному файлу відповідає рівно один ключ;
 *   • порівняння з запечатаними / захищеними ключами в будь-якому шарі (сховище, ccReadiness, протокол A, fencing) — за фізичною
 *     ідентичністю keyIdentity: псевдонім запечатаного ключа дає CC_KEY_SEALED, а не INVALID_KEY.
 *  Сховище стану W2 (FileStore, MemoryStore) — лише нижній регістр. Сховище об'єктів (фіди): каталоги й суфікси — нижній регістр,
 *  службові ключі (state/…, approved/…, маніфести) — лише канонічні; останній сегмент версій і журналів може мати верхній регістр
 *  (мітки часу …T…Z) — це незмінні об'єкти з унікальними іменами, а не захищені ключі. */

export class InvalidKeyError extends Error {
  constructor(key, reason) {
    super(`INVALID_KEY: «${String(key).slice(0, 200)}» — ${reason}`);
    this.name = "InvalidKeyError";
    this.code = "INVALID_KEY";
    this.key = key;
  }
}

/** Фізична ідентичність ключа — те, що бачить регістронезалежна ФС: NFKC, нижній регістр, «\» як «/», кінцеві крапки й пробіли
 *  сегментів відкинуто, порожні сегменти й «.» прибрано. Лише для ПОРІВНЯННЯ із захищеними ключами; запис — канонічним ключем. */
export function keyIdentity(key) {
  return String(key ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.replace(/[. ]+$/, ""))
    .filter((s) => s && s !== ".")
    .join("/");
}
export const sameKey = (a, b) => keyIdentity(a) === keyIdentity(b);

const MAX_KEY = 400;
/** Імена пристроїв Windows (з розширенням або без) — не можуть бути сегментом ключа. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
/** Сегмент стану W2: [a-z0-9_:-], крапки лише всередині (без «.», «..», кінцевої крапки). «:» — у ресурсі службової оренди
 *  («…:readiness-probe»); FileStore кодує ключ у ОДНЕ ім'я файлу (encodeURIComponent), тож «:» і «/» на диску — «%3A» / «%2F». */
const STATE_SEGMENT = /^[a-z0-9_:-]+(?:\.[a-z0-9_:-]+)*$/;
/** Сегмент сховища об'єктів: [A-Za-z0-9_-], крапки лише всередині. */
const OBJECT_SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MANIFEST_IDENTITY = /^feeds\/[^/]+\/manifest\.json$/;

function baseChecks(key) {
  if (typeof key !== "string" || !key) throw new InvalidKeyError(key, "ключ сховища — непорожній рядок");
  if (key.length > MAX_KEY) throw new InvalidKeyError(key, `ключ довший за ${MAX_KEY} символів`);
  const segs = key.split("/");
  if (segs.some((s) => RESERVED.test(s))) throw new InvalidKeyError(key, "сегмент — ім'я пристрою Windows (CON, NUL, COM1 …)");
  return segs;
}

/** Канонічний ключ сховища стану W2 (FileStore, MemoryStore) або INVALID_KEY. */
export function canonicalStateKey(key) {
  const segs = baseChecks(key);
  if (!segs.every((s) => STATE_SEGMENT.test(s))) {
    throw new InvalidKeyError(key, "ключ сховища стану: сегменти з [a-z0-9_:-] (крапки лише всередині) через «/» — без верхнього регістру, «\\», порожніх сегментів, «.» / «..», кінцевих крапок і пробілів");
  }
  return key;
}

/** Службовий ключ сховища об'єктів (лише канонічний запис): стан, затвердження, маніфести фідів. */
export const isProtectedObjectIdentity = (identity) => identity.startsWith("state/") || identity.startsWith("approved/") || MANIFEST_IDENTITY.test(identity);

/** Канонічний ключ сховища об'єктів (LocalObjectStore — модель R2 на одному хості) або INVALID_KEY. */
export function canonicalObjectKey(key) {
  const segs = baseChecks(key);
  if (!segs.every((s) => OBJECT_SEGMENT.test(s))) {
    throw new InvalidKeyError(key, "ключ сховища об'єктів: сегменти з [A-Za-z0-9_-] (крапки лише всередині) через «/» — без «\\», порожніх сегментів, «.» / «..», кінцевих крапок і пробілів");
  }
  if (segs.slice(0, -1).some((s) => s !== s.toLowerCase())) throw new InvalidKeyError(key, "каталоги ключа — лише нижній регістр (файлова система їх не розрізняє)");
  const last = segs[segs.length - 1], dot = last.indexOf(".");
  const suffix = dot < 0 ? "" : last.slice(dot);
  if (suffix !== suffix.toLowerCase()) throw new InvalidKeyError(key, "розширення ключа — лише нижній регістр");
  if (segs.some((s) => /\.(cas|meta)(\.|$)|\.tmp-/i.test(s))) throw new InvalidKeyError(key, "суфікси .cas / .meta / .tmp- зарезервовані сховищем");
  if (isProtectedObjectIdentity(keyIdentity(key)) && key !== keyIdentity(key)) throw new InvalidKeyError(key, "службовий ключ (state/, approved/, маніфест) — лише канонічний запис у нижньому регістрі");
  return key;
}
