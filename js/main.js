/* Дмитрий Павлов 3.0 — сборка интерфейса. */
import { $, $$, uid, esc, md, plural, fmtDue, fmtAgo, isoLocal, hm, dayStart, todayKey, parseLocal, nextDue, pad, REPEAT_TXT, DAYS, MONTHS } from "./util.js";
import { S, D, DEFAULTS, saveSettings, persist, exportAll, importAll, idbAll } from "./store.js";
import { chat, plain, order, anyBrain, configured, BRAINS, explain, discoverGemini, ping, canTranscribe, canTTS, isBlocked, ttsGemini } from "./brains.js";
import { buildPrompt, MODES } from "./prompt.js";
import { relevantFacts, activeFacts, applyActions, stripActions, extractActions, contextStart, updateDiary, reflect, tidyMemory, lessonFromFeedback, ensureFactVecs, dueCards, gradeCard, CATS } from "./memory.js";
import { addDoc, removeDoc, search, fromUrl, fromFile, ensureDocVecs } from "./knowledge.js";
import * as V from "./voice.js";

const VERSION = "3.0.0";
let mode = "auto", deep = false, photo = null, busy = null;

/* =================== Часы и статус =================== */
function tickClock() {
  const d = new Date();
  $("#time").textContent = hm(d);
  $("#date").textContent = DAYS[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()];
}
function status(text, cls) {
  $("#status").textContent = text;
  $("#dot").className = "dot" + (cls ? " " + cls : "");
}
function idleStatus() {
  if (busy) return status("Думаю…", "busy");
  const list = order();
  if (!list.length) return status("Нужно подключить мозг");
  const b = list[0];
  status("На связи · " + BRAINS[b].name + (D.meta.tempChat ? " · инкогнито" : ""), "on");
  syncSendBtn();
}
function syncSendBtn() {
  const stop = !!busy || V.speaking();
  $("#send").classList.toggle("stop", stop);
  $("#send").title = busy ? "Остановить" : V.speaking() ? "Замолчать" : "Отправить";
}
function toast(t, ms) {
  $("#toastText").textContent = t; $("#toast").hidden = false;
  clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => { $("#toast").hidden = true; }, ms);
}
$("#toastOk").onclick = () => { $("#toast").hidden = true; };

/* =================== Режимы =================== */
function renderModes() {
  $("#modes").innerHTML = Object.entries(MODES).map(([k, m]) =>
    `<button type="button" class="chip${mode === k ? " on" : ""}" data-mode="${k}" aria-pressed="${mode === k}">${m.icon} ${m.name}</button>`).join("") +
    `<span class="sep"></span><button type="button" class="chip${deep ? " on" : ""}" data-deep aria-pressed="${deep}" title="Думать дольше и тщательнее">🧠 Глубже</button>` +
    `<button type="button" class="chip${D.meta.tempChat ? " on" : ""}" data-temp aria-pressed="${!!D.meta.tempChat}" title="Разговор не сохраняется в память">🕶 Инкогнито</button>`;
}
$("#modes").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.mode) mode = b.dataset.mode;
  if (b.hasAttribute("data-deep")) deep = !deep;
  if (b.hasAttribute("data-temp")) {
    D.meta.tempChat = !D.meta.tempChat;
    if (!D.meta.tempChat) D.msgs = D.msgs.filter(m => !m.temp);
    persist(); toast(D.meta.tempChat ? "Инкогнито: этот разговор не попадёт в память." : "Инкогнито выключено, разговор стёрт.", 2500);
    if (!D.meta.tempChat) renderChat();
  }
  renderModes(); idleStatus();
});

