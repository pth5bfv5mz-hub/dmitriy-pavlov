/* Дмитрий Павлов — личный ассистент Сумрака.
   Всё хранится в браузере телефона (localStorage). Сервера нет: приложение
   само обращается к выбранной нейросети по ключу пользователя. */
(() => {
"use strict";
const VERSION = "2.0.0";
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
let msgs = load("msgs", []);       // {role:'user'|'ai', text, ts, sources?, photo?}
let facts = load("facts", []);     // {id, text, cat, ts}
let tasks = load("tasks", []);     // {id, text, due, repeat, done, notified, ts}
let notes = load("notes", []);     // {id, text, ts}
let diary = load("diary", { text: "", upTo: 0 });   // сводка прошлых разговоров
let meta = load("meta", { lastTidy: 0 });
const persist = () => { save("msgs", msgs.slice(-400)); save("facts", facts); save("tasks", tasks); save("notes", notes); save("diary", diary); save("meta", meta); };
const saveSettings = () => save("settings", S);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return n + " " + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many); };
const arr = x => Array.isArray(x) ? x : (x ? [x] : []);

const CATS = ["личное", "люди", "работа", "учёба", "здоровье", "деньги", "цели", "предпочтения", "другое"];
const normCat = c => { c = String(c || "").toLowerCase().trim(); return CATS.includes(c) ? c : "другое"; };

