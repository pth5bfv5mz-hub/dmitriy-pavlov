/* Хранилище. Мелкие данные — localStorage, база знаний и векторы — IndexedDB.
   Всё лежит только на телефоне. */
const LS = "dp:";
export const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
export const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } };
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

export const DEFAULTS = {
  brain: "auto",                 // auto | gemini | mistral | zai | openrouter | claude | custom
  geminiKey: "", geminiModel: "auto",
  mistralKey: "", mistralModel: "mistral-medium-latest",
  zaiKey: "", zaiModel: "glm-4.7-flash",
  openrouterKey: "", openrouterModel: "auto",
  claudeKey: "", claudeModel: "claude-sonnet-5-5",
  customBase: "", customKey: "", customModel: "",
  tavilyKey: "",
  voiceMode: "local",            // local (нейросеть на телефоне) | live (Gemini) | ios
  piperVoice: "ru_RU-ruslan-medium", pace: 1.08,   // спокойный темп: чуть медленнее обычного
  liveVoice: "Charon", iosVoice: "", rate: 1.0,
  speakOn: true, handsFree: true, autoReminders: false, briefing: true,
  talkPause: "2.5",               // сек тишины, после которых фраза считается законченной
  talkOnOpen: true,              // при открытии сразу экран разговора: одно касание — и он здоровается и слушает
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
  // 3.6: «Дмитрий» из Piper оказался высоковат — по умолчанию низкий спокойный «Руслан»
  if (!s.voiceMig36) { if (s.piperVoice === "ru_RU-dmitri-medium") { s.piperVoice = "ru_RU-ruslan-medium"; s.voiceSwitched = true; } s.voiceMig36 = true; }
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
  mistakes: load("mistakes", []), // журнал недочётов: {id, what, why, fix, q, src, count, ts, last, status:'open'|'fixed'}
  insights: load("insights", []), // {id, text, ts}
  cards: load("cards", []),       // {id, q, a, topic, due, ivl, ease, reps, ts}
  docs: load("docs", []),         // {id, title, kind, ts, chunks, chars}
  meta: load("meta", { lastTidy: 0, lastReflect: 0, lastBrief: "", impSinceReflect: 0, tempChat: false, models: null }),
};
// Инкогнито живёт только до закрытия приложения: на диске его разговоров нет, флаг сбрасываем
D.meta.tempChat = false;
D.msgs = D.msgs.filter(m => !m.temp);
// Старые факты без новых полей
D.facts.forEach(f => { f.cat = f.cat || "другое"; f.imp = f.imp || 5; f.status = f.status || "active"; f.used = f.used || f.ts || Date.now(); });

