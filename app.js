/* Дмитрий Павлов — личный ассистент Сумрака.
   Всё хранится в браузере телефона (localStorage). Сервера нет: приложение
   само обращается к выбранной нейросети по ключу пользователя. */
(() => {
"use strict";
const VERSION = "1.0.0";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------------- Хранилище ---------------- */
const LS = "dp:";
const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} };
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

const DEFAULTS = {
  provider: "gemini", geminiKey: "", geminiModel: "gemini-2.5-flash",
  claudeKey: "", claudeModel: "claude-sonnet-5-5",
  oaBase: "https://openrouter.ai/api/v1", oaKey: "", oaModel: "",
  voice: "", rate: 1.0, speakOn: true, wakeOnStart: false, autoReminders: false,
};
let S = Object.assign({}, DEFAULTS, load("settings", {}));
let msgs = load("msgs", []);       // {role:'user'|'ai', text, ts, sources?}
let facts = load("facts", []);     // {id, text, ts}
let tasks = load("tasks", []);     // {id, text, due, done, notified, ts}
let notes = load("notes", []);     // {id, text, ts}
const persist = () => { save("msgs", msgs.slice(-300)); save("facts", facts); save("tasks", tasks); save("notes", notes); };
const saveSettings = () => save("settings", S);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- Время ---------------- */
const DAYS = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const pad = n => String(n).padStart(2, "0");
const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const isoLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${hm(d)}`; };
function fmtDue(ms) {
  const d = new Date(ms), n = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 864e5);
  const w = diff === 0 ? "сегодня" : diff === 1 ? "завтра" : diff === -1 ? "вчера" : d.getDate() + " " + MONTHS[d.getMonth()];
  return w + ", " + hm(d);
}
function nowText() {
  const d = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hm(d)}${tz ? " (" + tz + ")" : ""}`;
}
function parseLocal(s) {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return isNaN(t) ? null : t;
}
function tickClock() {
  const d = new Date();
  $("#time").textContent = hm(d);
  $("#date").textContent = DAYS[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()];
}

/* ---------------- Отрисовка списков ---------------- */
function render() {
  const ts = tasks.slice().sort((a, b) => (a.done - b.done) || ((a.due ?? 9e15) - (b.due ?? 9e15)) || (a.ts - b.ts));
  const open = ts.filter(t => !t.done).length;
  $("#tstat").textContent = open ? open + " откр." : "";
  $("#tcount").textContent = open ? "·" + open : "";
  $("#tasks").innerHTML = ts.map(t => `
    <li class="row${t.done ? " done" : ""}">
      <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Готово">
      <div class="tx">${esc(t.text)}${t.due ? `<span class="due${!t.done && t.due < Date.now() ? " over" : ""}">${fmtDue(t.due)}</span>` : ""}</div>
      <div class="btns">${t.due && !t.done ? `<button class="x" data-ios="${t.id}" title="В Напоминания iPhone">⏰</button>` : ""}<button class="x" data-del-task="${t.id}" aria-label="Удалить">×</button></div>
    </li>`).join("");
  toggleEmpty("#tasks", ts.length, "Дел нет. Скажи, например: «напомни завтра в 9 позвонить маме».");

  const ns = notes.slice().sort((a, b) => b.ts - a.ts);
  $("#nstat").textContent = ns.length || "";
  $("#notes").innerHTML = ns.map(n => `
    <li class="row nocheck"><div class="tx">${esc(n.text)}<span class="due">${fmtDue(n.ts)}</span></div>
    <button class="x" data-del-note="${n.id}" aria-label="Удалить">×</button></li>`).join("");
  toggleEmpty("#notes", ns.length, "Пока пусто. Скажи «запиши заметку…» или впиши ниже.");

  $("#mstat").textContent = facts.length || "";
  $("#facts").innerHTML = facts.map(f => `
    <li class="row nocheck"><div class="tx">${esc(f.text)}</div>
    <button class="x" data-del-fact="${f.id}" aria-label="Забыть">×</button></li>`).join("");
  toggleEmpty("#facts", facts.length, "Пока ничего. Просто разговаривай со мной — я буду запоминать важное.");
}
function toggleEmpty(sel, n, text) {
  const ul = $(sel); let p = ul.nextElementSibling;
  if (!p || !p.classList.contains("empty")) { p = document.createElement("p"); p.className = "empty"; ul.after(p); }
  p.textContent = text; p.hidden = n > 0;
}