/* ---------------- Время ---------------- */
const DAYS = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const DAYS_SHORT = ["вс","пн","вт","ср","чт","пт","сб"];
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const REPEAT_TXT = { daily: "каждый день", weekdays: "по будням", weekly: "каждую неделю", monthly: "каждый месяц", yearly: "каждый год" };
const pad = n => String(n).padStart(2, "0");
const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const isoLocal = ms => { const d = new Date(ms); return `${ymd(d)} ${hm(d)}`; };
const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
function fmtDue(ms) {
  const d = new Date(ms), n = new Date();
  const diff = Math.round((dayStart(d) - dayStart(n)) / 864e5);
  const w = diff === 0 ? "сегодня" : diff === 1 ? "завтра" : diff === -1 ? "вчера"
    : d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== n.getFullYear() ? " " + d.getFullYear() : "");
  return w + ", " + hm(d);
}
function nowText() {
  const d = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hm(d)}${tz ? " (часовой пояс " + tz + ")" : ""}`;
}
function calendarText() {
  // Таблица ближайших дней: модели часто ошибаются в днях недели, так что даём их готовыми.
  const out = []; const d = new Date();
  for (let i = 0; i < 15; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    out.push(`${DAYS_SHORT[x.getDay()]} ${ymd(x)}${i === 0 ? " (сегодня)" : i === 1 ? " (завтра)" : i === 2 ? " (послезавтра)" : ""}`);
  }
  return out.join("; ");
}
function parseLocal(s) {
  const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0).getTime();
  return isNaN(t) ? null : t;
}
function nextDue(due, repeat) {
  const d = new Date(due);
  const step = () => {
    if (repeat === "daily") d.setDate(d.getDate() + 1);
    else if (repeat === "weekdays") { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
    else if (repeat === "yearly") d.setFullYear(d.getFullYear() + 1);
    else return false;
    return true;
  };
  if (!step()) return null;
  while (d.getTime() <= Date.now()) step();   // если приложение долго не открывали — догоняем
  return d.getTime();
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
      <div class="tx">${esc(t.text)}${t.due ? `<span class="due${!t.done && t.due < Date.now() ? " over" : ""}">${fmtDue(t.due)}${t.repeat ? " · " + REPEAT_TXT[t.repeat] : ""}</span>` : ""}</div>
      <div class="btns">${t.due && !t.done ? `<button class="x" data-ios="${t.id}" title="В Напоминания iPhone">⏰</button>` : ""}<button class="x" data-del-task="${t.id}" aria-label="Удалить">×</button></div>
    </li>`).join("");
  toggleEmpty("#tasks", ts.length, "Дел нет. Скажи, например: «напомни завтра в 9 позвонить маме» или «каждый день в 8 напоминай пить воду».");

  const ns = notes.slice().sort((a, b) => b.ts - a.ts);
  $("#nstat").textContent = ns.length || "";
  $("#notes").innerHTML = ns.map(n => `
    <li class="row nocheck"><div class="tx">${esc(n.text)}<span class="due">${fmtDue(n.ts)}</span></div>
    <button class="x" data-del-note="${n.id}" aria-label="Удалить">×</button></li>`).join("");
  toggleEmpty("#notes", ns.length, "Пока пусто. Скажи «запиши заметку…» или впиши ниже.");

  $("#mstat").textContent = facts.length || "";
  const groups = CATS.map(c => [c, facts.filter(f => normCat(f.cat) === c)]).filter(g => g[1].length);
  $("#facts").innerHTML = groups.map(([c, list]) => `<li class="grp">${esc(c)}</li>` + list.map(f => `
    <li class="row nocheck"><div class="tx">${esc(f.text)}</div>
    <button class="x" data-del-fact="${f.id}" aria-label="Забыть">×</button></li>`).join("")).join("");
  toggleEmpty("#facts", facts.length, "Пока ничего. Просто разговаривай со мной — я буду запоминать важное.");
  $("#diary").textContent = diary.text || "Пока пусто. Когда разговоров станет больше, здесь появится краткая история: о чём мы говорили и что решили.";
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
  if (extra && extra.img) { const im = document.createElement("img"); im.src = extra.img; im.alt = "Фото"; im.className = "thumb"; el.prepend(im); }
  else if (extra && extra.photo && role === "me") { const s = document.createElement("div"); s.className = "small"; s.textContent = "📷 фото"; el.prepend(s); }
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
function addMsgTools(el, text) {
  const box = document.createElement("div"); box.className = "acts";
  const say = document.createElement("button"); say.type = "button"; say.className = "pill"; say.textContent = "🔊 Озвучить";
  say.onclick = () => { unlockAudio(); speak(text, true); };
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "pill"; copy.textContent = "Копировать";
  copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = "Скопировано"; } catch { copy.textContent = "Не вышло"; } };
  box.append(say, copy); el.append(box);
}
function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const now = Date.now();
  const overdue = tasks.filter(t => !t.done && !t.repeat && t.due && t.due < now);
  const today = tasks.filter(t => !t.done && t.due && t.due >= now && t.due < dayStart(new Date()) + 864e5);
  let tail = "";
  if (overdue.length) tail += ` Есть просроченное: ${overdue.slice(0, 2).map(t => t.text).join("; ")}.`;
  if (today.length) tail += ` Сегодня: ${today.slice(0, 3).map(t => t.text + " в " + hm(new Date(t.due))).join("; ")}.`;
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
  sel.innerHTML = `<option value="">Автоматически (мужской, если есть)</option>` + voices.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${v.localService ? "" : " (сеть)"}</option>`).join("");
  sel.value = S.voice && voices.some(v => v.voiceURI === S.voice) ? S.voice : "";
}
function pickVoice() {
  return voices.find(v => v.voiceURI === S.voice) || voices.find(v => /yuri|юрий|dmitr|pavel|maxim|male/i.test(v.name)) || voices[0] || null;
}
function speechChunks(text) {
  const clean = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "")
    .replace(/[*#`•_>|]/g, "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
  // iOS обрывает длинные фразы — говорим по предложениям.
  const parts = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean];
  const out = []; let cur = "";
  parts.forEach(p => { if ((cur + p).length > 220 && cur) { out.push(cur.trim()); cur = ""; } cur += p; });
  if (cur.trim()) out.push(cur.trim());
  return out;
}
let speaking = false, speakToken = 0;
function stopSpeaking() { speakToken++; speaking = false; try { speechSynthesis.cancel(); } catch {} syncSendBtn(); }
function speak(text, force) {
  return new Promise(resolve => {
    if ((!S.speakOn && !force) || !window.speechSynthesis || !text) return resolve();
    stopSpeaking(); stopRec();
    const my = ++speakToken; const chunks = speechChunks(text); const v = pickVoice();
    speaking = true; syncSendBtn();
    const next = i => {
      if (my !== speakToken || i >= chunks.length) { if (my === speakToken) { speaking = false; syncSendBtn(); } return resolve(); }
      try {
        const u = new SpeechSynthesisUtterance(chunks[i]);
        u.lang = "ru-RU"; if (v) u.voice = v; u.rate = +S.rate || 1; u.pitch = 0.95;
        u.onend = () => next(i + 1); u.onerror = () => next(i + 1);
        speechSynthesis.speak(u);
      } catch { next(i + 1); }
    };
    next(0);
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
const WAKE_RE = /(привет[,\s]*|эй[,\s]*|слушай[,\s]*)?(дмитрий|дмитрия|дмитрию|дима|димон|дмитри)(\s+павлов\w*)?[,!.?\s]*/i;
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
        else speak("Слушаю, Сумрак.", true).then(() => { if (wakeOn) startRec("command"); });
      }
    }
  };
  r.onerror = e => {
    if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) { showHint(MIC_HINT); wakeOn = false; syncWakeBtn(); }
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
  stopSpeaking();
  startRec("command");
};
$("#wake").onclick = () => {
  unlockAudio();
  wakeOn = !wakeOn; syncWakeBtn();
  if (wakeOn) { showHint("Скажи «Дмитрий…» или «Привет, Дмитрий Павлов» — я отвечу и потом ещё немного слушаю без обращения. Приложение должно быть открыто."); startRec("wake"); }
  else { stopRec(); showHint(""); }
};

/* ---------------- Фото ---------------- */
let photo = null;   // {mime, b64, url}
$("#photoBtn").onclick = () => $("#photo").click();
$("#photo").onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { photo = await shrinkImage(f); showPhoto(); }
  catch { toast("Не получилось открыть фото. Попробуй другое."); }
};
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      const data = c.toDataURL("image/jpeg", 0.85);
      resolve({ mime: "image/jpeg", b64: data.split(",")[1], url: data });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img")); };
    img.src = url;
  });
}
function showPhoto() {
  $("#photoPrev").hidden = !photo;
  if (photo) $("#photoImg").src = photo.url;
}
$("#photoDel").onclick = () => { photo = null; showPhoto(); };

