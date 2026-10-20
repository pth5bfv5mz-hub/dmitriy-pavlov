/* Память и обучение.
   - Профиль (ядро): короткие блоки о Сумраке, всегда в контексте.
   - Факты: важность 1–10, тема, свежесть. В контекст попадают самые нужные (важность + свежесть + близость к теме).
   - Устаревшие факты не стираются, а помечаются «устарело» — так не теряется история.
   - Навыки («научись»), уроки (из поправок и оценок), выводы (рефлексия раз в день), дневник разговоров. */
import { D, persist, idbPut, idbAll, idbDel } from "./store.js";
import { uid, arr, terms, cosine, parseLocal, REPEAT_TXT, isoLocal, todayKey, parseJSON } from "./util.js";
import { plain, embed, canEmbed } from "./brains.js";

export const CATS = ["личное", "люди", "работа", "учёба", "здоровье", "деньги", "цели", "предпочтения", "другое"];
export const normCat = c => { c = String(c || "").toLowerCase().trim(); return CATS.includes(c) ? c : "другое"; };
export const activeFacts = () => D.facts.filter(f => f.status !== "old");

/* ---------- Отбор фактов для ответа ---------- */
let qVecCache = { q: "", v: null };
export async function relevantFacts(query, limit = 45) {
  const facts = activeFacts();
  if (facts.length <= limit) { touch(facts); return facts; }
  const qt = new Set(terms(query));
  let vecs = null, qv = null;
  if (canEmbed()) {
    try {
      const stored = await idbAll("vecs"); vecs = new Map(stored.filter(v => v.id.startsWith("f:")).map(v => [v.id.slice(2), v.v]));
      if (qVecCache.q === query) qv = qVecCache.v; else { const r = await embed([query], "RETRIEVAL_QUERY"); qv = r && r.vecs[0]; qVecCache = { q: query, v: qv }; }
    } catch { vecs = null; }
  }
  const now = Date.now();
  const raw = facts.map(f => {
    const kw = terms(f.text).filter(t => qt.has(t)).length;
    const v = vecs && qv && vecs.get(f.id);
    return { f, rel: v ? cosine(qv, v) : Math.min(1, kw / 3), imp: (f.imp || 5) / 10, rec: Math.pow(0.995, (now - (f.used || f.ts)) / 36e5) };
  });
  const norm = k => { const xs = raw.map(r => r[k]), lo = Math.min(...xs), hi = Math.max(...xs); raw.forEach(r => r[k + "N"] = hi > lo ? (r[k] - lo) / (hi - lo) : 0.5); };
  ["rel", "imp", "rec"].forEach(norm);
  raw.forEach(r => r.score = r.relN * 1.2 + r.impN + r.recN * 0.6 + (r.f.pinned ? 3 : 0));
  const top = raw.sort((a, b) => b.score - a.score).slice(0, limit).map(r => r.f);
  touch(top.filter(f => qt.size && terms(f.text).some(t => qt.has(t))));
  return top;
}
function touch(list) { const now = Date.now(); list.forEach(f => { f.used = now; }); }
async function embedFacts(list) {
  if (!canEmbed() || !list.length) return;
  try { const r = await embed(list.map(f => f.text), "RETRIEVAL_DOCUMENT"); if (r) await idbPut("vecs", list.map((f, i) => ({ id: "f:" + f.id, v: Array.from(r.vecs[i]) }))); } catch {}
}
export async function ensureFactVecs() {
  if (!canEmbed()) return;
  try {
    const have = new Set((await idbAll("vecs")).map(v => v.id));
    const miss = activeFacts().filter(f => !have.has("f:" + f.id)).slice(0, 200);
    await embedFacts(miss);
  } catch {}
}

/* ---------- Навыки: в контекст — короткое описание; полный текст — если подходит к вопросу ---------- */
export function skillsForPrompt(query) {
  if (!D.skills.length) return "";
  const qt = new Set(terms(query));
  const total = D.skills.reduce((n, s) => n + (s.steps || "").length, 0);
  return D.skills.map(s => {
    const hit = total < 5000 || terms(s.name + " " + s.trigger + " " + s.desc).some(t => qt.has(t));
    return `- [${s.id}] «${s.name}» — ${s.desc}${s.trigger ? ` (когда: ${s.trigger})` : ""}${hit ? `\n  Как делать:\n  ${String(s.steps || "").replace(/\n/g, "\n  ")}` : ""}`;
  }).join("\n");
}

