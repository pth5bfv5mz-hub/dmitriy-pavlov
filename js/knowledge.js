/* База знаний: тексты, ссылки, документы и фото, которые Сумрак даёт Дмитрию «изучить».
   Большие PDF и Word (сотни страниц) читаются прямо на телефоне — без нейросети и без лимитов.
   Текст режется на фрагменты; поиск — по словам (всегда) и по смыслу (векторы Gemini, если доступен),
   результаты объединяются (reciprocal rank fusion). Индекс строится один раз и держится в памяти. */
import { D, S, persist, idbPut, idbAll, idbDelDoc, idbDocChunks } from "./store.js";
import { uid, terms, cosine } from "./util.js";
import { embed, canEmbed, readUrl, plain, configured, isBlocked, anyBrain, gHeaders } from "./brains.js";

function chunkText(text, size = 1100, overlap = 180) {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = []; let cur = "", page = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); };
  for (const p of paras) {
    const pm = p.match(/^\[стр\. (\d+)\]$/); if (pm) { page = pm[1]; if (cur) cur += "\n\n" + p; else cur = p; continue; }
    if ((cur + "\n\n" + p).length <= size) { cur = cur ? cur + "\n\n" + p : p; continue; }
    push();
    const lead = page && !/^\[стр\./.test(p) ? `[стр. ${page}] ` : "";
    if (p.length <= size) { cur = (cur ? cur.slice(-overlap) + "\n\n" : "") + lead + p; continue; }
    for (let i = 0; i < p.length; i += size - overlap) out.push(lead + p.slice(i, i + size));
    cur = "";
  }
  push();
  return out;
}