/* =================== Чат =================== */
const scrollDown = () => { const l = $("#log"); l.scrollTop = l.scrollHeight; };
function addMsg(role, text, extra = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role + (extra.temp ? " temp" : "");
  if (role === "ai") el.innerHTML = `<div class="by">Дмитрий Павлов${extra.brain ? ` <span>· ${esc(BRAINS[extra.brain]?.name || "")}</span>` : ""}</div><div class="body">${md(text)}</div>`;
  else el.textContent = text;
  if (extra.img) { const im = document.createElement("img"); im.src = extra.img; im.alt = "Фото"; im.className = "thumb"; el.prepend(im); }
  else if (extra.photo && role === "me") { const s = document.createElement("div"); s.className = "small"; s.textContent = "📷 фото"; el.prepend(s); }
  if (extra.sources) addSources(el, extra.sources);
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
function pill(text, fn, cls) { const b = document.createElement("button"); b.type = "button"; b.className = "pill" + (cls ? " " + cls : ""); b.textContent = text; b.onclick = fn; return b; }
function addAiTools(el, msg) {
  const box = document.createElement("div"); box.className = "acts";
  const up = pill("👍", () => { msg.rating = 1; persist(); up.classList.add("on"); down.classList.remove("on"); toast("Спасибо — учту, что так хорошо.", 1800); });
  const down = pill("👎", () => { msg.rating = -1; persist(); down.classList.add("on"); up.classList.remove("on"); askWhy(el, msg); });
  up.title = "Хороший ответ"; down.title = "Плохой ответ — научить";
  if (msg.rating === 1) up.classList.add("on"); if (msg.rating === -1) down.classList.add("on");
  box.append(up, down, pill("🔊", () => { V.unlock(); V.speak(msg.text, { force: true, full: true }).finally(syncSendBtn); syncSendBtn(); }),
    pill("Копировать", async e => { try { await navigator.clipboard.writeText(msg.text); e.target.textContent = "Скопировано"; } catch { e.target.textContent = "Не вышло"; } }));
  el.append(box);
}
function askWhy(el, msg) {
  if (el.querySelector(".why")) return;
  const f = document.createElement("form"); f.className = "why add";
  f.innerHTML = `<input placeholder="Что не так? Как надо было?" aria-label="Что не так"><button type="submit">Научить</button>`;
  f.onsubmit = async e => {
    e.preventDefault(); const comment = f.querySelector("input").value.trim();
    const i = D.msgs.indexOf(msg); const q = i > 0 ? D.msgs[i - 1].text : "";
    f.querySelector("button").disabled = true; f.querySelector("button").textContent = "Учусь…";
    try { const l = await lessonFromFeedback(q, msg.text, comment); f.remove(); toast(l ? "📘 Урок усвоен: " + l : "Принял.", 4000); renderKnow(); }
    catch (err) { f.querySelector("button").disabled = false; f.querySelector("button").textContent = "Научить"; toast(explain(err)); }
  };
  el.append(f); f.querySelector("input").focus();
}
function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  return `${g}, Сумрак. Я на связи. Говори или пиши.`;
}
function renderChat() {
  $("#log").innerHTML = "";
  D.msgs.slice(-60).forEach(m => {
    const el = addMsg(m.role === "user" ? "me" : "ai", m.text, m);
    if (m.role === "ai") addAiTools(el, m);
  });
  if (!anyBrain()) return showSetupCard();
  if (S.briefing && D.meta.lastBrief !== todayKey() && !D.meta.tempChat) showBriefing();
  else addMsg("ai", greeting());
}
function showSetupCard() {
  const el = document.createElement("div"); el.className = "msg ai";
  el.innerHTML = `<div class="by">Дмитрий Павлов</div>
    <div class="card">
      <h3>Привет, Сумрак. Подключи мне мозг</h3>
      <p><b>Вариант 1 — Gemini</b> (самый умный, живой голос; нужен включённый VPN). Ключ: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></p>
      <input id="qGemini" type="password" autocomplete="off" placeholder="Ключ Gemini (AIza…)" aria-label="Ключ Gemini">
      <p><b>Вариант 2 — Mistral</b> (работает без VPN). Ключ: <a href="https://console.mistral.ai" target="_blank" rel="noopener">console.mistral.ai</a> → API Keys</p>
      <input id="qMistral" type="password" autocomplete="off" placeholder="Ключ Mistral" aria-label="Ключ Mistral">
      <button type="button" id="qSave">Подключить</button>
      <p class="small">Лучше подключить оба: без VPN я буду работать на Mistral, с VPN — на Gemini. Ключи остаются только на этом телефоне.</p>
    </div>`;
  $("#log").append(el);
  el.querySelector("#qSave").onclick = async () => {
    const g = el.querySelector("#qGemini").value.trim(), m = el.querySelector("#qMistral").value.trim();
    if (!g && !m) return;
    if (g) S.geminiKey = g; if (m) S.mistralKey = m;
    saveSettings(); fillSettings(); el.remove();
    const w = addMsg("ai", "Ключ сохранил. Проверяю связь…");
    const results = [];
    for (const b of configured()) {
      try { const r = await ping(b); results.push(`✅ ${BRAINS[b].name} — работает (${r.model}, ${(r.ms / 1000).toFixed(1)} с)`); }
      catch (e) { results.push(`⚠️ ${BRAINS[b].name}: ${explain(e)}`); }
    }
    w.querySelector(".body").innerHTML = md(results.join("\n") + "\n\nМожешь говорить или писать.");
    idleStatus(); discoverGemini().then(fillGeminiModels).catch(() => {});
  };
}
/* Утренняя сводка — при первом открытии за день. */
function showBriefing() {
  D.meta.lastBrief = todayKey(); persist();
  const now = Date.now(), end = dayStart(new Date()) + 864e5;
  const overdue = D.tasks.filter(t => !t.done && !t.repeat && t.due && t.due < now);
  const today = D.tasks.filter(t => !t.done && t.due && t.due >= now && t.due < end).sort((a, b) => a.due - b.due);
  const cards = dueCards().length;
  const h = new Date().getHours(); const g = h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const lines = [];
  if (today.length) lines.push("**Сегодня:** " + today.slice(0, 5).map(t => `${hm(new Date(t.due))} ${t.text}`).join("; "));
  if (overdue.length) lines.push("**Просрочено:** " + overdue.slice(0, 3).map(t => t.text).join("; "));
  if (cards) lines.push(`**Повторить:** ${plural(cards, "карточку", "карточки", "карточек")}`);
  if (D.core.goals) lines.push("**Твои цели:** " + D.core.goals.slice(0, 160) + (D.core.goals.length > 160 ? "…" : ""));
  const ins = D.insights[D.insights.length - 1]; if (ins) lines.push("**Мысль:** " + ins.text);
  const el = addMsg("ai", `${g}, Сумрак. ${lines.length ? "Коротко о дне:\n" + lines.join("\n") : "Дел на сегодня нет — день свободен. Чем займёмся?"}`);
  const box = document.createElement("div"); box.className = "acts";
  box.append(pill("🗓 Спланировать день", () => send("Помоги спланировать сегодняшний день с учётом моих дел и целей.")));
  if (cards) box.append(pill("🃏 Повторить карточки", startReview));
  el.append(box);
}

