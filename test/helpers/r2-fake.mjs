/** Імітація R2-прив'язки Worker поверх LocalObjectStore (той самий вміст, що пише публікатор). */
import { Readable } from "node:stream";

export function r2BindingFrom(store) {
  const wrap = async (key, withBody) => {
    const head = await store.head(key);
    if (!head) return null;
    const obj = { key, size: head.size, customMetadata: head.metadata || {}, httpEtag: `"${head.metadata?.sha256 || ""}"` };
    if (withBody) {
      const buf = await store.getBuffer(key);
      obj.body = Readable.toWeb(Readable.from([buf]));
      obj.text = async () => buf.toString("utf8");
    }
    return obj;
  };
  return { get: (key) => wrap(key, true), head: (key) => wrap(key, false) };
}