/* ---------- Служебный блок действий из ответа ---------- */
export function stripActions(text) {
  const i = text.indexOf("<<<");
  const vis = i >= 0 ? text.slice(0, i) : text.replace(/<{1,2}\s*$/, "");
  return vis.replace(/```\s*(json)?\s*$/i, "").trim();
}
export function extractActions(text) {
  const m = text.match(/<<<\s*ACTIONS([\s\S]*?)(ACTIONS\s*>>>|$)/);
  if (!m) return null;
  const body = m[1].trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
const TEACH_RE = /научись|научи|запомни|сохрани|навык|правило|впредь|всегда|никогда|в следующий раз|не так|неправильн|ошиб|поправ|да[,.! ]|верно|сохраняй|подтверждаю|^да$|ок\b|хорошо|давай|исправь|лучше/i;
/* userText — последнее сообщение Сумрака. Навыки и уроки создаются только по его словам,
   а не из найденных в интернете страниц (защита от «подброшенных» инструкций). */
export function applyActions(act, userText, { temp } = {}) {
  const out = { newTasks: [], remembered: [], learned: [], cards: 0 };
  if (!act || typeof act !== "object") return out;
  const now = Date.now();
  if (!temp) {
    const forget = arr(act.forget).map(String);
    D.facts.forEach(f => { if (forget.includes(f.id) && f.status !== "old") { f.status = "old"; f.validTo = now; } });
    const fresh = [];
    arr(act.remember).forEach(r => {
      const text = String(typeof r === "string" ? r : r && r.text || "").trim();
      if (!text || activeFacts().some(f => f.text.toLowerCase() === text.toLowerCase())) return;
      const f = { id: uid(), text, cat: normCat(r && r.cat), imp: Math.max(1, Math.min(10, +(r && r.imp) || 5)), ts: now, used: now, status: "active" };
      D.facts.push(f); fresh.push(f); out.remembered.push(text);
      D.meta.impSinceReflect = (D.meta.impSinceReflect || 0) + f.imp;
    });
    embedFacts(fresh);
    if (act.core && typeof act.core === "object") Object.keys(D.core).forEach(k => { if (typeof act.core[k] === "string" && act.core[k].trim()) D.core[k] = act.core[k].trim().slice(0, 1200); });
  }
  arr(act.tasks).forEach(t => {
    const text = String(typeof t === "string" ? t : t && t.text || "").trim(); if (!text) return;
    const due = t && t.due ? parseLocal(t.due) : null;
    const task = { id: uid(), text, due, repeat: due && REPEAT_TXT[t.repeat] ? t.repeat : null, done: false, notified: false, ts: now };
    D.tasks.push(task); out.newTasks.push(task);
  });
  arr(act.update_tasks).forEach(u => {
    const t = u && D.tasks.find(x => x.id === String(u.id)); if (!t) return;
    if (u.text) t.text = String(u.text);
    if (u.due !== undefined) { t.due = u.due ? parseLocal(u.due) : null; t.notified = false; }
    if (u.repeat !== undefined) t.repeat = REPEAT_TXT[u.repeat] ? u.repeat : null;
    out.newTasks.push(t);
  });
  const done = arr(act.done).map(String); D.tasks.forEach(t => { if (done.includes(t.id)) t.done = true; });
  const delT = arr(act.delete_tasks).map(String); D.tasks = D.tasks.filter(t => !delT.includes(t.id));
  arr(act.notes).forEach(t => { t = String(typeof t === "string" ? t : t && t.text || "").trim(); if (t) D.notes.push({ id: uid(), text: t, ts: now }); });
  const delN = arr(act.delete_notes).map(String); D.notes = D.notes.filter(n => !delN.includes(n.id));
  const taught = TEACH_RE.test(userText || "");
  if (taught) {
    arr(act.skills).forEach(s => {
      if (!s || !s.name || !s.steps) return;
      const ex = D.skills.find(x => x.name.toLowerCase() === String(s.name).toLowerCase());
      const rec = { name: String(s.name).slice(0, 80), desc: String(s.desc || "").slice(0, 300), trigger: String(s.trigger || "").slice(0, 200), steps: String(s.steps).slice(0, 4000) };
      if (ex) Object.assign(ex, rec, { ts: now }); else D.skills.push({ id: uid(), uses: 0, ts: now, ...rec });
      out.learned.push("навык «" + rec.name + "»");
    });
    arr(act.lessons).forEach(l => {
      const text = String(typeof l === "string" ? l : l && l.text || "").trim();
      if (text && !D.lessons.some(x => x.text === text)) { D.lessons.push({ id: uid(), text: text.slice(0, 400), ts: now }); out.learned.push("урок"); }
    });
  }
  arr(act.forget_skills).map(String).forEach(id => { D.skills = D.skills.filter(s => s.id !== id); });
  arr(act.used_skills).map(String).forEach(id => { const s = D.skills.find(x => x.id === id); if (s) s.uses = (s.uses || 0) + 1; });
  arr(act.cards).forEach(c => {
    if (!c || !c.q || !c.a) return;
    D.cards.push({ id: uid(), q: String(c.q).slice(0, 500), a: String(c.a).slice(0, 1500), topic: String(c.topic || "").slice(0, 60), due: now, ivl: 0, ease: 2.5, reps: 0, ts: now });
    out.cards++;
  });
  persist();
  return out;
}

/* ---------- Карточки: интервальное повторение (упрощённый SM-2) ---------- */
export const dueCards = () => D.cards.filter(c => c.due <= Date.now()).sort((a, b) => a.due - b.due);
export function gradeCard(card, g) {   // g: 0 снова, 1 трудно, 2 хорошо, 3 легко
  if (g === 0) { card.reps = 0; card.ivl = 0; card.ease = Math.max(1.3, card.ease - 0.2); card.due = Date.now() + 10 * 6e4; }
  else {
    card.reps++;
    card.ease = Math.max(1.3, card.ease + [0, -0.15, 0, 0.15][g]);
    card.ivl = card.reps === 1 ? (g === 3 ? 3 : 1) : card.reps === 2 ? (g === 1 ? 3 : 6) : Math.round(card.ivl * card.ease * (g === 1 ? 0.8 : g === 3 ? 1.3 : 1));
    card.due = Date.now() + card.ivl * 864e5;
  }
  persist();
}

/* ---------- Фон: дневник, рефлексия, порядок ---------- */
export function contextStart(msgs, maxN = 30, maxChars = 16000) {
  let chars = 0, start = msgs.length;
  for (let i = msgs.length - 1; i >= 0 && msgs.length - i <= maxN; i--) {
    chars += (msgs[i].text || "").length;
    if (chars > maxChars && i < msgs.length - 1) break;
    start = i;
  }
  return start;
}
export async function updateDiary() {
  const old = D.msgs.slice(0, contextStart(D.msgs)).filter(m => (m.ts || 0) > (D.diary.upTo || 0) && !m.temp);
  if (old.length < 10) return false;
  const convo = old.map(m => `${m.role === "user" ? "Сумрак" : "Дмитрий"} (${m.ts ? isoLocal(m.ts) : ""}): ${m.text}`).join("\n").slice(-30000);
  const res = await plain("Ты ведёшь дневник разговоров ассистента Дмитрия Павлова с Сумраком. Пиши по-русски, сжато, только факты.",
    `Текущая сводка:\n${D.diary.text || "(пусто)"}\n\nНовые разговоры:\n${convo}\n\nОбнови сводку: добавь главное из новых разговоров (темы, что Сумрак решил, планировал, обещал, просил, что его беспокоило, чему учился; даты указывай). Старое сжимай, но не теряй важное. Не более 3000 символов. Верни только текст сводки.`);
  const t = String(res || "").trim();
  if (t.length > 20) { D.diary = { text: t.slice(0, 4500), upTo: old[old.length - 1].ts || Date.now() }; persist(); return true; }
  return false;
}
/* Раз в день (или когда набралось много важного): выводы о Сумраке и обновление профиля. */
export async function reflect(force) {
  const due = force || (D.meta.lastReflect || "") !== todayKey() && ((D.meta.impSinceReflect || 0) >= 30 || activeFacts().length >= 5);
  if (!due || activeFacts().length < 3) return false;
  const res = await plain("Ты — аналитическая часть личного ассистента Дмитрия Павлова. Пишешь кратко, по-русски, без выдумок: только то, что следует из данных. Отвечай только JSON.",
    `Факты о Сумраке (тема, важность):\n${activeFacts().map(f => `- (${f.cat}, ${f.imp}) ${f.text}`).join("\n")}\n\nДневник разговоров:\n${D.diary.text || "(нет)"}\n\nТекущий профиль:\n${JSON.stringify(D.core)}\n\nПрежние выводы:\n${D.insights.map(i => "- " + i.text).join("\n") || "(нет)"}\n\nЗадача:
1) Перепиши профиль — 4 коротких блока (каждый до 600 символов): profile (кто он, чем живёт), goals (цели и планы), people (близкие и важные люди), preferences (как ему удобно общаться и получать помощь).
2) Сделай до 3 новых глубоких выводов о Сумраке, которые помогут лучше ему помогать (закономерности, потребности, риски), только если они правда следуют из данных; не повторяй прежние.
Верни JSON: {"core":{"profile":"","goals":"","people":"","preferences":""},"insights":["..."]}`, { json: true });
  const j = parseJSON(res);
  if (!j || !j.core) return false;
  Object.keys(D.core).forEach(k => { if (typeof j.core[k] === "string") D.core[k] = j.core[k].trim().slice(0, 1200); });
  arr(j.insights).forEach(t => { t = String(t).trim(); if (t && !D.insights.some(i => i.text === t)) D.insights.push({ id: uid(), text: t.slice(0, 400), ts: Date.now() }); });
  D.insights = D.insights.slice(-15);
  D.meta.lastReflect = todayKey(); D.meta.impSinceReflect = 0; persist();
  return true;
}
export async function tidyMemory() {
  const facts = activeFacts(); if (facts.length < 3) return { ok: false, n: facts.length };
  const res = await plain("Ты наводишь порядок в памяти личного ассистента о его хозяине Сумраке. Отвечай только JSON.",
    `Факты (от старых к новым):\n${facts.map(f => `- (${f.cat}, ${f.imp}) ${f.text}`).join("\n")}\n\nОбъедини дубли, убери противоречия (верным считай более новое), сформулируй кратко. Ничего важного не теряй и не выдумывай. Темы: ${CATS.join(", ")}. Важность 1–10.\nВерни JSON: {"facts":[{"text":"...","cat":"...","imp":5}]}`, { json: true });
  const j = parseJSON(res);
  const list = j && Array.isArray(j.facts) ? j.facts.filter(f => f && f.text) : null;
  if (!list || !list.length || list.length > facts.length + 2 || list.length < facts.length * 0.3) return { ok: false, n: facts.length };
  const now = Date.now();
  facts.forEach(f => { f.status = "old"; f.validTo = now; });
  const fresh = list.map(f => ({ id: uid(), text: String(f.text).trim(), cat: normCat(f.cat), imp: Math.max(1, Math.min(10, +f.imp || 5)), ts: now, used: now, status: "active" }));
  D.facts.push(...fresh);
  D.facts = D.facts.filter(f => f.status !== "old" || now - (f.validTo || 0) < 90 * 864e5).slice(-1500);  // устаревшее храним 90 дней
  D.meta.lastTidy = now; persist();
  try { await idbDel("vecs", facts.map(f => "f:" + f.id)); } catch {}
  embedFacts(fresh);
  return { ok: true, n: fresh.length };
}
/* Урок из оценки 👎 и пояснения Сумрака. */
export async function lessonFromFeedback(question, answer, comment) {
  const res = await plain("Ты помогаешь ассистенту Дмитрию Павлову учиться на ошибках. Отвечай только JSON.",
    `Вопрос Сумрака: ${question}\nОтвет Дмитрия: ${answer.slice(0, 3000)}\nСумраку не понравилось${comment ? ": " + comment : ""}.\nСформулируй 1 короткое общее правило на будущее (что делать иначе), применимое к похожим случаям. Не пересказывай вопрос.\nВерни JSON: {"lesson":"..."}`, { json: true });
  const j = parseJSON(res); const t = j && String(j.lesson || "").trim();
  if (t) { D.lessons.push({ id: uid(), text: t.slice(0, 400), ts: Date.now() }); D.lessons = D.lessons.slice(-60); persist(); }
  return t;
}