/* =================== Отправка =================== */
async function send(text, opts = {}) {
  text = String(text || "").trim();
  const img = opts.retry ? opts.img : (opts.voice ? null : photo);
  if (!text && img) text = "Посмотри на фото и помоги.";
  if (!text) return "";
  if (busy) busy.abort();
  if (!opts.voice) { V.stopSpeaking(); V.stopRecording(true); }
  setTab("chat");
  const temp = !!D.meta.tempChat;
  if (!opts.retry) {
    $("#input").value = ""; autosize();
    if (!opts.voice) { photo = null; showPhoto(); }
    addMsg("me", text, { img: img && img.url, temp });
    D.msgs.push({ role: "user", text, ts: Date.now(), photo: !!img, temp }); persist();
  }
  if (!anyBrain()) { addMsg("sys", "Сначала подключи мозг: вставь ключ во вкладке «Настройки»."); return ""; }
  const el = addMsg("ai", "", { temp }); const body = el.querySelector(".body");
  body.innerHTML = `<span class="thinking">${img ? "Смотрю на фото…" : deep ? "Думаю глубоко…" : "Думаю…"}</span>`;
  const ctl = new AbortController(); busy = ctl; idleStatus(); syncSendBtn();
  const onText = t => { const v = stripActions(t); if (v) { body.innerHTML = md(v); scrollDown(); } };
  try {
    const [facts, knowledge] = await Promise.all([relevantFacts(text).catch(() => activeFacts().slice(-40)), search(text).catch(() => [])]);
    const system = brain => buildPrompt({ mode, query: text, facts, knowledge, voice: !!opts.voice, temp, deep, brain });
    const hist = D.msgs.slice(contextStart(D.msgs)).map(m => ({ role: m.role === "user" ? "user" : "assistant", text: (m.photo && m.role === "user" ? "[прислал фото] " : "") + m.text }));
    const res = await chat({ system, hist, img, onText, signal: ctl.signal, deep });
    const visible = stripActions(res.text) || "Готово.";
    body.innerHTML = md(visible);
    el.querySelector(".by").innerHTML = `Дмитрий Павлов <span>· ${esc(BRAINS[res.brain]?.name || "")}</span>`;
    addSources(el, res.sources);
    const out = applyActions(extractActions(res.text), text, { temp });
    const msg = { role: "ai", text: visible, ts: Date.now(), sources: (res.sources || []).slice(0, 6), brain: res.brain, mode, temp };
    D.msgs.push(msg); persist();
    if (out.newTasks.some(t => t.due)) addTaskButtons(el, out.newTasks.filter(t => t.due));
    addAiTools(el, msg);
    const notes = [];
    if (out.remembered.length) notes.push("🧠 Запомнил: " + out.remembered.join("; "));
    if (out.learned.length) notes.push("📘 Выучил: " + out.learned.join(", "));
    if (out.cards) notes.push("🃏 " + plural(out.cards, "новая карточка", "новые карточки", "новых карточек"));
    if (notes.length) { const n = document.createElement("div"); n.className = "memnote"; n.textContent = notes.join(" · "); el.append(n); }
    renderLists();
    scrollDown();
    busy = null; idleStatus();
    background();
    if (!opts.voice) {
      V.speak(visible).finally(syncSendBtn); syncSendBtn();
      const toIOS = out.newTasks.find(t => t.due);
      if (toIOS && S.autoReminders) setTimeout(() => sendToIOS(toIOS), 600);
    }
    return visible;
  } catch (e) {
    if (e.name === "AbortError") { body.innerHTML = `<span class="thinking">Остановлено.</span>`; return ""; }
    const m = explain(e);
    body.innerHTML = `<span class="thinking">${esc(m)}</span>`;
    const box = document.createElement("div"); box.className = "acts";
    box.append(pill("↻ Повторить", () => { el.remove(); send(text, { retry: true, img, voice: opts.voice }); }));
    el.append(box);
    if (opts.voice) throw Object.assign(new Error(m), { spoken: m });
    return "";
  } finally {
    if (busy === ctl) busy = null;
    idleStatus();
  }
}
function addTaskButtons(el, list) {
  const box = document.createElement("div"); box.className = "acts";
  list.forEach(t => {
    box.append(pill("⏰ В Напоминания iPhone: " + fmtDue(t.due), () => sendToIOS(t)));
    box.append(pill("📅 В Календарь", () => addToCalendar(t)));
  });
  el.append(box);
}

/* Фоновая работа памяти: по одному шагу, без спешки. */
let bg = false;
async function background() {
  if (bg) return; bg = true;
  try {
    await updateDiary().catch(() => {});
    if (await reflect().catch(() => false)) renderMem();
    if (activeFacts().length > 80 && Date.now() - (D.meta.lastTidy || 0) > 3 * 864e5) { await tidyMemory().catch(() => {}); renderMem(); }
    await ensureFactVecs(); await ensureDocVecs();
  } finally { bg = false; }
}

/* =================== Фото =================== */
$("#photoBtn").onclick = () => $("#photo").click();
$("#photo").onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  try { photo = await shrinkImage(f); showPhoto(); } catch { toast("Не получилось открыть фото."); }
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
function showPhoto() { $("#photoPrev").hidden = !photo; if (photo) $("#photoImg").src = photo.url; }
$("#photoDel").onclick = () => { photo = null; showPhoto(); };

