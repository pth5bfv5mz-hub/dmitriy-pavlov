/* База знаний: тексты, ссылки, документы и фото, которые Сумрак даёт Дмитрию «изучить».
   Текст режется на куски; поиск — по словам (всегда) и по смыслу (векторы Gemini, если доступен),
   результаты объединяются (reciprocal rank fusion). */
import { D, persist, idbPut, idbAll, idbDelDoc } from "./store.js";
import { uid, terms, cosine } from "./util.js";
import { embed, canEmbed, readUrl, plain, configured, isBlocked } from "./brains.js";
import { S } from "./store.js";

function chunkText(text, size = 1100, overlap = 180) {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = []; let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); };
  for (const p of paras) {
    if ((cur + "\n\n" + p).length <= size) { cur = cur ? cur + "\n\n" + p : p; continue; }
    push();
    if (p.length <= size) { cur = (cur ? cur.slice(-overlap) + "\n\n" : "") + p; continue; }
    for (let i = 0; i < p.length; i += size - overlap) out.push(p.slice(i, i + size));
    cur = "";
  }
  push();
  return out;
}

export async function addDoc(title, text, kind = "текст") {
  text = String(text || "").trim();
  if (text.length < 20) throw new Error("Слишком мало текста.");
  const docId = uid();
  const parts = chunkText(text);
  const chunks = parts.map((t, i) => ({ id: docId + ":" + i, docId, title, n: i, text: t }));
  await idbPut("chunks", chunks);
  let vec = false;
  if (canEmbed()) {
    try {
      const r = await embed(chunks.map(c => `${title}\n${c.text}`), "RETRIEVAL_DOCUMENT");
      if (r) { await idbPut("vecs", chunks.map((c, i) => ({ id: c.id, v: Array.from(r.vecs[i]) }))); vec = true; }
    } catch {}
  }
  const doc = { id: docId, title: String(title).slice(0, 120), kind, ts: Date.now(), chunks: chunks.length, chars: text.length, vec, preview: text.slice(0, 200) };
  D.docs.push(doc); persist();
  return doc;
}
export async function removeDoc(id) { await idbDelDoc(id); D.docs = D.docs.filter(d => d.id !== id); persist(); }
/* Досчитать векторы для документов, добавленных без Gemini. */
export async function ensureDocVecs() {
  if (!canEmbed()) return;
  for (const d of D.docs.filter(d => !d.vec)) {
    try {
      const chunks = (await idbAll("chunks")).filter(c => c.docId === d.id);
      const r = await embed(chunks.map(c => `${d.title}\n${c.text}`), "RETRIEVAL_DOCUMENT");
      if (r) { await idbPut("vecs", chunks.map((c, i) => ({ id: c.id, v: Array.from(r.vecs[i]) }))); d.vec = true; persist(); }
    } catch { return; }
  }
}

export async function search(query, k = 4) {
  if (!D.docs.length) return [];
  const chunks = await idbAll("chunks"); if (!chunks.length) return [];
  const qt = terms(query); if (!qt.length) return [];
  // Ключевые слова (BM25 упрощённо)
  const N = chunks.length, df = new Map();
  const tokens = chunks.map(c => { const t = terms(c.title + " " + c.text); new Set(t).forEach(w => df.set(w, (df.get(w) || 0) + 1)); return t; });
  const avg = tokens.reduce((n, t) => n + t.length, 0) / N || 1;
  const bm = chunks.map((c, i) => {
    const t = tokens[i]; let s = 0;
    for (const q of new Set(qt)) {
      const f = t.filter(w => w === q).length; if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / avg));
    }
    return { c, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  // Смысловой поиск
  let vs = [];
  if (canEmbed() && D.docs.some(d => d.vec)) {
    try {
      const r = await embed([query], "RETRIEVAL_QUERY");
      const vecs = new Map((await idbAll("vecs")).map(v => [v.id, v.v]));
      if (r) vs = chunks.filter(c => vecs.has(c.id)).map(c => ({ c, s: cosine(r.vecs[0], vecs.get(c.id)) })).filter(x => x.s > 0.55).sort((a, b) => b.s - a.s);
    } catch {}
  }
  const score = new Map();
  [bm, vs].forEach(list => list.slice(0, 20).forEach((x, rank) => score.set(x.c.id, (score.get(x.c.id) || 0) + 1 / (60 + rank))));
  const byId = new Map(chunks.map(c => [c.id, c]));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => byId.get(id));
}

/* ---------- Источники знаний ---------- */
const geminiOK = () => configured().includes("gemini") && !isBlocked("gemini");
export async function fromUrl(url) {
  let text = "";
  try { text = await readUrl(url); } catch {}
  if (text.length < 200) {
    if (!geminiOK()) throw new Error("Не получилось прочитать страницу. Скопируй текст и вставь его вручную.");
    text = await geminiExtract([{ text: "Перепиши полностью основной текст страницы " + url + " (без меню и рекламы), сохранив все факты, цифры и структуру. Только текст." }], true);
  }
  const title = (text.match(/^Title:\s*(.+)$/m) || [])[1] || url.replace(/^https?:\/\//, "").slice(0, 80);
  return { title, text: text.replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, "").trim() };
}
export async function fromFile(file) {
  const name = file.name || "файл";
  if (/^text\/|\.(txt|md|csv|json|html?)$/i.test(file.type + " " + name)) return { title: name, text: await file.text() };
  if (!geminiOK()) throw new Error("Читать PDF и фото умеет только Gemini (нужен ключ и VPN). Текстовые файлы читаются всегда.");
  if (file.size > 18 * 1024 * 1024) throw new Error("Файл слишком большой (больше 18 МБ).");
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
  const mime = file.type || (/\.pdf$/i.test(name) ? "application/pdf" : "image/jpeg");
  const text = await geminiExtract([{ text: "Извлеки весь текст из этого документа или изображения дословно, сохраняя структуру (заголовки, списки, таблицы как текст). Если это фото без текста — подробно опиши, что на нём. Только результат." }, { inline_data: { mime_type: mime, data: b64 } }]);
  return { title: name, text };
}
async function geminiExtract(parts, withUrl) {
  const models = (D.meta.models && D.meta.models.chat) || ["gemini-flash-latest"];
  let last;
  for (const model of models.slice(0, 3)) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(S.geminiKey.trim())}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], ...(withUrl ? { tools: [{ url_context: {} }] } : {}), generationConfig: { temperature: 0 } }),
      });
      if (!res.ok) { let m = ""; try { m = (await res.json()).error.message; } catch {} throw Object.assign(new Error(m || "HTTP " + res.status), { status: res.status }); }
      const j = await res.json();
      return ((j.candidates?.[0]?.content?.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    } catch (e) { last = e; if (![404, 429, 500, 503].includes(e.status)) throw e; }
  }
  throw last;
}
/* Сжатый конспект для заголовка/описания документа (по желанию). */
export async function summarize(title, text) {
  return plain("Ты делаешь короткие конспекты. По-русски.", `Документ «${title}». Сделай конспект в 3–5 предложениях: о чём он и главное.\n\n${text.slice(0, 20000)}`);
}
