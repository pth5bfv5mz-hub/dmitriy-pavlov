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
  voiceMode: "live",             // live (нейросеть) | ios
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
export function persist() {
  let ok = true;
  KEYS.forEach(k => { ok = save(k, k === "msgs" ? D.msgs.slice(-500) : D[k]) && ok; });
  return ok;
}
export function exportAll(withMsgs = true) {
  const o = { app: "dmitriy-pavlov", v: 3, at: new Date().toISOString() };
  KEYS.forEach(k => { if (k !== "msgs" || withMsgs) o[k] = D[k]; });
  return o;
}
export function importAll(o) {
  if (!o || typeof o !== "object") throw new Error("bad");
  KEYS.forEach(k => { if (o[k] !== undefined && (Array.isArray(o[k]) === Array.isArray(D[k]))) D[k] = o[k]; });
  D.facts.forEach(f => { f.cat = f.cat || "другое"; f.imp = f.imp || 5; f.status = f.status || "active"; });
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
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); const st = t.objectStore(store);
    const res = fn(st);
    t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
    t.onerror = () => reject(t.error);
  }));
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