const KEYS = ["msgs", "facts", "core", "tasks", "notes", "diary", "skills", "lessons", "mistakes", "insights", "cards", "docs", "meta"];
let onQuota = () => {};
export const setQuotaHandler = f => { onQuota = f; };
/* Сохранить всё. Если память телефона переполнена — ужимаем переписку и пробуем ещё раз. */
let ver = 0;
export const dataVersion = () => ver;   // меняется при каждом сохранении — по нему видно, что резервная копия устарела
export function persist() {
  ver++;
  // Сообщения инкогнито на диск не пишем
  const val = (k, n) => k === "msgs" ? D.msgs.filter(m => !m.temp).slice(-n) : k === "meta" ? { ...D.meta, tempChat: false } : D[k];
  const write = n => KEYS.filter(k => !save(k, val(k, n)));
  let failed = write(500);
  if (!failed.length) return true;
  // Место кончилось. Сокращаем переписку, только если она правда занимает заметную долю, —
  // иначе резать её бессмысленно (место занимают материалы или факты).
  const size = k => { try { return JSON.stringify(D[k]).length; } catch { return 0; } };
  const total = KEYS.reduce((t, k) => t + size(k), 0);
  if (size("msgs") > total * 0.25) {
    D.msgs = D.msgs.slice(-150).map(m => { const c = { ...m }; delete c.sources; return c; });
    failed = write(150);
  }
  const ok = !failed.length;
  try { onQuota(ok); } catch {}
  return ok;
}
export async function exportAll(withMsgs = true) {
  const o = { app: "dmitriy-pavlov", v: 3, at: new Date().toISOString() };
  KEYS.forEach(k => { if (k !== "msgs" || withMsgs) o[k] = k === "msgs" ? D.msgs.filter(m => !m.temp) : k === "meta" ? { ...D.meta, tempChat: false } : D[k]; });
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
  // Копия могла быть изменена кем-то: приводим поля к ожидаемым типам — id только из букв и цифр,
  // числа — числами в разумных пределах. Иначе подделанная копия могла бы вставить код в страницу.
  for (const k of Object.keys(next)) if (Array.isArray(next[k])) next[k] = next[k].map(cleanItem).filter(Boolean);
  if (next.facts) next.facts.forEach(f => { f.text = String(f.text || ""); f.cat = String(f.cat || "другое"); f.imp = clampNum(f.imp, 1, 10, 5); f.status = f.status === "old" ? "old" : "active"; f.used = f.used || f.ts || Date.now(); });
  if (next.facts) next.facts = next.facts.filter(f => f.text && f.id);
  if (next.tasks) next.tasks.forEach(t => { if (!Object.hasOwn(REPEAT_KEYS, t.repeat)) t.repeat = null; });
  const chunks = Array.isArray(o.chunks) ? o.chunks.filter(c => isObj(c) && c.id && c.docId && typeof c.text === "string").map(c => ({ id: safeId(c.id), docId: safeId(c.docId), n: clampNum(c.n, 0, 1e7, 0), title: String(c.title || ""), text: c.text })) : null;
  if (next.docs && next.docs.length && !(chunks && chunks.length)) throw new Error("bad: docs without text");
  Object.assign(D, next);
  if (next.docs) {   // база знаний заменяется целиком — старые фрагменты и векторы убираем
    try { await idbClear("chunks"); await idbClear("vecs"); } catch {}
    if (chunks && chunks.length) for (let i = 0; i < chunks.length; i += 500) await idbPut("chunks", chunks.slice(i, i + 500));
    D.docs.forEach(d => { d.vec = false; });   // векторы пересчитаем
  }
  persist();
}
const REPEAT_KEYS = { daily: 1, weekdays: 1, weekly: 1, monthly: 1, yearly: 1 };
const safeId = v => { const s = String(v ?? ""); return /^[\w:.-]{1,80}$/.test(s) ? s : "x" + Math.random().toString(36).slice(2, 12); };
const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const NUMS = { ts: [0, 4e12], due: [0, 4e12], used: [0, 4e12], last: [0, 4e12], notifiedAt: [0, 4e12], validTo: [0, 4e12], fixedAt: [0, 4e12],
  imp: [1, 10], anchor: [1, 31], chunks: [0, 1e7], chars: [0, 1e10], pages: [0, 1e6], uses: [0, 1e7], count: [0, 1e7], ivl: [0, 1e5], ease: [1, 5], reps: [0, 1e6], rating: [-1, 1] };
function cleanItem(x) {
  if (!isObj(x)) return null;
  const y = { ...x };
  if ("id" in y) y.id = safeId(y.id);
  for (const [k, [lo, hi]] of Object.entries(NUMS)) if (k in y && y[k] !== null) y[k] = clampNum(y[k], lo, hi, k === "imp" ? 5 : 0);
  return y;
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
/* Записи с ключами по префиксу (например, векторы фактов «f:…») — без чтения векторов документов. */
export const idbPrefix = (store, p, keysOnly) => tx(store, "readonly", st => { const r = IDBKeyRange.bound(p, p + "\uffff"); return keysOnly ? st.getAllKeys(r) : st.getAll(r); });
/* Фрагменты одного материала — по индексу, без чтения всей базы. */
export const idbDocChunks = docId => tx("chunks", "readonly", st => st.index("doc").getAll(docId));
export async function idbDelDoc(docId) {
  const ids = (await idbDocChunks(docId)).map(c => c.id);
  if (ids.length) { await idbDel("chunks", ids); await idbDel("vecs", ids); }
}