/* =================== Голос: одна фраза =================== */
const MIC_DENIED = "Нет доступа к микрофону. Нажми «Разрешить», когда iPhone спросит. Если не спрашивает: Настройки iPhone → Safari → Микрофон → «Спрашивать» или «Разрешить».";
const NO_STT = "Чтобы я понимал голос, нужен Gemini (с VPN) или Mistral. Пока можно диктовать с клавиатуры iPhone (значок микрофона на клавиатуре).";
function voiceErr(e) {
  const m = String(e && e.message);
  if (m === "mic-denied") return MIC_DENIED;
  if (m === "no-stt") return NO_STT;
  if (m === "no-mic" || m === "mic-failed") return "Микрофон недоступен. Попробуй диктовку с клавиатуры iPhone.";
  return explain(e);
}
function showHint(t) { $("#hint").textContent = t || ""; $("#hint").hidden = !t; }
$("#mic").onclick = async () => {
  V.unlock();
  if (V.isRecording()) { V.stopRecording(); return; }
  V.stopSpeaking(); syncSendBtn();
  $("#mic").classList.add("live"); status("Слушаю…", "listen"); showHint("");
  try {
    const text = await V.listen({ onInterim: t => { $("#input").value = t; autosize(); }, onTranscribing: () => status("Распознаю…", "busy") });
    $("#mic").classList.remove("live"); idleStatus();
    if (text) send(text); else showHint("Не расслышал. Нажми 🎤 и скажи ещё раз.");
  } catch (e) { $("#mic").classList.remove("live"); idleStatus(); showHint(voiceErr(e)); }
};

/* =================== Голос: разговор =================== */
let talkOn = false, talkPhase = "idle";
function talkSet(phase, text) {
  talkPhase = phase;
  $("#talkView").dataset.phase = phase;
  $("#talkState").textContent = text || { listening: "Слушаю…", thinking: "Думаю…", speaking: "Говорю… (нажми, чтобы перебить)", idle: "Нажми на круг и говори", transcribing: "Распознаю…" }[phase];
}
function orbLevel(v) { $("#orbRing").style.transform = `scale(${1 + v * 0.45})`; }
$("#talk").onclick = () => { V.unlock(); openTalk(); };
function openTalk() {
  if (!anyBrain()) { toast("Сначала подключи мозг в «Настройках»."); return; }
  talkOn = true; $("#talkView").hidden = false; $("#talkText").textContent = "";
  $("#talkBrain").textContent = (order()[0] ? BRAINS[order()[0]].name : "") + (V.liveAvailable() ? " · живой голос" : " · голос iPhone");
  talkLoop();
}
function closeTalk() {
  talkOn = false; $("#talkView").hidden = true;
  V.stopRecording(true); V.stopSpeaking(); if (busy) busy.abort(); idleStatus();
}
$("#talkClose").onclick = closeTalk;
$("#orb").onclick = () => {
  V.unlock();
  if (talkPhase === "speaking") { V.stopSpeaking(); return; }                  // перебить
  if (talkPhase === "listening") { V.stopRecording(); return; }                // закончил говорить
  if (talkPhase === "thinking" && busy) { busy.abort(); return; }
  if (talkPhase === "idle") talkLoop();
};
async function talkLoop() {
  let empties = 0;
  while (talkOn) {
    talkSet("listening"); orbLevel(0);
    let text = "";
    try { text = await V.listen({ onLevel: orbLevel, onTranscribing: () => talkSet("transcribing"), onInterim: t => { $("#talkText").textContent = t; } }); }
    catch (e) { talkSet("idle", voiceErr(e)); return; }
    orbLevel(0);
    if (!talkOn) return;
    if (!text) {
      if (++empties >= 2 || !S.handsFree) { talkSet("idle"); return; }
      continue;
    }
    empties = 0;
    $("#talkText").textContent = "«" + text + "»";
    if (/^(стоп|хватит|пока|выход|заверши|всё,? спасибо|отбой)[.!]?$/i.test(text.trim())) {
      talkSet("speaking"); await V.speak("До связи, Сумрак.", { force: true }); closeTalk(); return;
    }
    talkSet("thinking");
    let reply = "";
    try { reply = await send(text, { voice: true }); }
    catch (e) { reply = e.spoken || explain(e); }
    if (!talkOn) return;
    if (!reply) { talkSet("idle"); return; }
    $("#talkText").textContent = reply.length > 400 ? reply.slice(0, 400) + "…" : reply;
    talkSet("speaking");
    await V.speak(reply, { force: true });
    if (!talkOn) return;
    if (!S.handsFree) { talkSet("idle"); return; }
  }
}

/* =================== Карточки =================== */
let review = null;
function startReview() {
  const q = dueCards();
  if (!q.length) { toast("Сейчас нечего повторять. Следующие карточки — по расписанию.", 3000); return; }
  review = { q, i: 0 }; setTab("chat"); nextCard();
}
function nextCard() {
  if (!review || review.i >= review.q.length) { addMsg("ai", "Повторение закончено. Молодец, Сумрак."); review = null; renderKnow(); return; }
  const c = review.q[review.i];
  const el = addMsg("ai", `**Карточка ${review.i + 1} из ${review.q.length}**${c.topic ? " · " + c.topic : ""}\n${c.q}`);
  const box = document.createElement("div"); box.className = "acts";
  box.append(pill("Показать ответ", () => {
    box.remove();
    const a = document.createElement("div"); a.className = "body answer"; a.innerHTML = md(c.a); el.append(a);
    const g = document.createElement("div"); g.className = "acts";
    [["Снова", 0], ["Трудно", 1], ["Хорошо", 2], ["Легко", 3]].forEach(([t, v]) => g.append(pill(t, () => { gradeCard(c, v); g.remove(); review.i++; nextCard(); })));
    el.append(g); scrollDown();
  }));
  el.append(box); scrollDown();
}
$("#reviewBtn").onclick = startReview;

