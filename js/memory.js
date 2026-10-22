/* Память и обучение.
   - Профиль (ядро): короткие блоки о Сумраке, всегда в контексте.
   - Факты: важность 1–10, тема, свежесть. В контекст попадают самые нужные (важность + свежесть + близость к теме).
   - Устаревшие факты не стираются, а помечаются «устарело» — так не теряется история.
   - Навыки («научись»), уроки (из поправок и оценок), выводы (рефлексия раз в день), дневник разговоров. */
import { D, persist, idbPut, idbAll, idbDel, idbPrefix } from "./store.js";
import { neutralize, uid, arr, terms, cosine, parseLocal, nextDue, REPEAT_TXT, isoLocal, todayKey, parseJSON } from "./util.js";
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
      if (qVecCache.q !== query) { const r = await embed([query], "RETRIEVAL_QUERY"); qVecCache = { q: query, v: r && r.vecs[0], m: r && r.model }; }
      qv = qVecCache.v;
      // сравниваем только векторы одной модели — векторы разных моделей несовместимы
      const stored = await idbPrefix("vecs", "f:"); vecs = new Map(stored.filter(v => (!v.m || v.m === qVecCache.m)).map(v => [v.id.slice(2), v.v]));
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
  try { const r = await embed(list.map(f => f.text), "RETRIEVAL_DOCUMENT"); if (r) await idbPut("vecs", list.map((f, i) => ({ id: "f:" + f.id, v: Array.from(r.vecs[i]), m: r.model }))); } catch {}
}
export async function ensureFactVecs() {
  if (!canEmbed()) return;
  try {
    const have = new Set(await idbPrefix("vecs", "f:", true));
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
// Навыки и уроки — только по явным словам Сумрака: просьба научиться, поправка или подтверждение «да».
const TEACH_RE = /научись|научи(ть)?\s|запомни,?\s+как|навык|правил[оа]|впредь|в следующий раз|не так(?=[\s,.!?]|$)|неправильн|ошиб|поправ|исправь|никогда не|всегда (делай|отвечай|пиши|говори)|делай так/i;
const CONFIRM_RE = /^\s*(да|ага|угу|верно|сохран\S*|подтверждаю|ок|окей|давай|точно)(?=[\s,.!?]|$)/i;
/* Защита от «подброшенных» команд (prompt injection): текст со страницы или из документа может попросить
   нейросеть удалить данные или вписать себе правило. Поэтому разрушительные и «обучающие» действия
   применяем, только если этого хотел сам Сумрак, — по словам его сообщения, — и понемногу за раз. */
const DEL_INTENT_RE = /удал|убер|убра|(^|[^\p{L}])(сотри|сотрите|стереть|стёр|стер|снеси|снести)(?![\p{L}])|отмен|не нужн|забудь|забыть|забуд|очист|выкин|вычеркн|не напомин|хватит напомин|перестань напомин|не надо напомин|больше не напомин/iu;
const DONE_INTENT_RE = /сделал|сделано|готово|выполн|закр(ой|ыл|ыть)|отмет|уже\s|купил|забрал|позвонил|сходил|отправил|оплатил|закончил|решил|выпил|принял|съел|прочитал|написал|получил/i;
const FEEDBACK_RE = /^\s*нет(?![\p{L}])|не то(?![\p{L}])|не так(?![\p{L}])|не понял|опять|снова ты|я же |зачем ты|почему ты|не надо|ерунд|чушь|бред|плохо|неверн|неправил|ошиб|врёшь|врешь|выдум|не правда|неправда|поправ|исправ|впредь|в следующий раз/iu;
const ALL_RE = /(^|[^\p{L}])(все|всё|весь|всех|целиком|список)(?![\p{L}])/iu;
const capList = (list, userText) => list.slice(0, ALL_RE.test(userText || "") ? 50 : 2);
const real = t => !!t && !/^\s*(\.{2,}|…|-|—)?\s*$/.test(t) && !/^\.\.\.|^…$/.test(t.trim());   // не заглушка «...» из образца
/* userText — последнее сообщение Сумрака. Навыки и уроки создаются только по его словам,
   а не из найденных в интернете страниц (защита от «подброшенных» инструкций). */
/* Отметить дело выполненным. Повторяющееся не закрываем — переносим на следующий раз. */
export function completeTask(t) {
  if (t.repeat && t.due) advanceTask(t);
  else t.done = true;
}
/* Перенести повторяющееся дело на следующий раз, сохраняя исходное число месяца. */
export function advanceTask(t) {
  if (!t.anchor) t.anchor = new Date(t.due).getDate();
  t.due = nextDue(t.due, t.repeat, t.anchor) || t.due; t.notified = false;
}
export function applyActions(act, userText, { temp } = {}) {
  const out = { newTasks: [], remembered: [], learned: [], cards: 0, device: [] };
  // Действия на iPhone через «Команды»: будильник, таймер, разложить файлы (только известные, с проверкой полей)
  if (act && typeof act === "object") arr(act.device).slice(0, 3).forEach(d => {
    if (!d || typeof d !== "object") return;
    if (d.do === "alarm" && /^\d{1,2}:\d{2}$/.test(String(d.time || "").trim())) out.device.push({ do: "alarm", time: String(d.time).trim().padStart(5, "0"), label: String(d.label || "").slice(0, 60) });
    else if (d.do === "timer" && +d.minutes > 0 && +d.minutes <= 1440) out.device.push({ do: "timer", minutes: Math.round(+d.minutes * 10) / 10 });
    else if (d.do === "sort_files") out.device.push({ do: "sort_files" });
  });
  if (!act || typeof act !== "object") return out;
  const now = Date.now();
  if (!temp) {
    // Забывать факты можно, когда Сумрак сказал «забудь» или факт изменился (не больше двух за раз)
    const forget = capList(arr(act.forget).map(String), DEL_INTENT_RE.test(userText || "") ? userText : "");
    D.facts.forEach(f => { if (forget.includes(f.id) && f.status !== "old") { f.status = "old"; f.validTo = now; } });
    const fresh = [];
    arr(act.remember).forEach(r => {
      const text = String(typeof r === "string" ? r : r && r.text || "").trim();
      if (!real(text) || activeFacts().some(f => f.text.toLowerCase() === text.toLowerCase())) return;
      const f = { id: uid(), text, cat: normCat(r && r.cat), imp: Math.max(1, Math.min(10, +(r && r.imp) || 5)), ts: now, used: now, status: "active" };
      D.facts.push(f); fresh.push(f); out.remembered.push(text);
      D.meta.impSinceReflect = (D.meta.impSinceReflect || 0) + f.imp;
    });
    embedFacts(fresh);
    if (act.core && typeof act.core === "object" && /профил/i.test(userText || "")) Object.keys(D.core).forEach(k => { if (typeof act.core[k] === "string" && real(act.core[k].trim())) D.core[k] = act.core[k].trim().slice(0, 1200); });
  }
  arr(act.tasks).forEach(t => {
    const text = String(typeof t === "string" ? t : t && t.text || "").trim(); if (!real(text)) return;
    const sec = t && +t.in_sec;
    const due = sec > 0 && sec < 366 * 86400 ? now + Math.round(sec * 1000) : t && t.due ? parseLocal(t.due) : null;
    const task = { id: uid(), text, due, repeat: due && Object.hasOwn(REPEAT_TXT, t.repeat) ? t.repeat : null, done: false, notified: false, ts: now };
    D.tasks.push(task); out.newTasks.push(task);
  });
  arr(act.update_tasks).forEach(u => {
    const t = u && D.tasks.find(x => x.id === String(u.id)); if (!t) return;
    if (u.text) t.text = String(u.text);
    if (u.due !== undefined) { t.due = u.due ? parseLocal(u.due) : null; t.notified = false; delete t.anchor; }
    if (u.repeat !== undefined) t.repeat = Object.hasOwn(REPEAT_TXT, u.repeat) ? u.repeat : null;
    out.newTasks.push(t);
  });
  const delIntent = DEL_INTENT_RE.test(userText || "");
  const done = DONE_INTENT_RE.test(userText || "") || delIntent ? capList(arr(act.done).map(String), userText) : [];
  D.tasks.forEach(t => { if (done.includes(t.id)) completeTask(t); });
  const delT = delIntent ? capList(arr(act.delete_tasks).map(String), userText) : [];
  D.tasks = D.tasks.filter(t => !delT.includes(t.id));
  arr(act.notes).forEach(t => { t = String(typeof t === "string" ? t : t && t.text || "").trim(); if (real(t)) D.notes.push({ id: uid(), text: t, ts: now }); });
  const delN = delIntent ? capList(arr(act.delete_notes).map(String), userText) : [];
  D.notes = D.notes.filter(n => !delN.includes(n.id));
  // Навык — по «научись…», или по «да» в ответ на вопрос Дмитрия «Сохранить?»
  const prevAi = [...D.msgs].reverse().find(m => m.role === "ai");
  const taught = !temp && (TEACH_RE.test(userText || "") || (CONFIRM_RE.test(userText || "") && /сохранить\s*\?|сохраняю\s*\?|запомнить так\s*\?/i.test(prevAi ? prevAi.text : "")));
  // Недочёты и уроки — только в ответ на поправку или недовольство Сумрака
  const feedback = !temp && (FEEDBACK_RE.test(userText || "") || TEACH_RE.test(userText || ""));
  if (feedback) arr(act.mistakes).slice(0, 2).forEach(m => {
    const r = m && addMistake({ what: typeof m === "string" ? m : m.what, why: m.why, fix: m.fix, q: userText, src: "сам заметил в разговоре" });
    if (r) out.learned.push("свой недочёт");
  });
  // Уроки — всегда, когда модель их вывела (раньше терялись, если в поправке не было слов «научись», «запомни»…)
  if (feedback) arr(act.lessons).slice(0, 2).forEach(l => {
    const text = String(typeof l === "string" ? l : l && l.text || "").trim();
    if (real(text) && !D.lessons.some(x => x.text === text || similar(x.text, text) >= 0.75)) { D.lessons.push({ id: uid(), text: text.slice(0, 400), ts: now }); D.lessons = D.lessons.slice(-60); out.learned.push("урок"); }
  });
  if (taught) {
    arr(act.skills).forEach(s => {
      if (!s || !real(String(s.name || "")) || !real(String(s.steps || ""))) return;
      const ex = D.skills.find(x => x.name.toLowerCase() === String(s.name).toLowerCase());
      const rec = { name: String(s.name).slice(0, 80), desc: String(s.desc || "").slice(0, 300), trigger: String(s.trigger || "").slice(0, 200), steps: String(s.steps).slice(0, 4000) };
      if (ex) Object.assign(ex, rec, { ts: now }); else D.skills.push({ id: uid(), uses: 0, ts: now, ...rec });
      out.learned.push("навык «" + rec.name + "»");
    });
  }
  if (delIntent && /навык|умени/i.test(userText || "")) capList(arr(act.forget_skills).map(String), userText).forEach(id => { D.skills = D.skills.filter(s => s.id !== id); });
  arr(act.used_skills).map(String).forEach(id => { const s = D.skills.find(x => x.id === id); if (s) s.uses = (s.uses || 0) + 1; });
  arr(act.cards).forEach(c => {
    if (!c || !real(String(c.q || "")) || !real(String(c.a || ""))) return;
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
  const coreBefore = JSON.stringify(D.core);
  const due = force || (D.meta.lastReflect || "") !== todayKey() && ((D.meta.impSinceReflect || 0) >= 30 || activeFacts().length >= 5);
  if (!due || activeFacts().length < 3) return false;
  const res = await plain("Ты — аналитическая часть личного ассистента Дмитрия Павлова. Пишешь кратко, по-русски, без выдумок: только то, что следует из данных. Отвечай только JSON.",
    `Факты о Сумраке (тема, важность):\n${activeFacts().map(f => `- (${f.cat}, ${f.imp}) ${f.text}`).join("\n")}\n\nДневник разговоров:\n${D.diary.text || "(нет)"}\n\nТекущий профиль:\n${JSON.stringify(D.core)}\n\nПрежние выводы:\n${D.insights.map(i => "- " + i.text).join("\n") || "(нет)"}\n\nЗадача:
1) Перепиши профиль — 4 коротких блока (каждый до 600 символов): profile (кто он, чем живёт), goals (цели и планы), people (близкие и важные люди), preferences (как ему удобно общаться и получать помощь).
2) Сделай до 3 новых глубоких выводов о Сумраке, которые помогут лучше ему помогать (закономерности, потребности, риски), только если они правда следуют из данных; не повторяй прежние.
Верни JSON: {"core":{"profile":"","goals":"","people":"","preferences":""},"insights":["..."]}`, { json: true });
  const j = parseJSON(res);
  if (!j || !j.core) return false;
  // пока модель думала, Сумрак мог сам поправить профиль — его правки важнее
  if (JSON.stringify(D.core) === coreBefore) Object.keys(D.core).forEach(k => { const v = typeof j.core[k] === "string" ? j.core[k].trim() : ""; if (real(v)) D.core[k] = v.slice(0, 1200); });
  arr(j.insights).forEach(t => { t = String(t).trim(); if (real(t) && !D.insights.some(i => i.text === t)) D.insights.push({ id: uid(), text: t.slice(0, 400), ts: Date.now() }); });
  D.insights = D.insights.slice(-15);
  D.meta.lastReflect = todayKey(); D.meta.impSinceReflect = 0; persist();
  return true;
}
export async function tidyMemory() {
  const facts = activeFacts().filter(f => !f.pinned); if (facts.length < 3) return { ok: false, n: activeFacts().length };
  const res = await plain("Ты наводишь порядок в памяти личного ассистента о его хозяине Сумраке. Отвечай только JSON.",
    `Факты (от старых к новым):\n${facts.map(f => `- (${f.cat}, ${f.imp}) ${f.text}`).join("\n")}\n\nОбъедини дубли, убери противоречия (верным считай более новое), сформулируй кратко. Ничего важного не теряй и не выдумывай. Темы: ${CATS.join(", ")}. Важность 1–10.\nВерни JSON: {"facts":[{"text":"...","cat":"...","imp":5}]}`, { json: true });
  const j = parseJSON(res);
  const list = j && Array.isArray(j.facts) ? j.facts.filter(f => f && f.text) : null;
  if (!list || !list.length || list.length > facts.length + 2 || list.length < facts.length * 0.3) return { ok: false, n: facts.length };
  if (facts.some(f => f.status === "old")) return { ok: false, n: activeFacts().length };   // пока думал, что-то удалили — не рискуем
  const now = Date.now();
  facts.forEach(f => { f.status = "old"; f.validTo = now; });
  const fresh = list.map(f => ({ id: uid(), text: String(f.text).trim(), cat: normCat(f.cat), imp: Math.max(1, Math.min(10, +f.imp || 5)), ts: now, used: now, status: "active" }));
  D.facts.push(...fresh);
  D.facts = D.facts.filter(f => f.status !== "old" || now - (f.validTo || 0) < 90 * 864e5).slice(-1500);  // устаревшее храним 90 дней
  D.meta.lastTidy = now; persist();
  try { await idbDel("vecs", facts.map(f => "f:" + f.id)); } catch {}
  embedFacts(fresh);
  return { ok: true, n: activeFacts().length };
}
/* Урок и запись в журнал недочётов из оценки 👎 и пояснения Сумрака. */
export async function lessonFromFeedback(question, answer, comment) {
  const res = await plain("Ты помогаешь ассистенту Дмитрию Павлову честно разбирать свои ошибки. Отвечай только JSON.",
    `Вопрос Сумрака: ${question}\nОтвет Дмитрия: ${answer.slice(0, 3000)}\nСумраку не понравилось${comment ? ": " + comment : ""}.\nРазбери: what — что конкретно Дмитрий сделал не так (одна фраза, от первого лица: «Я …»); why — почему так вышло; fix — короткое общее правило на будущее, применимое к похожим случаям (не пересказывай вопрос).\nВерни JSON: {"what":"...","why":"...","fix":"..."}`, { json: true });
  const j = parseJSON(res) || {};
  const fix = String(j.fix || j.lesson || "").trim();
  const what = String(j.what || "").trim() || (comment ? "Ответил не так, как нужно: " + comment : "");
  if (real(what)) addMistake({ what, why: j.why, fix, q: question, src: "твоя оценка 👎" });
  else if (real(fix) && !D.lessons.some(l => similar(l.text, fix) >= 0.75)) { D.lessons.push({ id: uid(), text: fix.slice(0, 400), ts: Date.now() }); D.lessons = D.lessons.slice(-60); persist(); }
  return fix;
}

/* =================== Самоанализ: журнал недочётов ===================
   Записи появляются четырьмя путями: Дмитрий сам замечает ошибку в разговоре (поправка, недовольство),
   оценка 👎, автоматические проверки ответа и ежедневная самопроверка переписки.
   Похожие недочёты не дублируются — растёт счётчик повторов. Не повторялся 14 дней — «исправлен». */
// Сходство двух формулировок по корням слов (первые 4 буквы: «рублях» и «рубли» — одно и то же)
const roots = t => new Set(terms(t || "").map(w => w.slice(0, 4)));
export function similar(a, b) {
  const A = roots(a), B = roots(b);
  if (!A.size || !B.size) return 0;
  let n = 0; A.forEach(w => { if (B.has(w)) n++; });
  return 2 * n / (A.size + B.size);
}
export function addMistake({ what, why = "", fix = "", q = "", src = "сам заметил" }) {
  what = String(what || "").trim(); fix = String(fix || "").trim();
  if (!real(what) || what.length < 8) return null;
  const now = Date.now();
  const ex = D.mistakes.find(m => similar(m.what, what) >= 0.5 || (real(fix) && m.fix && similar(m.fix, fix) >= 0.5 && similar(m.what, what) >= 0.3));
  if (ex) {
    ex.count = (ex.count || 1) + 1; ex.last = now; ex.status = "open";
    if (real(fix)) ex.fix = fix.slice(0, 400); if (q) ex.q = String(q).slice(0, 200);
  } else {
    D.mistakes.push({ id: uid(), what: what.slice(0, 400), why: String(why || "").slice(0, 300), fix: fix.slice(0, 400), q: String(q || "").slice(0, 200), src, count: 1, ts: now, last: now, status: "open" });
    D.mistakes = D.mistakes.slice(-80);
  }
  // Правило исправления — сразу в уроки, чтобы оно применялось в следующих ответах
  if (real(fix) && !D.lessons.some(l => similar(l.text, fix) >= 0.75)) { D.lessons.push({ id: uid(), text: fix.slice(0, 400), ts: now }); D.lessons = D.lessons.slice(-60); }
  persist();
  return ex || D.mistakes[D.mistakes.length - 1];
}
export function openMistakes() {
  const now = Date.now(); let ch = false;
  D.mistakes.forEach(m => { if (m.status === "open" && now - (m.last || m.ts) > 14 * 864e5) { m.status = "fixed"; m.fixedAt = now; ch = true; } });
  if (ch) persist();
  return D.mistakes.filter(m => m.status === "open");
}
/* Автоматические проверки ответа — без нейросети, на каждом ответе. */
const PROMISE_RE = /(напомню|поставил[аи]? напоминани|поставил[аи]? (тебе )?(дело|задачу)|записал[аи]? (это )?в дела|добавил[аи]? (это )?(в дела|напоминани))/i;
const FALSE_CANT_RE = /(не могу|не умею|нет возможности) (сам(остоятельно)? )?(ставить|поставить|создавать|создать|устанавливать) (напоминани|будильник|дел)|нет доступа к интернету|не имею доступа к интернету|нет выхода в интернет/i;
const CLAIM_SEARCH_RE = /(я )?(нашёл|проверил|посмотрел|поискал|погуглил)[а-я]* (в интернете|в сети|в поиске|на сайте)|по (данным|информации) из интернета|согласно (свежим )?(данным|новостям) (из )?интернета/i;
export function selfCheck(question, reply, out, { searched = true } = {}) {
  const found = [];
  if (!searched && CLAIM_SEARCH_RE.test(reply))
    found.push(addMistake({ what: "Я сказал, что нашёл или проверил что-то в интернете, хотя поиска в этом ответе не было.", why: "Выдал знания по памяти за свежий поиск.", fix: "Говори «нашёл в интернете» только когда поиск был и есть источники; иначе — «по моим данным, могло устареть» и предложи проверить.", q: question, src: "самопроверка ответа" }));
  if (PROMISE_RE.test(reply) && !out.newTasks.length && !/не напомню|могу напомнить|хочешь, напомню|напомню\?/i.test(reply))
    found.push(addMistake({ what: "Я сказал, что поставил напоминание, но само дело не создал — напоминания бы не было.", why: "Пообещал словами, но не добавил дело в блок действий.", fix: "Обещая напомнить, всегда создавай дело (tasks) с точной датой и временем; без этого напоминания не будет.", q: question, src: "самопроверка ответа" }));
  if (FALSE_CANT_RE.test(reply))
    found.push(addMistake({ what: "Я сказал, что не могу ставить напоминания или выходить в интернет — это неправда, я это умею.", why: "Забыл о своих возможностях.", fix: "Помни свои возможности: я ставлю напоминания (дела с временем, плюс кнопки в Напоминания и Календарь iPhone) и ищу в интернете. Не говори, что не умеешь.", q: question, src: "самопроверка ответа" }));
  return found.filter(Boolean);
}
/* Раз в день: перечитать недавнюю переписку и честно найти свои ошибки (один фоновый запрос). */
export async function selfReview(force) {
  const since = D.meta.lastSelfReview || 0;
  const recent = D.msgs.filter(m => !m.temp && (m.ts || 0) > since).slice(-40);
  const due = force || ((D.meta.lastSelfReviewDay || "") !== todayKey() && recent.filter(m => m.role === "user").length >= 6);
  if (!due || recent.length < 2) return null;
  const convo = recent.map(m => `${m.role === "user" ? "Сумрак" : "Дмитрий"}${m.rating === -1 ? " [Сумрак поставил 👎]" : m.rating === 1 ? " [👍]" : ""}: ${String(m.text || "").slice(0, 700)}`).join("\n");
  const known = D.mistakes.slice(-15).map(m => "- " + m.what).join("\n") || "(пока нет)";
  const res = await plain("Ты — строгий внутренний контролёр качества личного ассистента Дмитрия Павлова. Честно, без самобичевания и без выдумок. Отвечай только JSON.",
    `Переписка Дмитрия с Сумраком:\n${convo}\n\nУже известные недочёты:\n${known}\n\nНайди реальные ошибки Дмитрия в этой переписке — только те, что прямо видны из текста: неверные факты или расчёты; не понял, что просил Сумрак (Сумрак переспрашивал, поправлял, раздражался); обещал и не сделал; сказал «не могу», хотя мог; лишняя вода или слишком коротко; повторялся; не напомнил о важном; не поддержал, когда было нужно. Не пиши общих слабостей ИИ. Если ошибок нет — верни пустой список.\nДля каждой: what — что я сделал не так (от первого лица, конкретно, с сутью случая), why — почему, fix — правило на будущее.\nВерни JSON: {"mistakes":[{"what":"...","why":"...","fix":"..."}]} (не больше 5)`, { json: true });
  const j = parseJSON(res) || {};
  const added = arr(j.mistakes).slice(0, 5).map(m => m && addMistake({ what: m.what, why: m.why, fix: m.fix, src: "ежедневная самопроверка" })).filter(Boolean);
  D.meta.lastSelfReview = recent[recent.length - 1].ts || Date.now(); D.meta.lastSelfReviewDay = todayKey(); persist();
  return added;
}