/* ---------------- Мозг: правила ---------------- */
function systemPrompt() {
  const now = Date.now();
  const openTasks = tasks.filter(t => !t.done);
  const factsText = CATS.map(c => {
    const list = facts.filter(f => normCat(f.cat) === c);
    return list.length ? `${c}:\n` + list.map(f => `- [${f.id}] ${f.text}`).join("\n") : "";
  }).filter(Boolean).join("\n");
  const searchNote = S.provider === "openai"
    ? "У тебя есть инструменты: search_web (Википедия) и get_weather (погода). Пользуйся ими для фактов и погоды."
    : "У тебя есть поиск в интернете" + (S.provider === "gemini" ? " (Google) и чтение страниц по ссылкам" : "") + ". Пользуйся им.";
  return `Ты — Дмитрий Павлов, личный ассистент Сумрака в духе Джарвиса. Обращайся к нему «Сумрак» и всегда на «ты». Отвечай по-русски.

ХАРАКТЕР
- Спокойный и умный. Говоришь прямо, не сглаживаешь углы, но никогда не грубишь.
- Сумрак для тебя авторитет, ты его уважаешь, но не боишься: если он ошибается или задумал неудачное, спокойно скажи и объясни почему, предложи лучше.
- Если он говорит о личном и тяжёлом — поддержи по-человечески, тепло, но без лжи и лести. Сначала выслушай, потом советуй.
- Никогда не врёшь и не выдумываешь факты, цифры, цитаты и ссылки. Если не уверен — скажи, насколько уверен.

КАК ТЫ ДУМАЕШЬ
- Сначала пойми, что Сумраку на самом деле нужно, и отвечай на это.
- ${searchNote} Обязательно ищи, если вопрос про то, что могло измениться: новости, цены, курсы, погода, расписания, законы, люди, товары, спорт, технологии, события после твоего обучения. Не говори «у меня нет доступа к интернету».
- Если ничего надёжного не нашёл — прямо скажи «не нашёл» и предложи, где проверить.
- Для сложного — разбери по шагам, проверь расчёты, дай итог и свою рекомендацию. Давай конкретику: цифры, шаги, варианты с плюсами и минусами.
- Если вопрос двусмысленный и от ответа зависит результат — задай один короткий уточняющий вопрос.
- Используй всё, что знаешь о Сумраке (память и история ниже), чтобы ответ был именно для него. Не переспрашивай то, что уже знаешь.
- Если прислали фото — внимательно разбери, что на нём, и помоги по делу (текст, задача, документ, чек, вещь).
- Помогаешь во всём: работа и бизнес, учёба, здоровье и спорт, деньги и быт. По серьёзным вопросам здоровья, денег и права давай практичный совет, но честно говори, когда нужен специалист.

ИНИЦИАТИВА (в меру)
- Напоминай о делах, сроках и обещаниях, которые Сумрак мог забыть, особенно о просроченных.
- Когда он говорит о планах — предложи поставить напоминание (или сразу поставь, если он явно просит).
- Иногда спрашивай, как продвигаются его цели. Не навязывайся и не повторяйся.

ФОРМА ОТВЕТА
- Длина по ситуации: на простое коротко, обычно средне, на сложное подробно и по шагам. Ориентируйся на то, как пишет Сумрак.
- Ответ озвучивается голосом: естественная речь, без таблиц; списки только когда правда нужны. Не вставляй ссылки в текст — источники покажутся отдельно.
- Если Сумрак просто здоровается («Привет, Дмитрий Павлов») — поздоровайся, коротко скажи о важном (если есть) и поддержи беседу.

СЕЙЧАС: ${nowText()}
КАЛЕНДАРЬ: ${calendarText()}

ЧТО ТЫ ЗНАЕШЬ О СУМРАКЕ (долгая память):
${factsText || "(пока ничего — узнавай в разговоре)"}

ИСТОРИЯ ПРОШЛЫХ РАЗГОВОРОВ (краткая сводка):
${diary.text || "(пока нет)"}

ОТКРЫТЫЕ ДЕЛА И НАПОМИНАНИЯ:
${openTasks.map(t => `- [${t.id}] ${t.text}${t.due ? " — " + isoLocal(t.due) + (t.due < now ? " (ПРОСРОЧЕНО)" : "") : ""}${t.repeat ? " (" + REPEAT_TXT[t.repeat] + ")" : ""}`).join("\n") || "(нет)"}

ЗАМЕТКИ:
${notes.slice(-30).map(n => `- [${n.id}] ${n.text}`).join("\n") || "(нет)"}

ДЕЙСТВИЯ — ты сам ведёшь память, дела и заметки Сумрака
Если нужно что-то сохранить или изменить, в САМОМ КОНЦЕ ответа добавь блок ровно в таком виде (валидный JSON, только нужные поля):
<<<ACTIONS
{"remember":[{"text":"...","cat":"..."}],"forget":[],"tasks":[{"text":"...","due":"ГГГГ-ММ-ДД ЧЧ:ММ","repeat":null}],"update_tasks":[{"id":"...","text":"...","due":"..."}],"done":[],"delete_tasks":[],"notes":[],"delete_notes":[]}
ACTIONS>>>
- remember: новые важные факты о Сумраке из ЭТОГО разговора — кратко, каждый отдельно. cat — одно из: ${CATS.join(", ")}. Запоминай: чем занимается, цели и планы, обещания, привычки, здоровье и самочувствие, близких (имена, кто кому кем приходится, дни рождения), предпочтения, важные события. Не дублируй известное; если факт изменился — добавь новый, а id старого укажи в forget.
- tasks: новые дела. due — местное время (сверяйся с КАЛЕНДАРЁМ), null если срока нет. repeat — null, "daily", "weekdays", "weekly", "monthly" или "yearly" (дни рождения — yearly). Ставь, когда Сумрак просит напомнить или называет дело с конкретным сроком. Если время не названо, но день есть — 09:00.
- update_tasks: перенос или изменение существующего дела по id.
- done / delete_tasks / delete_notes / forget: массивы id из квадратных скобок.
- notes: тексты новых заметок, если Сумрак просит записать.
Если сохранять нечего — блок не добавляй. Никогда не упоминай этот блок в тексте. Подтверждай действия естественно («Записал», «Напомню завтра в 9»).`;
}