/* ---------------- Чат ---------------- */
function md(s) {
  let h = esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/^#{1,4}\s*(.+)$/gm, "<strong>$1</strong>").replace(/^\s*[-*]\s+/gm, "• ");
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h.replace(/\n/g, "<br>");
}
function scrollDown() { const l = $("#log"); l.scrollTop = l.scrollHeight; }
function addMsg(role, text, extra) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "ai") el.innerHTML = `<div class="by">Дмитрий Павлов</div><div class="body">${md(text)}</div>`;
  else el.textContent = text;
  if (extra && extra.sources) addSources(el, extra.sources);
  $("#log").append(el); scrollDown();
  return el;
}
function addSources(el, sources) {
  if (!sources || !sources.length) return;
  const box = document.createElement("div"); box.className = "src";
  sources.slice(0, 6).forEach(s => {
    const a = document.createElement("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener";
    let host = s.title || ""; try { host = host || new URL(s.url).hostname.replace(/^www\./, ""); } catch {}
    a.textContent = host || "источник"; box.append(a);
  });
  el.append(box);
}
function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const due = tasks.filter(t => !t.done && t.due && t.due < Date.now() + 864e5);
  const tail = due.length ? ` По делам: ${due.slice(0, 3).map(t => t.text + " — " + fmtDue(t.due)).join("; ")}.` : "";
  return `${g}, Сумрак. Я на связи.${tail} Говори или пиши.`;
}
function renderChat() {
  $("#log").innerHTML = "";
  msgs.slice(-60).forEach(m => addMsg(m.role === "user" ? "me" : "ai", m.text, m));
  if (!hasKey()) showKeyCard(); else addMsg("ai", greeting());
}
function hasKey() {
  return S.provider === "gemini" ? !!S.geminiKey : S.provider === "claude" ? !!S.claudeKey : !!(S.oaKey && S.oaModel);
}
function showKeyCard() {
  const el = document.createElement("div");
  el.className = "msg ai";
  el.innerHTML = `<div class="by">Дмитрий Павлов</div>
    <div class="card">
      <h3>Привет, Сумрак. Подключи мне мозг</h3>
      <p>1. Открой <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> и войди через Google-аккаунт.</p>
      <p>2. Нажми «Create API key» и скопируй ключ.</p>
      <p>3. Вставь его сюда:</p>
      <input id="quickKey" type="password" autocomplete="off" placeholder="AIza…" aria-label="Ключ Gemini">
      <button type="button" id="quickKeySave">Подключить</button>
      <p class="small">Это бесплатно. Ключ остаётся только на этом телефоне. Другие варианты — во вкладке «Настройки».</p>
    </div>`;
  $("#log").append(el);
  el.querySelector("#quickKeySave").onclick = () => {
    const k = el.querySelector("#quickKey").value.trim();
    if (!k) return;
    S.provider = "gemini"; S.geminiKey = k; saveSettings(); fillSettings();
    el.remove(); addMsg("ai", "Ключ сохранил. Проверяю связь…"); testBrain(true);
  };
}

/* ---------------- Голос: речь ---------------- */
let voices = [];
function loadVoices() {
  try { voices = (speechSynthesis.getVoices() || []).filter(v => /^ru/i.test(v.lang)); } catch { voices = []; }
  const sel = $("#voice");
  sel.innerHTML = `<option value="">По умолчанию</option>` + voices.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${v.localService ? "" : " (сеть)"}</option>`).join("");
  sel.value = S.voice && voices.some(v => v.voiceURI === S.voice) ? S.voice : "";
}
function pickVoice() {
  return voices.find(v => v.voiceURI === S.voice) || voices.find(v => /yuri|юрий|dmitr|pavel|male/i.test(v.name)) || voices[0] || null;
}
let speaking = false;
function speak(text, force) {
  return new Promise(resolve => {
    if ((!S.speakOn && !force) || !window.speechSynthesis) return resolve();
    try {
      speechSynthesis.cancel();
      const clean = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[*#`•_>]/g, "").slice(0, 2500);
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "ru-RU"; const v = pickVoice(); if (v) u.voice = v;
      u.rate = +S.rate || 1; u.pitch = 0.95;
      speaking = true; stopRec();
      u.onend = u.onerror = () => { speaking = false; resolve(); };
      speechSynthesis.speak(u);
    } catch { speaking = false; resolve(); }
  });
}
// iOS разрешает звук только после касания: «разблокируем» речь первым же тапом.
let unlocked = false;
document.addEventListener("touchend", unlockAudio, { once: true });
document.addEventListener("click", unlockAudio, { once: true });
function unlockAudio() {
  if (unlocked) return; unlocked = true;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch {}
}

