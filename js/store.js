/* Хранилище. Мелкие данные — localStorage, база знаний и векторы — IndexedDB.
   Всё лежит только на телефоне. */
const LS = "dp:";
export const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
export const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } };
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

export const DEFAULTS = {
  brain: "auto",                 // auto | gemini | mistral | zai | claude | custom
  geminiKey: "", geminiModel: "auto",
  mistralKey: "", mistralModel: "mistral-medium-latest",
  zaiKey: "", zaiModel: "glm-4.7-flash",
  claudeKey: "", claudeModel: "claude-sonnet-5-5",
  customBase: "", customKey: "", customModel: "",
  tavilyKey: "",
  voiceMode: "local",            // local (нейросеть на телефоне) | live (Gemini) | ios
  piperVoice: "ru_RU-dmitri-medium", pace: 1.08,   // спокойный темп: чуть медленнее обычного
  liveVoice: "Charon", iosVoice: "", rate: 1.0,
  speakOn: true, handsFree: true, autoReminders: false, briefing: true,
  sttMode: "auto",               // auto | neural | ios
};

function migrate(s) {
  // Настройки версии 2: provider/geminiKey/claudeKey/oa*
  if (s.provider) {
    if (s.provider === "claude") s.brain = "claude";
    if (s.provider === "openai" && s.oaKey) { s.customBase = s.oaBase || ""; s.customKey = s.oaKey; s.customModel = s.oaModel || ""; s.brain = "custom"; }
    if (s.voice) s.iosVoice = s.voice;
    delete s.provider; delete s.oaBase; delete s.oaKey; delete s.oaModel; delete s.voice;
  }
  if (/^gemini-2\.5-/.test(s.geminiModel || "") || /latest$/.test(s.geminiModel || "")) s.geminiModel = "auto";
  // 3.5: живой голос Gemini почти всегда упирался в лимит — по умолчанию голос на телефоне
  if (!s.voiceMig35) { if (s.voiceMode === "live") s.voiceMode = "local"; s.voiceMig35 = true; }
  return s;
}
export const S = Object.assign({}, DEFAULTS, migrate(load("settings", {})));
export const saveSettings = () => save("settings", S);

export const D = {
  msgs: load("msgs", []),         // {role:'user'|'ai', text, ts, sources?, photo?, mode?, rating?}
  facts: load("facts", []),       // {id, text, cat, imp(1-10), ts, used, status:'active'|'old', pinned?}
  core: load("core", { profile: "", goals: "", people: "", preferences: "" }),
  tasks: load("tasks", []),       // {id, text, due, repeat, done, notified, ts}
  notes: load("notes", []),       // {id, text, ts}
  diary: load("diary", { text: "", upTo: 0 }),
  skills: load("skills", []),     // {id, name, desc, trigger, steps, uses, ts}
  lessons: load("lessons", []),   // {id, text, ts}
  insights: load("insights", []), // {id, text, ts}
  cards: load("cards", []),       // {id, q, a, topic, due, ivl, ease, reps, ts}
  docs: load("docs", []),         // {id, title, kind, ts, chunks, chars}
  meta: load("meta", { lastTidy: 0, lastReflect: 0, lastBrief: "", impSinceReflect: 0, tempChat: false, models: null }),
};
// Старые факты без новых полей
D.facts.forEach(f => { f.cat = f.cat || "другое"; f.imp = f.imp || 5; f.status = f.status || "active"; f.used = f.used || f.ts || Date.now(); });

const KEYS = ["msgs", "facts", "core", "tasks", "notes", "diary", "skills", "lessons", "insights", "cards", "docs", "meta"];
let onQuota = () => {};
export const setQuotaHandler = f => { onQuota = f; };
/* Сохранить всё. Если память телефона переполнена — ужимаем переписку и пробуем ещё раз. */
export function persist() {
  const write = n => KEYS.reduce((ok, k) => save(k, k === "msgs" ? D.msgs.slice(-n) : D[k]) && ok, true);
  if (write(500)) return true;
  D.msgs = D.msgs.slice(-150).map(m => { const c = { ...m }; delete c.sources; return c; });
  const ok = write(150);
  try { onQuota(ok); } catch {}
  return ok;
}
export async function exportAll(withMsgs = true) {
  const o = { app: "dmitriy-pavlov", v: 3, at: new Date().toISOString() };
  KEYS.forEach(k => { if (k !== "msgs" || withMsgs) o[k] = D[k]; });
  try { o.chunks = await idbAll("chunks"); } catch { o.chunks = []; }   // тексты базы знаний
  return o;
}
const isObj = x => x && typeof x === "object" && !Array.isArray(x);
/* Восстановление: сначала проверяем всё, и только потом заменяем — испорченная копия ничего не сломает. */
export async function importAll(o) {
  if (!isObj(o)) throw new Error("bad");
  const next = {};
  for (const k of KEYS) {
    if (o[k] === undefined) continue;
    if (Array.isArray(D[k])) {
      if (!Array.isArray(o[k]) || !o[k].every(isObj)) throw new Error("bad " + k);
      next[k] = o[k];
    } else {
      if (!isObj(o[k])) throw new Error("bad " + k);
      next[k] = { ...D[k], ...o[k] };
    }
  }
  if (next.facts) next.facts.forEach(f => { f.text = String(f.text || ""); f.cat = f.cat || "другое"; f.imp = f.imp || 5; f.status = f.status || "active"; f.used = f.used || f.ts || Date.now(); });
  if (next.facts) next.facts = next.facts.filter(f => f.text && f.id);
  const chunks = Array.isArray(o.chunks) ? o.chunks.filter(c => isObj(c) && c.id && c.docId && typeof c.text === "string") : null;
  Object.assign(D, next);
  if (chunks && chunks.length) {
    await idbPut("chunks", chunks);
    D.docs.forEach(d => { d.vec = false; });   // векторы пересчитаем
  }
  persist();
}

/* ---------- IndexedDB: куски документов и векторы ---------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open("dmitriy-pavlov", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { keyPath: "id" }).createIndex("doc", "docId");
      if (!d.objectStoreNames.contains("vecs")) d.createObjectStore("vecs", { keyPath: "id" });
    };
    r.onsuccess = () => { const d = r.result; d.onclose = () => { dbp = null; }; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}
/* iOS после сворачивания может разорвать связь с базой — тогда открываем заново и повторяем один раз. */
function tx(store, mode, fn, retry = true) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); const st = t.objectStore(store);
    const res = fn(st);
    t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("abort"));
  })).catch(e => {
    if (retry && e && (e.name === "InvalidStateError" || /connection|closing|lost/i.test(e.message || ""))) { dbp = null; return tx(store, mode, fn, false); }
    throw e;
  });
}
export const idbPut = (store, items) => tx(store, "readwrite", st => { arrOf(items).forEach(i => st.put(i)); });
export const idbAll = store => tx(store, "readonly", st => st.getAll());
export const idbDel = (store, ids) => tx(store, "readwrite", st => { arrOf(ids).forEach(i => st.delete(i)); });
export const idbClear = store => tx(store, "readwrite", st => st.clear());
const arrOf = x => Array.isArray(x) ? x : [x];
export async function idbDelDoc(docId) {
  const chunks = await idbAll("chunks");
  const ids = chunks.filter(c => c.docId === docId).map(c => c.id);
  if (ids.length) { await idbDel("chunks", ids); await idbDel("vecs", ids); }
}