function stripActions(text) {
  const i = text.indexOf("<<<");
  let vis = i >= 0 ? text.slice(0, i) : text.replace(/<{1,2}\s*$/, "");
  return vis.replace(/```\s*(json)?\s*$/i, "").trim();
}
function extractActions(text) {
  const m = text.match(/<<<\s*ACTIONS([\s\S]*?)(ACTIONS\s*>>>|$)/);
  if (!m) return null;
  const body = m[1].trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
function applyActions(act) {
  const out = { newTasks: [] };
  if (!act || typeof act !== "object") return out;
  const forget = arr(act.forget).map(String);
  facts = facts.filter(f => !forget.includes(f.id));
  arr(act.remember).forEach(r => {
    const text = String(typeof r === "string" ? r : r && r.text || "").trim();
    if (!text || facts.some(f => f.text.toLowerCase() === text.toLowerCase())) return;
    facts.push({ id: uid(), text, cat: normCat(r && r.cat), ts: Date.now() });
  });
  arr(act.tasks).forEach(t => {
    const text = String(typeof t === "string" ? t : t && t.text || "").trim();
    if (!text) return;
    const due = t && t.due ? parseLocal(t.due) : null;
    const repeat = t && REPEAT_TXT[t.repeat] ? t.repeat : null;
    const task = { id: uid(), text, due, repeat: due ? repeat : null, done: false, notified: false, ts: Date.now() };
    tasks.push(task); out.newTasks.push(task);
  });
  arr(act.update_tasks).forEach(u => {
    const t = u && tasks.find(x => x.id === String(u.id)); if (!t) return;
    if (u.text) t.text = String(u.text);
    if (u.due !== undefined) { t.due = u.due ? parseLocal(u.due) : null; t.notified = false; }
    if (u.repeat !== undefined) t.repeat = REPEAT_TXT[u.repeat] ? u.repeat : null;
    out.newTasks.push(t);
  });
  const done = arr(act.done).map(String); tasks.forEach(t => { if (done.includes(t.id)) t.done = true; });
  const delT = arr(act.delete_tasks).map(String); tasks = tasks.filter(t => !delT.includes(t.id));
  arr(act.notes).forEach(t => { t = String(typeof t === "string" ? t : t && t.text || "").trim(); if (t) notes.push({ id: uid(), text: t, ts: Date.now() }); });
  const delN = arr(act.delete_notes).map(String); notes = notes.filter(n => !delN.includes(n.id));
  persist(); render();
  return out;
}

/* Сколько последних сообщений идёт в контекст: до ~30 штук и ~16 000 символов. */
function contextWindow() {
  let chars = 0, start = msgs.length;
  for (let i = msgs.length - 1; i >= 0 && msgs.length - i <= 30; i--) {
    chars += (msgs[i].text || "").length;
    if (chars > 16000 && i < msgs.length - 1) break;
    start = i;
  }
  return start;
}
function history() {
  return msgs.slice(contextWindow()).map(m => ({ role: m.role === "user" ? "user" : "assistant", text: (m.photo && m.role === "user" ? "[прислал фото] " : "") + m.text }));
}

/* ---------------- Мозг: сеть ---------------- */
async function readSSE(res, onEvent, signal) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  const handle = line => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim(); if (!d || d === "[DONE]") return;
    let j; try { j = JSON.parse(d); } catch { return; }
    onEvent(j);
  };
  while (true) {
    if (signal && signal.aborted) { try { reader.cancel(); } catch {} throw new DOMException("aborted", "AbortError"); }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, idx).replace(/\r$/, ""); buf = buf.slice(idx + 1); handle(line); }
  }
  if (buf.trim()) handle(buf.trim());
}
async function httpError(res, who) {
  let msg = ""; try { const j = await res.json(); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && (e.message || e.type)) || JSON.stringify(j).slice(0, 300); } catch {}
  const e = new Error(msg || ("HTTP " + res.status)); e.status = res.status; e.who = who; throw e;
}
const retriable = e => e && (e.status === 404 || e.status === 429 || e.status >= 500);

/* Gemini — с поиском Google и чтением ссылок. При лимите или сбое пробует соседние модели. */
const GEMINI_FALLBACK = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
const geminiChain = first => [...new Set([first || DEFAULTS.geminiModel, ...GEMINI_FALLBACK].map(s => s.trim()).filter(Boolean))];
function geminiContents(hist, img) {
  const contents = [];
  hist.forEach(h => {
    const role = h.role === "user" ? "user" : "model";
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts[0].text += "\n\n" + h.text;
    else contents.push({ role, parts: [{ text: h.text }] });
  });
  if (img && contents.length) contents[contents.length - 1].parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
  return contents;
}
async function geminiStream(model, body, onText, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(S.geminiKey.trim())}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) await httpError(res, "gemini");
  let text = ""; const sources = []; let blocked = "";
  await readSSE(res, ev => {
    if (ev.error) { const e = new Error(ev.error.message || "Ошибка Gemini"); e.status = ev.error.code; throw e; }
    if (ev.promptFeedback && ev.promptFeedback.blockReason) blocked = ev.promptFeedback.blockReason;
    const c = ev.candidates && ev.candidates[0]; if (!c) return;
    ((c.content && c.content.parts) || []).forEach(p => { if (p.text && !p.thought) { text += p.text; onText(text); } });
    const g = c.groundingMetadata;
    if (g && g.groundingChunks) g.groundingChunks.forEach(ch => { if (ch.web && ch.web.uri && !sources.some(s => s.url === ch.web.uri)) sources.push({ url: ch.web.uri, title: ch.web.title || "" }); });
  }, signal);
  if (!text && blocked) text = "На это я ответить не могу — Google заблокировал запрос. Сформулируй иначе.";
  return { text, sources };
}
async function askGemini(hist, img, onText, signal) {
  const base = { system_instruction: { parts: [{ text: systemPrompt() }] }, contents: geminiContents(hist, img), generationConfig: { temperature: 0.6 } };
  let lastErr;
  for (const model of geminiChain(S.geminiModel)) {
    for (const tools of [[{ google_search: {} }, { url_context: {} }], [{ google_search: {} }]]) {
      try { return await geminiStream(model, { ...base, tools }, onText, signal); }
      catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
        if (e.status === 400 && /url_context|tool/i.test(e.message || "")) continue;  // модель без чтения ссылок
        break;
      }
    }
    if (!retriable(lastErr)) throw lastErr;
  }
  throw lastErr;
}
async function plainGemini(system, prompt) {
  let lastErr;
  for (const model of [...new Set(["gemini-2.5-flash-lite", ...geminiChain(S.geminiModel)])]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(S.geminiKey.trim())}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      });
      if (!res.ok) await httpError(res, "gemini");
      const j = await res.json();
      return ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    } catch (e) { lastErr = e; if (!retriable(e)) throw e; }
  }
  throw lastErr;
}

/* Claude — с веб-поиском */
function claudeMessages(hist, img) {
  const messages = [];
  hist.forEach(h => {
    if (messages.length && messages[messages.length - 1].role === h.role) messages[messages.length - 1].content += "\n\n" + h.text;
    else messages.push({ role: h.role, content: h.text });
  });
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (img && messages.length) {
    const last = messages[messages.length - 1];
    last.content = [{ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } }, { type: "text", text: last.content }];
  }
  return messages;
}
const claudeHeaders = () => ({ "content-type": "application/json", "x-api-key": S.claudeKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
async function askClaude(hist, img, onText, signal) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal, headers: claudeHeaders(),
    body: JSON.stringify({ model: (S.claudeModel || DEFAULTS.claudeModel).trim(), max_tokens: 4096, system: systemPrompt(), messages: claudeMessages(hist, img), stream: true,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }),
  });
  if (!res.ok) await httpError(res, "claude");
  let text = ""; const sources = [];
  await readSSE(res, ev => {
    if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "text" && text && !/\s$/.test(text)) text += " ";
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; onText(text); }
    if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "web_search_tool_result" && Array.isArray(ev.content_block.content)) {
      ev.content_block.content.forEach(r => { if (r.url && !sources.some(s => s.url === r.url)) sources.push({ url: r.url, title: r.title || "" }); });
    }
    if (ev.type === "error") { const e = new Error(ev.error && ev.error.message || "Ошибка Claude"); e.status = ev.error && ev.error.type === "overloaded_error" ? 529 : 0; throw e; }
  }, signal);
  return { text, sources: sources.slice(0, 6) };
}
async function plainClaude(system, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: claudeHeaders(),
    body: JSON.stringify({ model: (S.claudeModel || DEFAULTS.claudeModel).trim(), max_tokens: 2048, system, messages: [{ role: "user", content: prompt }] }) });
  if (!res.ok) await httpError(res, "claude");
  const j = await res.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
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
const oaUrl = () => (S.oaBase || DEFAULTS.oaBase).trim().replace(/\/+$/, "") + "/chat/completions";
const oaHeaders = () => ({ "Content-Type": "application/json", "Authorization": "Bearer " + S.oaKey.trim(), "X-Title": "Dmitriy Pavlov" });
async function askOpenAI(hist, img, onText, signal) {
  const messages = [{ role: "system", content: systemPrompt() }, ...hist.map(h => ({ role: h.role, content: h.text }))];
  if (img) { const last = messages[messages.length - 1]; last.content = [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: img.url } }]; }
  const sources = [];
  for (let round = 0; round < 4; round++) {
    const res = await fetch(oaUrl(), { method: "POST", signal, headers: oaHeaders(), body: JSON.stringify({ model: S.oaModel.trim(), messages, tools: OA_TOOLS, temperature: 0.6 }) });
    if (!res.ok) await httpError(res, "openai");
    const j = await res.json();
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m) throw new Error("Пустой ответ модели");
    if (m.tool_calls && m.tool_calls.length) {
      messages.push(m);
      onText("Ищу…");
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
async function plainOpenAI(system, prompt) {
  const res = await fetch(oaUrl(), { method: "POST", headers: oaHeaders(), body: JSON.stringify({ model: S.oaModel.trim(), temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
  if (!res.ok) await httpError(res, "openai");
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}
const ask = (...a) => (S.provider === "claude" ? askClaude : S.provider === "openai" ? askOpenAI : askGemini)(...a);
const plain = (...a) => (S.provider === "claude" ? plainClaude : S.provider === "openai" ? plainOpenAI : plainGemini)(...a);
function parseJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const a = t.search(/[\[{]/); if (a < 0) return null;
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function explainError(e) {
  const s = e.status, m = String(e.message || "");
  if (/location is not supported|User location/i.test(m)) return "Google не пускает к Gemini из твоей страны. Варианты: включить VPN на iPhone, или в «Настройках» выбрать другую нейросеть (OpenRouter или Claude).";
  if (s === 400 && /API key|API_KEY/i.test(m)) return "Ключ не подходит. Проверь во вкладке «Настройки», что он скопирован целиком.";
  if (s === 401 || s === 403) return "Доступ отклонён: проверь ключ в «Настройках». " + (m ? "(" + m.slice(0, 160) + ")" : "");
  if (s === 404) return "Такой модели нет. Во вкладке «Настройки» выбери модель из списка. " + (m ? "(" + m.slice(0, 120) + ")" : "");
  if (s === 429) return "Лимит бесплатных запросов на сейчас исчерпан, причём у всех запасных моделей. Подожди минуту (или до завтра, если это дневной лимит).";
  if (s >= 500) return "Сервис нейросети сейчас перегружен. Повтори через минуту.";
  if (e.name === "TypeError") return "Нет связи с сервисом. Проверь интернет (или VPN).";
  return "Не получилось: " + m.slice(0, 200);
}

/* ---------------- Разговор ---------------- */
let busy = null;
function updateStatus() {
  if (rec) return;
  const on = hasKey();
  $("#dot").classList.toggle("on", on);
  $("#status").textContent = busy ? "Думаю…" : on ? "На связи" : "Нужно подключить мозг";
  syncSendBtn();
}
function syncSendBtn() {
  const stop = !!busy || speaking;
  $("#send").classList.toggle("stop", stop);
  $("#send").title = busy ? "Остановить" : speaking ? "Замолчать" : "Отправить";
}
async function send(text, opts = {}) {
  text = String(text || "").trim();
  const img = opts.retry ? opts.img : photo;
  if (!text && img) text = "Посмотри на фото и помоги.";
  if (!text) return;
  if (busy) busy.abort();
  stopRec(); stopSpeaking();
  setTab("chat");
  if (!opts.retry) {
    $("#input").value = ""; autosize();
    photo = null; showPhoto();
    addMsg("me", text, { img: img && img.url });
    msgs.push({ role: "user", text, ts: Date.now(), photo: !!img }); persist();
  }
  if (!hasKey()) { addMsg("sys", "Сначала подключи мозг: вставь ключ во вкладке «Настройки»."); return; }
  const el = addMsg("ai", ""); const body = el.querySelector(".body");
  body.innerHTML = `<span class="thinking">${img ? "Смотрю на фото…" : "Думаю…"}</span>`;
  const ctl = new AbortController(); busy = ctl; updateStatus();
  const onText = t => { const v = stripActions(t); if (v) { body.innerHTML = md(v); scrollDown(); } };
  let spoke = false;
  try {
    const { text: raw, sources } = await ask(history(), img, onText, ctl.signal);
    const visible = stripActions(raw) || "Готово.";
    body.innerHTML = md(visible);
    addSources(el, sources);
    const { newTasks } = applyActions(extractActions(raw));
    msgs.push({ role: "ai", text: visible, ts: Date.now(), sources: sources.slice(0, 6) }); persist();
    if (newTasks.length) addTaskButtons(el, newTasks);
    addMsgTools(el, visible);
    scrollDown();
    busy = null; updateStatus();
    background();
    spoke = true;
    await speak(visible);
    const toIOS = newTasks.find(t => t.due);
    if (toIOS && S.autoReminders) sendToIOS(toIOS);
  } catch (e) {
    if (e.name === "AbortError") { body.innerHTML = `<span class="thinking">Остановлено.</span>`; }
    else {
      const m = explainError(e); body.innerHTML = `<span class="thinking">${esc(m)}</span>`;
      const box = document.createElement("div"); box.className = "acts";
      const b = document.createElement("button"); b.type = "button"; b.className = "pill"; b.textContent = "↻ Повторить";
      b.onclick = () => { el.remove(); send(text, { retry: true, img }); };
      box.append(b); el.append(box);
      if (!spoke) speak(m);
    }
  } finally {
    if (busy === ctl) busy = null;
    updateStatus();
    if (wakeOn) { followUntil = Date.now() + 10000; setTimeout(resumeWake, 400); }
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

/* ---------------- Долгая память: дневник и порядок ---------------- */
let bgRunning = false;
async function background() {
  if (bgRunning) return; bgRunning = true;
  try {
    await updateDiary();
    if (facts.length > 60 && Date.now() - (meta.lastTidy || 0) > 3 * 864e5) await tidyMemory(true);
  } catch {} finally { bgRunning = false; }
}
// Сообщения, вышедшие из окна контекста, сжимаются в сводку, чтобы он помнил давние разговоры.
async function updateDiary() {
  const cut = contextWindow();
  const old = msgs.slice(0, cut).filter(m => (m.ts || 0) > (diary.upTo || 0));
  if (old.length < 10) return;
  const convo = old.map(m => `${m.role === "user" ? "Сумрак" : "Дмитрий"} (${m.ts ? isoLocal(m.ts) : ""}): ${m.text}`).join("\n").slice(-30000);
  const res = await plain(
    "Ты ведёшь дневник разговоров ассистента Дмитрия Павлова с Сумраком. Пиши по-русски, сжато, только факты.",
    `Текущая сводка:\n${diary.text || "(пусто)"}\n\nНовые разговоры:\n${convo}\n\nОбнови сводку: добавь главное из новых разговоров (о чём говорили, что Сумрак решил, планировал, обещал, просил, что его беспокоило; даты указывай). Старое сжимай, но не теряй важное. Не более 2500 символов. Верни только текст сводки.`);
  const t = String(res || "").trim();
  if (t.length > 20) { diary = { text: t.slice(0, 4000), upTo: old[old.length - 1].ts || Date.now() }; persist(); render(); }
}
async function tidyMemory(auto) {
  if (!facts.length) return;
  const res = await plain(
    "Ты наводишь порядок в памяти личного ассистента о его хозяине Сумраке. Отвечай только JSON.",
    `Факты:\n${facts.map(f => `- (${normCat(f.cat)}) ${f.text}`).join("\n")}\n\nОбъедини дубли, убери устаревшее и противоречия (оставь более новое — факты идут от старых к новым), сформулируй кратко. Ничего важного не теряй и не выдумывай. Категории: ${CATS.join(", ")}.\nВерни JSON: {"facts":[{"text":"...","cat":"..."}]}`);
  const j = parseJSON(res);
  const list = j && Array.isArray(j.facts) ? j.facts.filter(f => f && f.text) : null;
  if (!list || !list.length || list.length > facts.length + 2 || list.length < facts.length * 0.3) { if (!auto) toast("Не получилось навести порядок. Попробуй позже."); return; }
  facts = list.map(f => ({ id: uid(), text: String(f.text).trim(), cat: normCat(f.cat), ts: Date.now() }));
  meta.lastTidy = Date.now(); persist(); render();
  if (!auto) toast("Готово: в памяти " + plural(facts.length, "факт", "факта", "фактов") + ".");
}
$("#tidy").onclick = async e => {
  if (!hasKey()) { toast("Сначала подключи мозг в «Настройках»."); return; }
  e.target.disabled = true; e.target.textContent = "Навожу порядок…";
  try { await tidyMemory(false); } catch (err) { toast(explainError(err)); }
  e.target.disabled = false; e.target.textContent = "Навести порядок в памяти";
};

/* ---------------- Напоминания ---------------- */
const SHORTCUT = "ДП Напоминание";
function sendToIOS(t) {
  const payload = JSON.stringify({ title: t.text, due: isoLocal(t.due) });
  location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT) + "&input=text&text=" + encodeURIComponent(payload);
}
function addToCalendar(t) {
  const d = new Date(t.due), e = new Date(t.due + 15 * 60000);
  const f = x => `${x.getFullYear()}${pad(x.getMonth()+1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  const rr = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" }[t.repeat];
  const ics = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//DmitriyPavlov//RU","BEGIN:VEVENT",`UID:${t.id}@dmitriy-pavlov`,
    `DTSTAMP:${f(new Date())}`,`DTSTART:${f(d)}`,`DTEND:${f(e)}`,`SUMMARY:${t.text.replace(/[,;\\]/g, " ")}`, ...(rr ? ["RRULE:" + rr] : []),
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
  tasks.filter(t => !t.done && !t.notified && t.due && t.due <= now).forEach(t => {
    changed = true;
    const fresh = now - t.due < 864e5;
    if (fresh) {
      const msg = "Сумрак, напоминаю: " + t.text;
      toast("⏰ " + t.text); beep(); addMsg("ai", msg); speak(msg, true);
    }
    if (t.repeat) { t.due = nextDue(t.due, t.repeat); t.notified = false; }
    else t.notified = true;
  });
  if (changed) { persist(); render(); }
}

/* ---------------- Настройки ---------------- */
const MODEL_PRESETS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"];
function fillSettings() {
  $("#provider").value = S.provider;
  ["claudeKey", "claudeModel", "oaBase", "oaKey", "oaModel", "geminiKey"].forEach(k => { $("#" + k).value = S[k] || ""; });
  const preset = MODEL_PRESETS.includes(S.geminiModel) ? S.geminiModel : "custom";
  $("#geminiModelSel").value = preset; $("#geminiModel").value = S.geminiModel; $("#geminiModel").hidden = preset !== "custom";
  $("#rate").value = S.rate; $("#rateVal").textContent = "×" + (+S.rate).toFixed(2);
  $("#speakOn").checked = S.speakOn; $("#wakeOnStart").checked = S.wakeOnStart; $("#autoReminders").checked = S.autoReminders;
  $$(".field[data-for]").forEach(f => { f.hidden = f.dataset.for !== S.provider; });
  updateStatus();
}
$("#provider").onchange = e => { S.provider = e.target.value; saveSettings(); fillSettings(); renderChatIfKeyChanged(); };
["geminiKey", "claudeKey", "claudeModel", "oaBase", "oaKey", "oaModel", "geminiModel"].forEach(k => {
  $("#" + k).addEventListener("change", e => { S[k] = e.target.value.trim(); saveSettings(); updateStatus(); renderChatIfKeyChanged(); });
});
$("#geminiModelSel").onchange = e => {
  const v = e.target.value;
  if (v === "custom") { $("#geminiModel").hidden = false; $("#geminiModel").focus(); return; }
  S.geminiModel = v; saveSettings(); fillSettings();
};
let hadKey = hasKey();
function renderChatIfKeyChanged() { const k = hasKey(); if (k !== hadKey) { hadKey = k; renderChat(); } }
$("#voice").onchange = e => { S.voice = e.target.value; saveSettings(); };
$("#rate").oninput = e => { S.rate = +e.target.value; $("#rateVal").textContent = "×" + S.rate.toFixed(2); saveSettings(); };
$("#speakOn").onchange = e => { S.speakOn = e.target.checked; saveSettings(); if (!S.speakOn) stopSpeaking(); };
$("#wakeOnStart").onchange = e => { S.wakeOnStart = e.target.checked; saveSettings(); };
$("#autoReminders").onchange = e => { S.autoReminders = e.target.checked; saveSettings(); };
$("#testVoice").onclick = () => { unlockAudio(); speak("Сумрак, я на связи. Так звучит мой голос.", true); };
$("#testReminder").onclick = () => sendToIOS({ text: "Проверка: Дмитрий Павлов", due: Date.now() + 2 * 60000 });
async function testBrain(fromCard) {
  const out = $("#testOut"); out.textContent = "Проверяю…";
  try {
    const r = await ask([{ role: "user", text: "Ответь одним коротким предложением: ты на связи?" }], null, () => {}, undefined);
    out.textContent = "Работает ✓";
    if (fromCard) { addMsg("ai", (stripActions(r.text) || "На связи.") + " Можешь говорить или писать."); hadKey = true; }
  } catch (e) { out.textContent = explainError(e); if (fromCard) addMsg("ai", explainError(e)); }
  finally { updateStatus(); }
}
$("#testBrain").onclick = () => testBrain(false);

$("#backup").onclick = async () => {
  const data = JSON.stringify({ v: 2, facts, tasks, notes, diary, msgs: msgs.slice(-200) });
  try { await navigator.clipboard.writeText(data); toast("Резервная копия скопирована. Сохрани её в Заметки iPhone."); }
  catch { $("#restoreBox").hidden = false; $("#restoreText").value = data; $("#restoreText").select(); toast("Выдели и скопируй текст вручную."); }
};
$("#restoreBtn").onclick = () => { $("#restoreBox").hidden = !$("#restoreBox").hidden; };
$("#restoreGo").onclick = () => {
  try {
    const d = JSON.parse($("#restoreText").value);
    if (Array.isArray(d.facts)) facts = d.facts; if (Array.isArray(d.tasks)) tasks = d.tasks;
    if (Array.isArray(d.notes)) notes = d.notes; if (Array.isArray(d.msgs)) msgs = d.msgs;
    if (d.diary && typeof d.diary.text === "string") diary = d.diary;
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
  const repeat = due && REPEAT_TXT[$("#newRepeat").value] ? $("#newRepeat").value : null;
  tasks.push({ id: uid(), text, due, repeat, done: false, notified: false, ts: Date.now() }); persist(); render();
  $("#newTask").value = ""; $("#newDue").value = ""; $("#newRepeat").value = "";
});
$("#addNote").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newNote").value.trim(); if (!text) return;
  notes.push({ id: uid(), text, ts: Date.now() }); persist(); render(); $("#newNote").value = "";
});
$("#addFact").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newFact").value.trim(); if (!text) return;
  facts.push({ id: uid(), text, cat: "другое", ts: Date.now() }); persist(); render(); $("#newFact").value = "";
});

/* ---------------- Ввод и вкладки ---------------- */
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !/iPhone|iPad|Android/i.test(navigator.userAgent)) { e.preventDefault(); send($("#input").value); } });
$("#form").addEventListener("submit", e => {
  e.preventDefault(); unlockAudio();
  const v = $("#input").value.trim();
  if (!v && !photo) { if (busy) busy.abort(); else if (speaking) stopSpeaking(); return; }
  send(v);
});
function setTab(t) { document.body.dataset.tab = t; $$(".tabbar button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t))); if (t === "chat") scrollDown(); }
$(".tabbar").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

/* ---------------- Запуск ---------------- */
// Переход со старой версии: у фактов появились категории.
facts.forEach(f => { if (!f.cat) f.cat = "другое"; });
$("#ver").textContent = "Версия " + VERSION;
tickClock(); setInterval(tickClock, 1000);
fillSettings(); render(); renderChat(); setTab("chat");
loadVoices(); try { speechSynthesis.onvoiceschanged = loadVoices; } catch {}
setInterval(checkReminders, 10000); checkReminders();
if (S.wakeOnStart && SR) { wakeOn = true; syncWakeBtn(); startRec("wake"); }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopRec(); } else { checkReminders(); if (wakeOn) resumeWake(); }
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