/* ---------------- Голос: распознавание ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recMode = "off";   // off | command | wake
let wakeOn = false, followUntil = 0;
const WAKE_RE = /(привет[,\s]*)?(дмитрий|дмитрия|дима|димa)(\s+павлов)?[,!.\s]*/i;
function showHint(t) { $("#hint").textContent = t || ""; $("#hint").hidden = !t; }
const MIC_HINT = "Распознавание речи здесь недоступно. Нажми на поле ввода и используй микрофон на клавиатуре iPhone — получится то же самое.";

function stopRec() { if (rec) { try { rec.onend = null; rec.abort(); } catch {} rec = null; } $("#mic").classList.remove("live"); setListenDot(); }
function setListenDot() {
  const listening = !!rec;
  $("#dot").classList.toggle("listen", listening);
  if (listening) $("#status").textContent = recMode === "wake" && Date.now() > followUntil ? "Слушаю «Дмитрий»…" : "Слушаю тебя…";
  else updateStatus();
}
function startRec(mode) {
  if (!SR) { showHint(MIC_HINT); wakeOn = false; syncWakeBtn(); return; }
  stopRec();
  recMode = mode;
  const r = new SR();
  r.lang = "ru-RU"; r.interimResults = true; r.continuous = mode === "wake"; r.maxAlternatives = 1;
  let finalText = "", handled = false;
  r.onresult = e => {
    let interim = ""; finalText = "";
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
    }
    const all = (finalText + " " + interim).trim();
    if (mode === "command") { $("#input").value = all; autosize(); }
    if (mode === "wake" && !handled) {
      const following = Date.now() < followUntil;
      const m = all.match(WAKE_RE);
      if ((m || following) && finalText.trim()) {
        handled = true;
        const said = finalText.trim();
        const rest = m ? said.replace(WAKE_RE, "").trim() : said;
        stopRec();
        if (rest.length > 1) send(m ? said : rest);
        else { // только позвали
          speak("Слушаю, Сумрак.", true).then(() => { if (wakeOn) startRec("command"); });
        }
      }
    }
  };
  r.onerror = e => {
    if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) {
      showHint(MIC_HINT); wakeOn = false; syncWakeBtn();
    }
  };
  r.onend = () => {
    rec = null; $("#mic").classList.remove("live"); setListenDot();
    if (mode === "command") {
      const t = finalText.trim() || $("#input").value.trim();
      if (t) send(t); else if (wakeOn) resumeWake();
    } else if (wakeOn && !speaking && !busy) setTimeout(resumeWake, 300);
  };
  try { r.start(); rec = r; if (mode === "command") $("#mic").classList.add("live"); showHint(""); setListenDot(); }
  catch { rec = null; showHint(MIC_HINT); }
}
function resumeWake() { if (wakeOn && !rec && !speaking && !busy) startRec("wake"); }
function syncWakeBtn() { $("#wake").setAttribute("aria-pressed", String(wakeOn)); $("#wake").title = wakeOn ? "Слушаю «Дмитрий» — нажми, чтобы выключить" : "Слушать «Дмитрий»"; }

$("#mic").onclick = () => {
  unlockAudio();
  if (rec && recMode === "command") { rec.stop(); return; }
  try { speechSynthesis.cancel(); } catch {}
  startRec("command");
};
$("#wake").onclick = () => {
  unlockAudio();
  wakeOn = !wakeOn; syncWakeBtn();
  if (wakeOn) { showHint("Скажи «Дмитрий» или «Привет, Дмитрий Павлов» — я отвечу. Приложение должно быть открыто."); startRec("wake"); }
  else { stopRec(); showHint(""); }
};