/* ---------- Индекс в памяти (перестраивается при изменении базы) ---------- */
let index = null;
const signature = () => D.docs.map(d => d.id + ":" + (d.vec ? 1 : 0)).join(",");
async function getIndex() {
  if (index && index.sig === signature()) return index;
  // Только фрагменты документов, которые есть в списке (остатки удалённых или прерванных — не в счёт)
  const ids = new Set(D.docs.map(d => d.id));
  const chunks = (await idbAll("chunks")).filter(c => ids.has(c.docId) && !c.full);   // полный текст — не фрагмент поиска
  const tokens = chunks.map(c => terms(c.title + " " + c.text));
  const df = new Map(); tokens.forEach(t => new Set(t).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const tf = tokens.map(t => { const m = new Map(); t.forEach(w => m.set(w, (m.get(w) || 0) + 1)); return m; });
  const avg = tokens.reduce((n, t) => n + t.length, 0) / (chunks.length || 1) || 1;
  const vecRows = await idbAll("vecs");
  const vecs = new Map(vecRows.filter(v => !v.id.startsWith("f:")).map(v => [v.id, v]));
  index = { sig: signature(), chunks, tf, len: tokens.map(t => t.length), df, avg, vecs };
  return index;
}
export const invalidate = () => { index = null; };

/* ---------- Добавление ---------- */
export async function addDoc(title, text, kind = "текст", { pages = 0, onProgress, background = false } = {}) {
  text = String(text || "").trim();
  if (text.length < 20) throw new Error("Слишком мало текста.");
  const docId = uid();
  const parts = chunkText(text);
  const chunks = parts.map((t, i) => ({ id: docId + ":" + i, docId, title, n: i, text: t }));
  onProgress && onProgress(`Сохраняю ${chunks.length} фрагментов…`);
  try {
    for (let i = 0; i < chunks.length; i += 200) await idbPut("chunks", chunks.slice(i, i + 200));
    // Полный текст целиком — чтобы исправлять документ и проходить его от начала до конца, а не только искать отрывки
    if (text.length <= 3e6) await idbPut("chunks", { id: docId + ":full", docId, n: -1, full: true, title, text });
  }
  catch (e) { await idbDelDoc(docId).catch(() => {}); throw new Error("Не хватило места в памяти телефона для этого материала."); }
  const doc = { id: docId, title: String(title).slice(0, 120), kind, ts: Date.now(), chunks: chunks.length, chars: text.length, pages, vec: false, preview: text.slice(0, 200), summary: "" };
  D.docs.push(doc); persist(); invalidate();
  if (canEmbed()) {
    embedding.add(docId);
    try { await embedChunks(doc, chunks, onProgress); } catch {}   // не вышло — досчитаем позже
    finally { embedding.delete(docId); }
  }
  if (anyBrain()) {
    onProgress && !background && onProgress("Делаю конспект…");
    const p = summarize(title, text).then(s => { doc.summary = String(s || "").trim().slice(0, 1500); persist(); }).catch(() => {});
    if (!background) await p;
  }
  invalidate();
  return doc;
}
async function embedChunks(doc, chunks, onProgress) {
  const step = 90 * 4;
  for (let i = 0; i < chunks.length; i += step) {
    onProgress && onProgress(`Учу смысл: ${Math.min(i + step, chunks.length)} из ${chunks.length}…`);
    const part = chunks.slice(i, i + step);
    const r = await embed(part.map(c => `${doc.title}\n${c.text}`), "RETRIEVAL_DOCUMENT");
    if (!r) return;
    if (!D.docs.some(d => d.id === doc.id)) return;   // материал удалили, пока считали
    await idbPut("vecs", part.map((c, j) => ({ id: c.id, v: r.vecs[j], m: r.model })));
  }
  doc.vec = true; persist();
}
const embedding = new Set();   // материалы, для которых векторы считаются прямо сейчас (не считать дважды)
export async function removeDoc(id) { await idbDelDoc(id); D.docs = D.docs.filter(d => d.id !== id); persist(); invalidate(); }
/* Досчитать векторы для документов, добавленных без Gemini или прерванных лимитом. */
export async function ensureDocVecs() {
  if (!canEmbed()) return;
  for (const d of D.docs.filter(d => !d.vec && !embedding.has(d.id))) {
    embedding.add(d.id);
    try {
      const chunks = (await idbDocChunks(d.id)).filter(c => !c.full).sort((a, b) => a.n - b.n);
      if (!chunks.length) continue;   // текст материала утерян — нечего считать
      await embedChunks(d, chunks);
      invalidate();
    } catch { return; }
    finally { embedding.delete(d.id); }
  }
}

/* ---------- Поиск ---------- */
export async function search(query, k) {
  if (!D.docs.length) return [];
  const ix = await getIndex(); const N = ix.chunks.length; if (!N) return [];
  k = k || (N > 300 ? 6 : 4);
  const qt = [...new Set(terms(query))]; if (!qt.length) return [];
  // Ключевые слова (BM25)
  const bm = [];
  for (let i = 0; i < N; i++) {
    let s = 0; const tf = ix.tf[i];
    for (const q of qt) {
      const f = tf.get(q); if (!f) continue;
      const df = ix.df.get(q) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * ix.len[i] / ix.avg));
    }
    if (s > 0) bm.push({ i, s });
  }
  bm.sort((a, b) => b.s - a.s);
  // Смысловой поиск
  let vs = [];
  if (canEmbed() && ix.vecs.size) {
    try {
      const r = await embed([query], "RETRIEVAL_QUERY");
      if (r) for (let i = 0; i < N; i++) {
        const v = ix.vecs.get(ix.chunks[i].id); if (!v || (v.m && v.m !== r.model)) continue;
        const s = cosine(r.vecs[0], v.v); if (s > 0.55) vs.push({ i, s });
      }
      vs.sort((a, b) => b.s - a.s);
    } catch {}
  }
  const score = new Map();
  [bm, vs].forEach(list => list.slice(0, 30).forEach((x, rank) => score.set(x.i, (score.get(x.i) || 0) + 1 / (60 + rank))));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => ix.chunks[i]);
}
/* Полный текст материала (для старых материалов без него — склеиваем фрагменты). */
export async function docFull(docId) {
  const all = await idbDocChunks(docId);
  const f = all.find(c => c.full); if (f) return f.text;
  return all.filter(c => !c.full).sort((a, b) => a.n - b.n).map(c => c.text).join("\n\n");
}
/* Пройти весь большой документ частями: из каждой части нейросеть выписывает то, что нужно для задачи,
   потом ответ строится по этой выжимке. 200 страниц ≈ 6–8 запросов (поэтому — только для задач «по всему документу»). */