/* =================== Напоминания =================== */
const SHORTCUT = "ДП Напоминание";
function sendToIOS(t) {
  location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT) + "&input=text&text=" + encodeURIComponent(JSON.stringify({ title: t.text, due: isoLocal(t.due) }));
}
function addToCalendar(t) {
  const d = new Date(t.due), e = new Date(t.due + 15 * 6e4);
  const f = x => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  const rr = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" }[t.repeat];
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DmitriyPavlov//RU", "BEGIN:VEVENT", `UID:${t.id}@dmitriy-pavlov`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(d)}`, `DTEND:${f(e)}`,
    `SUMMARY:${t.text.replace(/[,;\\]/g, " ")}`, ...(rr ? ["RRULE:" + rr] : []), "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Напоминание", "TRIGGER:PT0M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "napominanie.ics"; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}
function checkReminders() {
  const now = Date.now(); let changed = false;
  D.tasks.filter(t => !t.done && !t.notified && t.due && t.due <= now).forEach(t => {
    changed = true;
    if (now - t.due < 864e5) {
      const msg = "Сумрак, напоминаю: " + t.text;
      toast("⏰ " + t.text); V.beep(); addMsg("ai", msg); V.speak(msg, { force: true });
    }
    if (t.repeat) { t.due = nextDue(t.due, t.repeat); t.notified = false; } else t.notified = true;
  });
  if (changed) { persist(); renderTasks(); }
}

/* =================== Списки =================== */
function emptyAfter(sel, n, text) {
  const ul = $(sel); let p = ul.nextElementSibling;
  if (!p || !p.classList.contains("empty")) { p = document.createElement("p"); p.className = "empty"; ul.after(p); }
  p.textContent = text; p.hidden = n > 0;
}
function renderTasks() {
  const ts = D.tasks.slice().sort((a, b) => (a.done - b.done) || ((a.due ?? 9e15) - (b.due ?? 9e15)) || (a.ts - b.ts));
  const open = ts.filter(t => !t.done).length;
  $("#tstat").textContent = open ? open + " откр." : ""; $("#tcount").textContent = open ? "·" + open : "";
  $("#tasks").innerHTML = ts.map(t => `<li class="row${t.done ? " done" : ""}">
      <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Готово">
      <div class="tx">${esc(t.text)}${t.due ? `<span class="due${!t.done && t.due < Date.now() ? " over" : ""}">${fmtDue(t.due)}${t.repeat ? " · " + REPEAT_TXT[t.repeat] : ""}</span>` : ""}</div>
      <div class="btns">${t.due && !t.done ? `<button class="x" data-ios="${t.id}" title="В Напоминания iPhone">⏰</button>` : ""}<button class="x" data-del="tasks:${t.id}" aria-label="Удалить">×</button></div></li>`).join("");
  emptyAfter("#tasks", ts.length, "Дел нет. Скажи, например: «напомни завтра в 9 позвонить маме» или «каждый день в 8 напоминай пить воду».");
  const ns = D.notes.slice().sort((a, b) => b.ts - a.ts);
  $("#nstat").textContent = ns.length || "";
  $("#notes").innerHTML = ns.map(n => `<li class="row nocheck"><div class="tx">${esc(n.text)}<span class="due">${fmtDue(n.ts)}</span></div><button class="x" data-del="notes:${n.id}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#notes", ns.length, "Пока пусто. Скажи «запиши заметку…» или впиши выше.");
}
function renderKnow() {
  $("#dstat").textContent = D.docs.length || "";
  $("#docs").innerHTML = D.docs.slice().reverse().map(d => `<li class="row nocheck"><div class="tx"><b>${esc(d.title)}</b><span class="due">${esc(d.kind)} · ${plural(d.chunks, "фрагмент", "фрагмента", "фрагментов")} · ${fmtAgo(d.ts)}${d.vec ? " · поиск по смыслу" : ""}</span></div><button class="x" data-deldoc="${d.id}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#docs", D.docs.length, "Пока ничего. Дай мне текст, ссылку или документ — изучу.");
  const due = dueCards().length;
  $("#cstat").textContent = D.cards.length ? `${due} к повтору из ${D.cards.length}` : "";
  $("#kcount").textContent = due ? "·" + due : "";
  $("#reviewBtn").textContent = due ? "Повторить " + plural(due, "карточку", "карточки", "карточек") : "Нечего повторять";
  $("#reviewBtn").disabled = !due;
  $("#sstat").textContent = D.skills.length || "";
  $("#skills").innerHTML = D.skills.map(s => `<li class="row nocheck"><div class="tx"><details><summary><b>${esc(s.name)}</b> — ${esc(s.desc)}</summary><div class="small pre">${s.trigger ? "Когда: " + esc(s.trigger) + "\n" : ""}${esc(s.steps)}</div></details><span class="due">применён ${plural(s.uses || 0, "раз", "раза", "раз")}</span></div><button class="x" data-del="skills:${s.id}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#skills", D.skills.length, "Пока нет навыков.");
  $("#lstat").textContent = D.lessons.length || "";
  $("#lessons").innerHTML = D.lessons.map(l => `<li class="row nocheck"><div class="tx">${esc(l.text)}</div><button class="x" data-del="lessons:${l.id}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#lessons", D.lessons.length, "Пока нет. Ставь 👎 под неудачными ответами — я сделаю выводы.");
}
function renderMem() {
  $("#cProfile").value = D.core.profile || ""; $("#cGoals").value = D.core.goals || ""; $("#cPeople").value = D.core.people || ""; $("#cPrefs").value = D.core.preferences || "";
  $("#insights").innerHTML = D.insights.slice().reverse().map(i => `<li class="row nocheck"><div class="tx">${esc(i.text)}</div><button class="x" data-del="insights:${i.id}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#insights", D.insights.length, "Выводы появятся, когда я узнаю тебя получше (обновляю раз в день).");
  const facts = activeFacts();
  $("#mstat").textContent = facts.length || "";
  $("#facts").innerHTML = CATS.map(c => [c, facts.filter(f => f.cat === c).sort((a, b) => (b.imp || 5) - (a.imp || 5))]).filter(g => g[1].length)
    .map(([c, list]) => `<li class="grp">${esc(c)}</li>` + list.map(f => `<li class="row nocheck"><div class="tx">${esc(f.text)}<span class="due">${"●".repeat(Math.round((f.imp || 5) / 2))}${"○".repeat(5 - Math.round((f.imp || 5) / 2))} · ${fmtAgo(f.ts)}</span></div><button class="x" data-forget="${f.id}" aria-label="Забыть">×</button></li>`).join("")).join("");
  emptyAfter("#facts", facts.length, "Пока ничего. Просто разговаривай со мной — я буду запоминать важное.");
  $("#diary").textContent = D.diary.text || "Пока пусто. Когда разговоров станет больше, здесь появится краткая история: о чём мы говорили и что решили.";
}
function renderLists() { renderTasks(); renderKnow(); renderMem(); }

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-del],[data-ios],[data-forget],[data-deldoc]"); if (!t) return;
  if (t.dataset.del) { const [k, id] = t.dataset.del.split(":"); D[k] = D[k].filter(x => x.id !== id); }
  if (t.dataset.forget) { const f = D.facts.find(x => x.id === t.dataset.forget); if (f) { f.status = "old"; f.validTo = Date.now(); } }
  if (t.dataset.ios) { const task = D.tasks.find(x => x.id === t.dataset.ios); if (task) sendToIOS(task); return; }
  if (t.dataset.deldoc) { await removeDoc(t.dataset.deldoc); }
  persist(); renderLists();
});
document.addEventListener("change", e => {
  const id = e.target.dataset && e.target.dataset.done; if (!id) return;
  const t = D.tasks.find(x => x.id === id); if (t) { t.done = e.target.checked; persist(); renderTasks(); }
});
$("#addTask").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newTask").value.trim(); if (!text) return;
  const due = $("#newDue").value ? parseLocal($("#newDue").value) : null;
  const repeat = due && REPEAT_TXT[$("#newRepeat").value] ? $("#newRepeat").value : null;
  D.tasks.push({ id: uid(), text, due, repeat, done: false, notified: false, ts: Date.now() }); persist(); renderTasks();
  $("#newTask").value = ""; $("#newDue").value = ""; $("#newRepeat").value = "";
});
$("#addNote").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newNote").value.trim(); if (!text) return;
  D.notes.push({ id: uid(), text, ts: Date.now() }); persist(); renderTasks(); $("#newNote").value = "";
});
$("#addFact").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newFact").value.trim(); if (!text) return;
  D.facts.push({ id: uid(), text, cat: "другое", imp: 7, ts: Date.now(), used: Date.now(), status: "active", pinned: true }); persist(); renderMem(); $("#newFact").value = "";
});
$("#saveCore").onclick = () => {
  D.core = { profile: $("#cProfile").value.trim(), goals: $("#cGoals").value.trim(), people: $("#cPeople").value.trim(), preferences: $("#cPrefs").value.trim() };
  persist(); toast("Профиль сохранён.", 1800);
};
async function busyBtn(btn, label, fn) {
  if (!anyBrain()) { toast("Сначала подключи мозг в «Настройках»."); return; }
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (err) { toast(explain(err)); } finally { btn.disabled = false; btn.textContent = old; }
}
$("#reflectNow").onclick = e => busyBtn(e.target, "Думаю…", async () => { const ok = await reflect(true); renderMem(); toast(ok ? "Профиль и выводы обновлены." : "Пока мало данных — поговорим ещё.", 2500); });
$("#tidy").onclick = e => busyBtn(e.target, "Навожу порядок…", async () => { const r = await tidyMemory(); renderMem(); toast(r.ok ? "Готово: в памяти " + plural(r.n, "факт", "факта", "фактов") + "." : "Пока нечего упорядочивать.", 2500); });

/* =================== Научить =================== */
let teachKind = "text";
$("#teachSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  teachKind = b.dataset.k;
  $$("#teachSeg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("#tText").hidden = teachKind !== "text"; $("#tUrl").hidden = teachKind !== "url"; $("#tFile").hidden = teachKind !== "file";
});
$("#teachForm").addEventListener("submit", async e => {
  e.preventDefault();
  const out = $("#tOut"), btn = $("#tGo"); btn.disabled = true; out.textContent = "Изучаю…";
  try {
    let title = $("#tTitle").value.trim(), text = "", kind = "текст";
    if (teachKind === "text") { text = $("#tText").value; title = title || text.trim().split("\n")[0].slice(0, 60); }
    if (teachKind === "url") { const u = $("#tUrl").value.trim(); if (!/^https?:\/\//.test(u)) throw new Error("Вставь ссылку, начинающуюся с https://"); const r = await fromUrl(u); text = r.text; title = title || r.title; kind = "ссылка"; }
    if (teachKind === "file") { const f = $("#tFile").files[0]; if (!f) throw new Error("Выбери файл."); const r = await fromFile(f); text = r.text; title = title || r.title; kind = /pdf/i.test(f.type + f.name) ? "PDF" : /image/.test(f.type) ? "фото" : "файл"; }
    const d = await addDoc(title || "Без названия", text, kind);
    out.textContent = `Изучил «${d.title}»: ${plural(d.chunks, "фрагмент", "фрагмента", "фрагментов")}.`;
    $("#tTitle").value = ""; $("#tText").value = ""; $("#tUrl").value = ""; $("#tFile").value = "";
    renderKnow();
  } catch (err) { out.textContent = err.status ? explain(err) : err.message; }
  finally { btn.disabled = false; }
});

/* =================== Настройки =================== */
const TEXT_KEYS = ["geminiKey", "mistralKey", "zaiKey", "claudeKey", "claudeModel", "customBase", "customKey", "customModel", "tavilyKey"];
const SELECT_KEYS = ["brain", "geminiModel", "mistralModel", "voiceMode", "liveVoice", "iosVoice", "sttMode"];
const CHECK_KEYS = ["speakOn", "handsFree", "briefing", "autoReminders"];
function fillGeminiModels() {
  const m = D.meta.models; const sel = $("#geminiModel");
  const ids = m ? [...new Set([...(m.chat || []), ...(m.deep || []), ...(m.lite || [])])] : [];
  sel.innerHTML = `<option value="auto">Автоматически — лучшая из доступных${m && m.chat && m.chat[0] ? " (" + esc(m.chat[0]) + ")" : ""}</option>` + ids.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
  sel.value = ids.includes(S.geminiModel) ? S.geminiModel : "auto";
}
function fillVoices() {
  $("#liveVoice").innerHTML = V.liveVoices().map(v => `<option>${v}</option>`).join(""); $("#liveVoice").value = S.liveVoice;
  const vs = V.loadIOSVoices();
  $("#iosVoice").innerHTML = `<option value="">Автоматически (мужской, если есть)</option>` + vs.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join("");
  $("#iosVoice").value = vs.some(v => v.voiceURI === S.iosVoice) ? S.iosVoice : "";
}
function fillSettings() {
  TEXT_KEYS.forEach(k => { $("#" + k).value = S[k] || ""; });
  SELECT_KEYS.forEach(k => { const el = $("#" + k); if ([...el.options].some(o => o.value === S[k])) el.value = S[k]; });
  CHECK_KEYS.forEach(k => { $("#" + k).checked = !!S[k]; });
  $("#rate").value = S.rate; $("#rateVal").textContent = "×" + (+S.rate).toFixed(2);
  $$("[data-ok]").forEach(s => { s.textContent = S[s.dataset.ok] ? "✓" : ""; });
  const list = order();
  $("#brainNow").textContent = list.length ? "Сейчас отвечает: " + BRAINS[list[0]].name + (list.length > 1 ? ". Запасные: " + list.slice(1).map(b => BRAINS[b].name).join(", ") + "." : ". Подключи ещё один — будет запасной.") : "Ни одна нейросеть не подключена.";
  idleStatus();
}
TEXT_KEYS.forEach(k => $("#" + k).addEventListener("change", e => {
  S[k] = e.target.value.trim(); saveSettings(); fillSettings();
  if (k === "geminiKey" && S.geminiKey) discoverGemini(true).then(fillGeminiModels).catch(err => toast(explain(err)));
}));
SELECT_KEYS.forEach(k => $("#" + k).addEventListener("change", e => { S[k] = e.target.value; saveSettings(); fillSettings(); }));
CHECK_KEYS.forEach(k => $("#" + k).addEventListener("change", e => { S[k] = e.target.checked; saveSettings(); if (k === "speakOn" && !S.speakOn) V.stopSpeaking(); }));
$("#rate").oninput = e => { S.rate = +e.target.value; $("#rateVal").textContent = "×" + S.rate.toFixed(2); saveSettings(); };
$("#testVoice").onclick = () => { V.unlock(); V.speak("Сумрак, я на связи. Так звучит мой голос.", { force: true }).finally(syncSendBtn); syncSendBtn(); };
$("#testReminder").onclick = () => sendToIOS({ text: "Проверка: Дмитрий Павлов", due: Date.now() + 2 * 6e4 });

/* =================== Проверка системы =================== */
let diagReport = "";
$("#diagBtn").onclick = async e => {
  const btn = e.target; btn.disabled = true; btn.textContent = "Проверяю…";
  const rows = []; const add = (ok, name, info) => { rows.push({ ok, name, info }); draw(); };
  const draw = () => { $("#diag").innerHTML = rows.map(r => `<li class="row nocheck"><div class="tx">${r.ok === true ? "✅" : r.ok === false ? "❌" : "⚠️"} <b>${esc(r.name)}</b><span class="due">${esc(r.info || "")}</span></div></li>`).join(""); };
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const ios = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || []).slice(1).join(".");
  add(true, "Устройство", `${ios ? "iOS " + ios : navigator.platform} · ${standalone ? "приложение с экрана «Домой»" : "в браузере"} · версия ${VERSION}`);
  try { const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; await idbAll("chunks"); add(true, "Память телефона", `сохранено: ${D.msgs.length} сообщ., ${activeFacts().length} фактов, ${D.docs.length} материалов${p === false ? " · iOS может очистить данные — делай копии" : ""}`); }
  catch (err) { add(false, "Память телефона", String(err.message || err)); }
  if (!configured().length) add(false, "Нейросеть", "не подключена — вставь ключ выше");
  for (const b of configured()) {
    try { const r = await ping(b); add(true, BRAINS[b].name, `работает · ${r.model} · ${(r.ms / 1000).toFixed(1)} с`); }
    catch (err) { add(false, BRAINS[b].name, explain(err)); }
  }
  if (configured().includes("gemini")) {
    try { const m = await discoverGemini(true); add(true, "Модели Gemini", `ответы: ${m.chat[0] || "—"}; глубже: ${m.deep[0] || "—"}; голос: ${m.tts[0] || "—"}; поиск по смыслу: ${m.embed[0] || "—"}`); fillGeminiModels(); }
    catch (err) { add(false, "Модели Gemini", explain(err)); }
  }
  if (V.canRecord()) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); add(true, "Микрофон", "доступ есть"); }
    catch (err) { add(false, "Микрофон", err.name === "NotAllowedError" ? "доступ запрещён — разреши в настройках iPhone (Safari → Микрофон)" : String(err.message || err)); }
  } else add(false, "Микрофон", "запись звука не поддерживается");
  add(canTranscribe() ? true : V.SR ? null : false, "Распознавание речи", canTranscribe() ? "нейросетью (" + (configured().includes("gemini") && !isBlocked("gemini") ? "Gemini" : "Mistral") + ")" : V.SR ? "только встроенное iOS — в приложении с экрана «Домой» может не работать; подключи Gemini или Mistral" : "недоступно — подключи Gemini или Mistral");
  if (canTTS()) {
    try { await ttsGemini("Проверка.", S.liveVoice); add(true, "Живой голос", "работает · " + S.liveVoice); }
    catch (err) { add(false, "Живой голос", explain(err) + " — буду говорить голосом iPhone"); }
  } else add(null, "Живой голос", "нужен Gemini (с VPN); сейчас — голос iPhone");
  const vs = V.loadIOSVoices(); add(vs.length ? true : null, "Голос iPhone", vs.length ? vs.map(v => v.name).join(", ") : "русских голосов не найдено — скачай «Юрий» в настройках iPhone");
  diagReport = "Дмитрий Павлов — проверка " + new Date().toLocaleString("ru-RU") + "\n" + rows.map(r => `${r.ok === true ? "OK" : r.ok === false ? "ОШИБКА" : "внимание"} | ${r.name}: ${r.info}`).join("\n");
  $("#diagCopy").hidden = false; btn.disabled = false; btn.textContent = "Проверить ещё раз";
};
$("#diagCopy").onclick = async () => { try { await navigator.clipboard.writeText(diagReport); toast("Отчёт скопирован — пришли его Claude, если нужна помощь.", 3000); } catch { toast(diagReport); } };

/* =================== Данные =================== */
$("#backup").onclick = async () => {
  const json = JSON.stringify(exportAll());
  const name = "dmitriy-backup-" + todayKey() + ".json";
  try {
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Копия Дмитрия" }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(json); toast("Копия скопирована. Сохрани её в Заметки iPhone.", 3500); }
  catch { $("#restoreBox").hidden = false; $("#restoreText").value = json; $("#restoreText").select(); toast("Выдели и скопируй текст вручную."); }
};
$("#restoreBtn").onclick = () => { $("#restoreBox").hidden = !$("#restoreBox").hidden; };
function restoreFrom(text) {
  try { importAll(JSON.parse(text)); renderLists(); renderChat(); toast("Восстановлено.", 2000); $("#restoreBox").hidden = true; }
  catch { toast("Не получилось: копия повреждена."); }
}
$("#restoreGo").onclick = () => restoreFrom($("#restoreText").value);
$("#restoreFile").onchange = async e => { const f = e.target.files[0]; if (f) restoreFrom(await f.text()); e.target.value = ""; };
let clearArmed = false;
$("#clearChat").onclick = e => {
  if (!clearArmed) { clearArmed = true; e.target.textContent = "Точно очистить?"; setTimeout(() => { clearArmed = false; e.target.textContent = "Очистить переписку"; }, 4000); return; }
  D.msgs = []; persist(); renderChat(); e.target.textContent = "Очистить переписку"; clearArmed = false;
};

/* =================== Ввод и вкладки =================== */
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !/iPhone|iPad|Android/i.test(navigator.userAgent)) { e.preventDefault(); send($("#input").value); } });
$("#form").addEventListener("submit", e => {
  e.preventDefault(); V.unlock();
  const v = $("#input").value.trim();
  if (!v && !photo) { if (busy) busy.abort(); else if (V.speaking()) { V.stopSpeaking(); syncSendBtn(); } return; }
  send(v);
});
function setTab(t) { document.body.dataset.tab = t; $$(".tabbar button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t))); if (t === "chat") scrollDown(); }
$(".tabbar").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
document.addEventListener("touchend", V.unlock, { once: true });
document.addEventListener("click", V.unlock, { once: true });

/* =================== Запуск =================== */
$("#ver").textContent = "версия " + VERSION;
tickClock(); setInterval(tickClock, 1000);
renderModes(); fillSettings(); fillGeminiModels(); fillVoices(); renderLists(); renderChat(); setTab("chat");
try { speechSynthesis.onvoiceschanged = fillVoices; } catch {}
V.onSpeakingChange(syncSendBtn);
setInterval(() => { checkReminders(); syncSendBtn(); }, 10000); checkReminders();
if (S.geminiKey) discoverGemini().then(fillGeminiModels).catch(() => {});
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); else if (!talkOn) V.stopRecording(true); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.__dp = { D, S, send };   // для отладки