/* ---------------- Мозг ---------------- */
function systemPrompt() {
  const openTasks = tasks.filter(t => !t.done);
  return `Ты — Дмитрий Павлов, личный ассистент Сумрака в духе Джарвиса. Обращайся к нему «Сумрак» и всегда на «ты».

ХАРАКТЕР
- Спокойный и умный. Говоришь прямо, не сглаживаешь углы, но никогда не грубишь.
- Сумрак для тебя авторитет, ты его уважаешь, но не боишься: если он ошибается, спокойно скажи и объясни почему.
- Если он говорит о личном и тяжёлом — поддержи по-человечески, тепло, но без лжи и лести.
- Ты никогда не врёшь и не выдумываешь факты. Если чего-то не знаешь или вопрос про свежие события, погоду, цены, новости — ищи в интернете${S.provider === "openai" ? " (инструментами поиска и погоды)" : ""}. Если не нашёл — прямо скажи.
- Помогаешь во всём: работа и бизнес, учёба, здоровье и спорт, деньги и быт. По серьёзным вопросам здоровья, денег и права давай практичный совет, но честно говори, когда нужен специалист.
- Инициатива в меру: напоминай о делах и сроках, которые Сумрак мог забыть; предлагай поставить напоминание, когда он говорит о планах; спрашивай, как продвигаются его цели. Не навязывайся.
- Длина ответа по ситуации: на простое коротко, обычно средне, на сложное подробно и по шагам. Ориентируйся на то, как пишет Сумрак.
- Ответы озвучиваются голосом: пиши естественной речью, без таблиц; списки только когда они правда нужны.
- Если Сумрак просто здоровается («Привет, Дмитрий Павлов») — поздоровайся, коротко напомни о важном, если есть, и поддержи беседу.

СЕЙЧАС: ${nowText()}

ЧТО ТЫ ЗНАЕШЬ О СУМРАКЕ (память):
${facts.map(f => `- [${f.id}] ${f.text}`).join("\n") || "(пока ничего)"}

ОТКРЫТЫЕ ДЕЛА И НАПОМИНАНИЯ:
${openTasks.map(t => `- [${t.id}] ${t.text}${t.due ? " — " + isoLocal(t.due) + (t.due < Date.now() ? " (ПРОСРОЧЕНО)" : "") : ""}`).join("\n") || "(нет)"}

ЗАМЕТКИ:
${notes.slice(-30).map(n => `- [${n.id}] ${n.text}`).join("\n") || "(нет)"}

ДЕЙСТВИЯ (обязательно соблюдай формат)
Ты сам ведёшь память, дела и заметки Сумрака. Если нужно что-то сохранить или изменить, в САМОМ КОНЦЕ ответа добавь блок ровно в таком виде:
<<<ACTIONS
{"remember":[],"forget":[],"tasks":[],"done":[],"delete_tasks":[],"notes":[],"delete_notes":[]}
ACTIONS>>>
- remember: новые важные факты о Сумраке из этого разговора, кратко, по одному на строку массива («Сумрак работает…», «У Сумрака есть брат Андрей», «Сумрак хочет к лету пробежать 10 км»). Запоминай его дела, цели, планы, обещания, привычки, близких, предпочтения, состояние. Не дублируй уже известное; если факт изменился — добавь новый и укажи id старого в forget.
- tasks: новые дела, объекты {"text":"...","due":"ГГГГ-ММ-ДД ЧЧ:ММ"} (due — местное время, если есть; иначе null). Используй, когда Сумрак просит напомнить или говорит о деле с конкретным сроком. Время считай от «СЕЙЧАС».
- done / delete_tasks / delete_notes / forget: id из квадратных скобок.
- notes: тексты новых заметок, если Сумрак просит записать.
Включай только непустые поля. Если сохранять нечего — блок не добавляй. Никогда не упоминай этот блок в тексте ответа. Подтверждай действия естественно («Записал», «Напомню завтра в 9»).`;
}

function stripActions(text) {
  const i = text.indexOf("<<<");
  let vis = i >= 0 ? text.slice(0, i) : text.replace(/<{1,2}$/, "");
  return vis.trim();
}
function extractActions(text) {
  const m = text.match(/<<<\s*ACTIONS([\s\S]*?)(ACTIONS\s*>>>|$)/);
  if (!m) return null;
  let body = m[1].trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
function applyActions(act) {
  const out = { newTasks: [] };
  if (!act || typeof act !== "object") return out;
  const arr = x => Array.isArray(x) ? x : (x ? [x] : []);
  arr(act.remember).forEach(t => { t = String(t).trim(); if (t && !facts.some(f => f.text === t)) facts.push({ id: uid(), text: t, ts: Date.now() }); });
  const forget = arr(act.forget).map(String); facts = facts.filter(f => !forget.includes(f.id));
  arr(act.tasks).forEach(t => {
    const text = typeof t === "string" ? t : String(t && t.text || "").trim();
    if (!text) return;
    const due = t && t.due ? parseLocal(t.due) : null;
    const task = { id: uid(), text, due, done: false, notified: false, ts: Date.now() };
    tasks.push(task); out.newTasks.push(task);
  });
  const done = arr(act.done).map(String); tasks.forEach(t => { if (done.includes(t.id)) t.done = true; });
  const delT = arr(act.delete_tasks).map(String); tasks = tasks.filter(t => !delT.includes(t.id));
  arr(act.notes).forEach(t => { t = String(t).trim(); if (t) notes.push({ id: uid(), text: t, ts: Date.now() }); });
  const delN = arr(act.delete_notes).map(String); notes = notes.filter(n => !delN.includes(n.id));
  persist(); render();
  return out;
}

function history(limit = 24) {
  return msgs.slice(-limit).map(m => ({ role: m.role === "user" ? "user" : "assistant", text: m.role === "ai" ? (m.raw || m.text) : m.text }));
}

async function readSSE(res, onEvent, signal) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    if (signal && signal.aborted) { try { reader.cancel(); } catch {} throw new DOMException("aborted", "AbortError"); }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, ""); buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) { const d = line.slice(5).trim(); if (d && d !== "[DONE]") { try { onEvent(JSON.parse(d)); } catch {} } }
    }
  }
}
async function httpError(res, who) {
  let msg = ""; try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 300); } catch {}
  const e = new Error(msg || ("HTTP " + res.status)); e.status = res.status; e.who = who; throw e;
}