export async function deepPass(title, text, task, ask, { onProgress = () => {}, signal } = {}) {
  const PART = 45000, parts = [];
  for (let i = 0; i < text.length; i += PART) {
    let end = Math.min(text.length, i + PART);
    const cut = text.lastIndexOf("\n", end); if (end < text.length && cut > i + PART * 0.7) end = cut;   // не рвём абзац
    parts.push(text.slice(i, end)); i = end - PART;
  }
  const notes = [];
  for (let k = 0; k < parts.length; k++) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    onProgress(k + 1, parts.length);
    const pages = (parts[k].match(/\[стр\. (\d+)\]/g) || []).map(s => s.match(/\d+/)[0]);
    const r = await ask(`Задача Сумрака: ${task}\n\nНиже часть ${k + 1} из ${parts.length} документа «${title}»${pages.length ? ` (стр. ${pages[0]}–${pages[pages.length - 1]})` : ""}.\nВыпиши из этой части ВСЁ, что нужно для задачи, — точно, с цифрами, датами и номерами страниц, без пересказа лишнего. Если в этой части нет ничего подходящего — ответь одним символом «—».\n\n${parts[k]}`);
    const t = String(r || "").trim();
    if (t && t !== "—" && t !== "-") notes.push(`[часть ${k + 1}${pages.length ? `, стр. ${pages[0]}–${pages[pages.length - 1]}` : ""}]\n${t}`);
  }
  return { parts: parts.length, notes: notes.join("\n\n") };
}
/* Список материалов с конспектами — чтобы Дмитрий знал, что у Сумрака есть. */
export function docsForPrompt() {
  return D.docs.slice(-15).map(d => `- «${d.title}» (${d.kind}${d.pages ? ", " + d.pages + " стр." : ""})${d.summary ? ": " + d.summary.slice(0, 350).replace(/\n+/g, " ") : ""}`).join("\n");
}

/* ---------- Чтение источников ---------- */
const geminiOK = () => configured().includes("gemini") && !isBlocked("gemini");
const scripts = {};
function loadScript(src) {
  return scripts[src] || (scripts[src] = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => { delete scripts[src]; rej(new Error("Не загрузилась библиотека чтения документов. Проверь интернет.")); };
    document.head.append(s);
  }));
}
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
export async function fromFile(file, onProgress = () => {}) {
  const name = file.name || "файл";
  const type = (file.type || "") + " " + name;
  if (/\.pdf$|application\/pdf/i.test(type)) return readPdf(file, onProgress);
  if (/\.docx$|wordprocessingml/i.test(type)) {
    onProgress("Открываю документ Word…");
    await loadScript("lib/mammoth.browser.min.js");
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { title: name.replace(/\.docx$/i, ""), text: r.value, kind: "Word" };
  }
  if (/^text\/|\.(txt|md|csv|json|html?|xml|rtf|log)$/i.test(type)) return { title: name, text: await file.text(), kind: "файл" };
  if (/image\//i.test(type)) {
    if (!geminiOK()) throw new Error("Читать фото умеет Gemini (нужен ключ и VPN).");
    const b64 = await fileB64(file);
    const text = await geminiExtract([{ text: "Извлеки весь текст с изображения дословно, сохраняя структуру. Если текста нет — подробно опиши, что на нём. Только результат." }, { inline_data: { mime_type: file.type || "image/jpeg", data: b64 } }]);
    return { title: name, text, kind: "фото" };
  }
  throw new Error("Этот формат я пока не читаю. Подойдут PDF, Word (.docx), текстовые файлы и фото.");
}
const fileB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });

async function readPdf(file, onProgress) {
  onProgress("Открываю PDF…");
  await loadScript("lib/pdf.min.js");
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try { return await readPdfPages(pdf, file, onProgress); }
  finally { try { pdf.destroy(); } catch {} }   // освобождаем память документа (на iPhone её мало)
}
async function readPdfPages(pdf, file, onProgress) {
  const n = pdf.numPages; const pages = [];
  for (let i = 1; i <= n; i++) {
    if (i % 5 === 1 || i === n) onProgress(`Читаю страницы: ${i} из ${n}…`);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let t = ""; for (const it of tc.items) { t += it.str; t += it.hasEOL ? "\n" : " "; }
    pages.push(t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim());
    page.cleanup();
  }
  const textChars = pages.reduce((a, p) => a + p.length, 0);
  const title = file.name.replace(/\.pdf$/i, "");
  // Почти нет текста — это скан. Распознаём через Gemini пачками страниц-картинок.
  if (textChars < n * 40) {
    if (!geminiOK()) throw new Error("Это скан без текстового слоя. Распознать его может Gemini (нужен ключ и VPN).");
    const max = Math.min(n, 120);
    for (let i = 1; i <= max; i += 5) {
      const imgs = [];
      for (let j = i; j < i + 5 && j <= max; j++) imgs.push(await renderPage(pdf, j));
      onProgress(`Распознаю скан: страницы ${i}–${Math.min(i + 4, max)} из ${max}…`);
      const text = await geminiExtract([{ text: `Это страницы ${i}–${Math.min(i + 4, max)} документа. Распознай весь текст дословно. Перед текстом каждой страницы пиши строку [стр. N]. Только текст.` },
        ...imgs.map(b64 => ({ inline_data: { mime_type: "image/jpeg", data: b64 } }))]);
      for (let j = i; j < i + 5 && j <= max; j++) pages[j - 1] = "";
      pages[i - 1] = text;
    }
    return { title, text: pages.filter(Boolean).join("\n\n"), kind: "PDF (скан)", pages: n, note: n > max ? `Распознал первые ${max} страниц из ${n}.` : "" };
  }
  return { title, text: pages.map((p, i) => p ? `[стр. ${i + 1}]\n\n${p}` : "").filter(Boolean).join("\n\n"), kind: "PDF", pages: n };
}
async function renderPage(pdf, i) {
  const page = await pdf.getPage(i);
  const vp = page.getViewport({ scale: 1.4 });
  const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  page.cleanup();
  const b64 = c.toDataURL("image/jpeg", 0.7).split(",")[1];
  c.width = c.height = 0;   // iPhone ограничивает общую память холстов — освобождаем сразу
  return b64;
}
async function geminiExtract(parts, withUrl) {
  const models = [...((D.meta.models && D.meta.models.lite) || []), ...((D.meta.models && D.meta.models.chat) || []), "gemini-flash-lite-latest", "gemini-flash-latest"];
  let last;
  for (const model of [...new Set(models)].slice(0, 5)) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: gHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ contents: [{ role: "user", parts }], ...(withUrl ? { tools: [{ url_context: {} }] } : {}), generationConfig: { temperature: 0 } }),
      });
      if (!res.ok) { let m = ""; try { m = (await res.json()).error.message; } catch {} throw Object.assign(new Error(m || "HTTP " + res.status), { status: res.status }); }
      const j = await res.json();
      return ((j.candidates?.[0]?.content?.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    } catch (e) { last = e; if (![400, 403, 404, 429, 500, 503].includes(e.status)) throw e; }
  }
  throw last;
}
/* Конспект документа: начало, заголовки и выборка из середины и конца — одним запросом. */
export async function summarize(title, text) {
  const heads = (text.match(/^.{3,90}$/gm) || []).filter(l => /^(глава|раздел|часть|chapter|section|\d+(\.\d+)*\s)/i.test(l.trim())).slice(0, 60).join("\n");
  const L = text.length;
  const sample = L <= 24000 ? text : [text.slice(0, 12000), text.slice(L / 2 - 3000, L / 2 + 3000), text.slice(-5000)].join("\n…\n");
  return plain("Ты делаешь конспекты документов для личного ассистента. По-русски, ёмко, без воды.",
    `Документ «${title}» (${Math.round(L / 1800)} стр. примерно).\n${heads ? "Заголовки:\n" + heads + "\n\n" : ""}Фрагменты:\n${sample}\n\nНапиши конспект до 1200 символов: о чём документ, его структура (главные разделы), ключевые идеи, цифры и выводы.`);
}