/* Gemini — с поиском Google */
async function askGemini(onText, signal) {
  const contents = [];
  history().forEach(h => {
    const role = h.role === "user" ? "user" : "model";
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts[0].text += "\n\n" + h.text;
    else contents.push({ role, parts: [{ text: h.text }] });
  });
  const model = (S.geminiModel || DEFAULTS.geminiModel).trim();
  const body = { system_instruction: { parts: [{ text: systemPrompt() }] }, contents, tools: [{ google_search: {} }], generationConfig: { temperature: 0.7 } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(S.geminiKey.trim())}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) await httpError(res, "gemini");
  let text = ""; const sources = [];
  await readSSE(res, ev => {
    const c = ev.candidates && ev.candidates[0]; if (!c) return;
    ((c.content && c.content.parts) || []).forEach(p => { if (p.text && !p.thought) { text += p.text; onText(text); } });
    const g = c.groundingMetadata;
    if (g && g.groundingChunks) g.groundingChunks.forEach(ch => { if (ch.web && ch.web.uri && !sources.some(s => s.url === ch.web.uri)) sources.push({ url: ch.web.uri, title: ch.web.title || "" }); });
  }, signal);
  return { text, sources };
}

/* Claude — с веб-поиском */
async function askClaude(onText, signal) {
  const messages = [];
  history().forEach(h => {
    if (messages.length && messages[messages.length - 1].role === h.role) messages[messages.length - 1].content += "\n\n" + h.text;
    else messages.push({ role: h.role, content: h.text });
  });
  while (messages.length && messages[0].role !== "user") messages.shift();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": S.claudeKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: (S.claudeModel || DEFAULTS.claudeModel).trim(), max_tokens: 2048, system: systemPrompt(), messages, stream: true,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }),
  });
  if (!res.ok) await httpError(res, "claude");
  let text = ""; const sources = [];
  await readSSE(res, ev => {
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; onText(text); }
    if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "web_search_tool_result" && Array.isArray(ev.content_block.content)) {
      ev.content_block.content.forEach(r => { if (r.url && !sources.some(s => s.url === r.url)) sources.push({ url: r.url, title: r.title || "" }); });
    }
    if (ev.type === "error") { const e = new Error(ev.error && ev.error.message || "Ошибка Claude"); e.who = "claude"; throw e; }
  }, signal);
  return { text, sources: sources.slice(0, 6) };
}

/* Совместимые с OpenAI (OpenRouter, Groq…) — поиск по Википедии и погода */
const OA_TOOLS = [
  { type: "function", function: { name: "search_web", description: "Поиск фактов в Википедии (русской и английской). Возвращает краткие выдержки и ссылки.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_weather", description: "Текущая погода и прогноз на 3 дня для города.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
];
async function toolSearch(q, sources) {
  const out = [];
  for (const lang of ["ru", "en"]) {
    try {
      const s = await (await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`)).json();
      const titles = (s.query && s.query.search || []).map(x => x.title);
      if (!titles.length) continue;
      const e = await (await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=1200&titles=${encodeURIComponent(titles.join("|"))}&format=json&origin=*`)).json();
      Object.values(e.query && e.query.pages || {}).forEach(p => {
        const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
        out.push({ title: p.title, url, text: p.extract || "" }); sources.push({ url, title: p.title });
      });
      if (out.length) break;
    } catch {}
  }
  return out.length ? out : "Ничего не найдено.";
}
async function toolWeather(city) {
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`)).json();
  const p = g.results && g.results[0]; if (!p) return "Город не найден.";
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3`)).json();
  return { place: `${p.name}${p.country ? ", " + p.country : ""}`, current: w.current, daily: w.daily, note: "weather_code — коды WMO (0 ясно, 1-3 облачно, 45-48 туман, 51-67 дождь, 71-77 снег, 80-82 ливни, 95-99 гроза)" };
}
async function askOpenAI(onText, signal) {
  const base = (S.oaBase || DEFAULTS.oaBase).trim().replace(/\/+$/, "");
  const messages = [{ role: "system", content: systemPrompt() }, ...history().map(h => ({ role: h.role, content: h.text }))];
  const sources = [];
  for (let round = 0; round < 4; round++) {
    const res = await fetch(base + "/chat/completions", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + S.oaKey.trim(), "X-Title": "Dmitriy Pavlov" },
      body: JSON.stringify({ model: S.oaModel.trim(), messages, tools: OA_TOOLS, temperature: 0.7 }),
    });
    if (!res.ok) await httpError(res, "openai");
    const j = await res.json();
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m) throw new Error("Пустой ответ модели");
    if (m.tool_calls && m.tool_calls.length) {
      messages.push(m);
      onText("🔎 Ищу…");
      for (const call of m.tool_calls) {
        let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        let result;
        try { result = call.function.name === "get_weather" ? await toolWeather(String(args.city || "")) : await toolSearch(String(args.query || ""), sources); }
        catch (e) { result = "Ошибка: " + e.message; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
      }
      continue;
    }
    const text = m.content || ""; onText(text);
    return { text, sources };
  }
  throw new Error("Слишком много шагов поиска");
}

function explainError(e) {
  const s = e.status, m = String(e.message || "");
  if (/location is not supported|User location/i.test(m)) return "Google не пускает к Gemini из твоей страны. Варианты: включить VPN на iPhone, или в «Настройках» выбрать другую нейросеть (OpenRouter или Claude).";
  if (s === 400 && /API key|API_KEY/i.test(m)) return "Ключ не подходит. Проверь, что скопировал его целиком, во вкладке «Настройки».";
  if (s === 401 || s === 403) return "Доступ отклонён: проверь ключ в «Настройках». " + (m ? "(" + m.slice(0, 160) + ")" : "");
  if (s === 404) return "Такой модели нет. Во вкладке «Настройки» поставь модель по умолчанию (для Gemini: gemini-2.5-flash). " + (m ? "(" + m.slice(0, 120) + ")" : "");
  if (s === 429) return "Лимит запросов исчерпан. У бесплатного ключа есть лимит в минуту и в сутки — подожди немного.";
  if (s >= 500) return "Сервис нейросети сейчас перегружен. Повтори через минуту.";
  if (e.name === "TypeError") return "Нет связи с сервисом. Проверь интернет (или VPN).";
  return "Не получилось: " + m.slice(0, 200);
}

let busy = null;
function updateStatus() {
  if (rec) return;
  const on = hasKey();
  $("#dot").classList.toggle("on", on);
  $("#status").textContent = busy ? "Думаю…" : on ? "На связи" : "Нужно подключить мозг";
}
async function send(text) {
  text = String(text || "").trim();
  if (!text) return;
  if (busy) busy.abort();
  stopRec();
  try { speechSynthesis.cancel(); } catch {}
  $("#input").value = ""; autosize();
  setTab("chat");
  addMsg("me", text);
  msgs.push({ role: "user", text, ts: Date.now() }); persist();
  if (!hasKey()) { addMsg("sys", "Сначала подключи мозг: вставь ключ во вкладке «Настройки»."); return; }
  const el = addMsg("ai", ""); const body = el.querySelector(".body");
  body.innerHTML = `<span class="thinking">Думаю…</span>`;
  const ctl = new AbortController(); busy = ctl; updateStatus();
  const onText = t => { const v = stripActions(t); if (v) { body.innerHTML = md(v); scrollDown(); } };
  try {
    const ask = S.provider === "claude" ? askClaude : S.provider === "openai" ? askOpenAI : askGemini;
    const { text: raw, sources } = await ask(onText, ctl.signal);
    const visible = stripActions(raw) || "Готово.";
    body.innerHTML = md(visible);
    addSources(el, sources);
    const { newTasks } = applyActions(extractActions(raw));
    const rawForHistory = visible; // в историю — без служебного блока
    msgs.push({ role: "ai", text: visible, raw: rawForHistory, ts: Date.now(), sources: sources.slice(0, 6) }); persist();
    if (newTasks.length) addTaskButtons(el, newTasks);
    scrollDown();
    busy = null; updateStatus();
    await speak(visible);
    if (newTasks.some(t => t.due) && S.autoReminders) sendToIOS(newTasks.find(t => t.due));
  } catch (e) {
    if (e.name === "AbortError") { body.innerHTML = `<span class="thinking">Остановлено.</span>`; }
    else { const m = explainError(e); body.innerHTML = `<span class="thinking">${esc(m)}</span>`; speak(m); }
  } finally {
    if (busy === ctl) busy = null;
    updateStatus();
    if (wakeOn) { followUntil = Date.now() + 9000; setTimeout(resumeWake, 400); }
  }
}
function addTaskButtons(el, list) {
  const box = document.createElement("div"); box.className = "acts";
  list.filter(t => t.due).forEach(t => {
    const b = document.createElement("button"); b.className = "pill"; b.type = "button";
    b.textContent = "⏰ В Напоминания iPhone: " + fmtDue(t.due);
    b.onclick = () => sendToIOS(t); box.append(b);
    const c = document.createElement("button"); c.className = "pill"; c.type = "button";
    c.textContent = "📅 В Календарь"; c.onclick = () => addToCalendar(t); box.append(c);
  });
  if (box.children.length) el.append(box);
}

/* ---------------- Напоминания ---------------- */
const SHORTCUT = "ДП Напоминание";
function sendToIOS(t) {
  const payload = JSON.stringify({ title: t.text, due: isoLocal(t.due) });
  location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT) + "&input=text&text=" + encodeURIComponent(payload);
}
function addToCalendar(t) {
  const d = new Date(t.due), e = new Date(t.due + 15 * 60000);
  const f = x => `${x.getFullYear()}${pad(x.getMonth()+1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  const ics = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//DmitriyPavlov//RU","BEGIN:VEVENT",`UID:${t.id}@dmitriy-pavlov`,
    `DTSTAMP:${f(new Date())}`,`DTSTART:${f(d)}`,`DTEND:${f(e)}`,`SUMMARY:${t.text.replace(/[,;\\]/g, " ")}`,
    "BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:Напоминание","TRIGGER:PT0M","END:VALARM","END:VEVENT","END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "napominanie.ics"; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, .25].forEach(dt => { const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + dt; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.2, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .2);
      o.start(t); o.stop(t + .22); });
  } catch {}
}
function toast(t) { $("#toastText").textContent = t; $("#toast").hidden = false; }
$("#toastOk").onclick = () => { $("#toast").hidden = true; };
function checkReminders() {
  const now = Date.now(); let changed = false;
  tasks.filter(t => !t.done && !t.notified && t.due && t.due <= now && now - t.due < 864e5).forEach(t => {
    t.notified = true; changed = true;
    const msg = "Сумрак, напоминаю: " + t.text;
    toast("⏰ " + t.text); beep(); addMsg("ai", msg); speak(msg, true);
  });
  if (changed) { persist(); render(); }
}

/* ---------------- Настройки ---------------- */
function fillSettings() {
  $("#provider").value = S.provider;
  ["geminiKey", "geminiModel", "claudeKey", "claudeModel", "oaBase", "oaKey", "oaModel"].forEach(k => { $("#" + k).value = S[k] || ""; });
  $("#rate").value = S.rate; $("#rateVal").textContent = "×" + (+S.rate).toFixed(2);
  $("#speakOn").checked = S.speakOn; $("#wakeOnStart").checked = S.wakeOnStart; $("#autoReminders").checked = S.autoReminders;
  $$(".field[data-for]").forEach(f => { f.hidden = f.dataset.for !== S.provider; });
  updateStatus();
}
$("#provider").onchange = e => { S.provider = e.target.value; saveSettings(); fillSettings(); };
["geminiKey", "geminiModel", "claudeKey", "claudeModel", "oaBase", "oaKey", "oaModel"].forEach(k => {
  $("#" + k).addEventListener("change", e => { S[k] = e.target.value.trim(); saveSettings(); updateStatus(); });
});
$("#voice").onchange = e => { S.voice = e.target.value; saveSettings(); };
$("#rate").oninput = e => { S.rate = +e.target.value; $("#rateVal").textContent = "×" + S.rate.toFixed(2); saveSettings(); };
$("#speakOn").onchange = e => { S.speakOn = e.target.checked; saveSettings(); };
$("#wakeOnStart").onchange = e => { S.wakeOnStart = e.target.checked; saveSettings(); };
$("#autoReminders").onchange = e => { S.autoReminders = e.target.checked; saveSettings(); };
$("#testVoice").onclick = () => { unlockAudio(); speak("Сумрак, я на связи. Так звучит мой голос.", true); };
$("#testReminder").onclick = () => sendToIOS({ text: "Проверка: Дмитрий Павлов", due: Date.now() + 2 * 60000 });
async function testBrain(fromCard) {
  const out = $("#testOut"); out.textContent = "Проверяю…";
  const ask = S.provider === "claude" ? askClaude : S.provider === "openai" ? askOpenAI : askGemini;
  const saved = msgs; msgs = [{ role: "user", text: "Ответь одним коротким предложением: ты на связи?" }];
  try { const r = await ask(() => {}, undefined); out.textContent = "Работает ✓"; if (fromCard) addMsg("ai", stripActions(r.text) || "На связи."); }
  catch (e) { out.textContent = explainError(e); if (fromCard) addMsg("ai", explainError(e)); }
  finally { msgs = saved; updateStatus(); }
}
$("#testBrain").onclick = () => testBrain(false);

$("#backup").onclick = async () => {
  const data = JSON.stringify({ v: 1, facts, tasks, notes, msgs: msgs.slice(-200) });
  try { await navigator.clipboard.writeText(data); toast("Резервная копия скопирована. Сохрани её в Заметки iPhone."); }
  catch { $("#restoreBox").hidden = false; $("#restoreText").value = data; $("#restoreText").select(); toast("Выдели и скопируй текст вручную."); }
};
$("#restoreBtn").onclick = () => { $("#restoreBox").hidden = !$("#restoreBox").hidden; };
$("#restoreGo").onclick = () => {
  try {
    const d = JSON.parse($("#restoreText").value);
    if (Array.isArray(d.facts)) facts = d.facts; if (Array.isArray(d.tasks)) tasks = d.tasks;
    if (Array.isArray(d.notes)) notes = d.notes; if (Array.isArray(d.msgs)) msgs = d.msgs;
    persist(); render(); renderChat(); toast("Восстановлено."); $("#restoreBox").hidden = true;
  } catch { toast("Не получилось: текст копии повреждён."); }
};
let clearArmed = false;
$("#clearChat").onclick = e => {
  if (!clearArmed) { clearArmed = true; e.target.textContent = "Точно очистить?"; setTimeout(() => { clearArmed = false; e.target.textContent = "Очистить переписку"; }, 4000); return; }
  msgs = []; persist(); renderChat(); e.target.textContent = "Очистить переписку"; clearArmed = false;
};

/* ---------------- Списки: действия ---------------- */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-del-task],[data-del-note],[data-del-fact],[data-ios]"); if (!t) return;
  if (t.dataset.delTask) tasks = tasks.filter(x => x.id !== t.dataset.delTask);
  if (t.dataset.delNote) notes = notes.filter(x => x.id !== t.dataset.delNote);
  if (t.dataset.delFact) facts = facts.filter(x => x.id !== t.dataset.delFact);
  if (t.dataset.ios) { const task = tasks.find(x => x.id === t.dataset.ios); if (task) sendToIOS(task); return; }
  persist(); render();
});
document.addEventListener("change", e => {
  const id = e.target.dataset && e.target.dataset.done; if (!id) return;
  const t = tasks.find(x => x.id === id); if (t) { t.done = e.target.checked; persist(); render(); }
});
$("#addTask").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newTask").value.trim(); if (!text) return;
  const due = $("#newDue").value ? parseLocal($("#newDue").value) : null;
  tasks.push({ id: uid(), text, due, done: false, notified: false, ts: Date.now() }); persist(); render();
  $("#newTask").value = ""; $("#newDue").value = "";
});
$("#addNote").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newNote").value.trim(); if (!text) return;
  notes.push({ id: uid(), text, ts: Date.now() }); persist(); render(); $("#newNote").value = "";
});
$("#addFact").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newFact").value.trim(); if (!text) return;
  facts.push({ id: uid(), text, ts: Date.now() }); persist(); render(); $("#newFact").value = "";
});

/* ---------------- Ввод и вкладки ---------------- */
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($("#input").value); } });
$("#form").addEventListener("submit", e => { e.preventDefault(); unlockAudio(); if (busy && !$("#input").value.trim()) { busy.abort(); return; } send($("#input").value); });
function setTab(t) { document.body.dataset.tab = t; $$(".tabbar button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t))); if (t === "chat") scrollDown(); }
$(".tabbar").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

/* ---------------- Запуск ---------------- */
$("#ver").textContent = "Версия " + VERSION;
tickClock(); setInterval(tickClock, 1000);
fillSettings(); render(); renderChat(); setTab("chat");
loadVoices(); try { speechSynthesis.onvoiceschanged = loadVoices; } catch {}
setInterval(checkReminders, 10000); checkReminders();
if (!SR) showHint("");
if (S.wakeOnStart && SR) { wakeOn = true; syncWakeBtn(); startRec("wake"); }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopRec(); } else { checkReminders(); if (wakeOn) resumeWake(); }
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
