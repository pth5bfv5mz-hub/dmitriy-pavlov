/* Сумрак 3.0 — сборка интерфейса. */
import { $, $$, uid, esc, md, plural, fmtDue, fmtAgo, isoLocal, hm, dayStart, todayKey, parseLocal, nextDue, pad, REPEAT_TXT, DAYS, MONTHS } from "./util.js";
import { S, D, saveSettings, persist, exportAll, importAll, idbAll, setQuotaHandler, dataVersion } from "./store.js";
import { chat, plain, order, anyBrain, configured, BRAINS, explain, discoverGemini, ping, canTranscribe, canTTS, isBlocked, ttsGemini, discoverOpenRouter, isKeyErr } from "./brains.js";
// Признаки «не знаю свежего» в ответе модели без поиска
const NOKNOW_RE = /(нет|не имею) (доступа|возможности)[^.]{0,30}(интернет|актуальн|свеж|реальн|текущ)|не могу (проверить|знать|посмотреть|найти)[^.]{0,25}(интернет|актуальн|текущ|сейчас|сегодня)|на момент (моего )?(обучения|последнего обновления)|(у меня )?нет (актуальн|свеж)[а-я]* (данных|информации|сведений)|не располагаю (актуальн|свеж)|мои (данные|знания) (ограничены|заканчиваются)|рекомендую (проверить|уточнить) на (официальн|сайт)/i;
import { buildPrompt } from "./prompt.js";
import { relevantFacts, activeFacts, applyActions, stripActions, extractActions, contextStart, updateDiary, reflect, tidyMemory, lessonFromFeedback, completeTask, advanceTask, selfCheck, selfReview, openMistakes, ensureFactVecs, dueCards, gradeCard, CATS } from "./memory.js";
import { addDoc, removeDoc, search, fromUrl, fromFile, ensureDocVecs, docsForPrompt, docFull, deepPass } from "./knowledge.js";
import { extractFiles, makeFile, shareFile, fileName, FORMATS } from "./files.js";
import * as V from "./voice.js";

const VERSION = "4.0.0";
let photo = null, busy = null, lastFail = "";

/* =================== Статус и проект =================== */
const curProject = () => D.projects.find(p => p.id === D.meta.currentProject) || null;
function renderProject() {
  const p = curProject();
  $("#projName").textContent = p ? p.name : "Без проекта";
  $("#projChip").classList.toggle("on", !!p);
}
function status(text, cls) {
  $("#status").textContent = text;
  $("#dot").className = "dot" + (cls ? " " + cls : "");
}
function idleStatus() {
  if (busy) return status("Думаю…", "busy");
  const list = order();
  if (!list.length) return status("Нужно подключить нейросеть");
  const b = list[0];
  // Последний ответ не удался — не делаем вид, что всё в порядке (до следующего удачного ответа)
  if (lastFail) return status(lastFail + (D.meta.tempChat ? " · инкогнито" : ""), "warn"), syncSendBtn();
  status("Готов" + (D.meta.tempChat ? " · инкогнито" : ""), "on");
  syncSendBtn();
}
function syncSendBtn() {
  const stop = !!busy || V.speaking();
  $("#send").classList.toggle("stop", stop);
  $("#send").title = busy ? "Остановить" : V.speaking() ? "Замолчать" : "Отправить";
  $("#send").setAttribute("aria-label", $("#send").title);
  // Пока ответ пишется, экранный диктор ждёт и читает готовое сообщение, а не каждый кусок
  $("#log").setAttribute("aria-busy", String(!!busy));
}
function toast(t, ms) {
  if (toastUndo) { toastUndo = null; $("#toastOk").textContent = "Понял"; }
  $("#toastText").textContent = t; $("#toast").hidden = false;
  clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => { $("#toast").hidden = true; }, ms);
}
$("#toastOk").onclick = () => { $("#toast").hidden = true; const u = toastUndo; toastUndo = null; $("#toastOk").textContent = "Понял"; if (u) u(); };
/* Удалено — 6 секунд можно вернуть. */
let toastUndo = null;
function undoable(text, undo) {
  toast(text, 6000); toastUndo = undo; $("#toastOk").textContent = "Вернуть";
  clearTimeout(undoable.t); undoable.t = setTimeout(() => { toastUndo = null; $("#toastOk").textContent = "Понял"; }, 6000);
}

/* =================== Чат =================== */
const scrollDown = () => { const l = $("#log"); l.scrollTop = l.scrollHeight; };
/* Показать ответ: короткий — прокрутить вниз; длинный (выше экрана) — держать его начало вверху,
   чтобы читать с первой строки, а не искать её. Если Дмитрий Павлович сам листает — не мешаем. */
let userScrolled = false;
function showReply(el) {
  if (userScrolled) return;
  const l = $("#log");
  if (el.offsetHeight > l.clientHeight - 40) l.scrollTop += el.getBoundingClientRect().top - l.getBoundingClientRect().top - 8;
  else scrollDown();
}
function addMsg(role, text, extra = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role + (extra.temp ? " temp" : "");
  // Без подписи над каждым ответом — кто отвечал (нейросеть), видно в меню «⋯»
  if (role === "ai") { el.innerHTML = `<div class="by"></div><div class="body">${md(text)}</div>`; if (extra.brain) el.dataset.who = BRAINS[extra.brain]?.name || ""; }
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
  sources.filter(s => /^https?:\/\//i.test(String(s.url || ""))).slice(0, 6).forEach(s => {
    const a = document.createElement("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener";
    let host = s.title || ""; try { host = host || new URL(s.url).hostname.replace(/^www\./, ""); } catch {}
    a.textContent = host || "источник"; box.append(a);
  });
  el.append(box);
}
function pill(text, fn, cls) { const b = document.createElement("button"); b.type = "button"; b.className = "pill" + (cls ? " " + cls : ""); b.textContent = text; b.onclick = fn; return b; }
/* Под ответом — ничего лишнего: действия в меню «⋯» (или долгое нажатие на сообщение). */
function addAiTools(el, msg) {
  const b = document.createElement("button"); b.type = "button"; b.className = "more"; b.setAttribute("aria-label", "Действия с сообщением"); b.textContent = "⋯";
  b.onclick = () => openMsgMenu(el, msg);
  el.querySelector(".by").append(b);
  let t = 0;
  el.addEventListener("touchstart", () => { t = setTimeout(() => openMsgMenu(el, msg), 550); }, { passive: true });
  ["touchend", "touchmove", "touchcancel"].forEach(ev => el.addEventListener(ev, () => clearTimeout(t), { passive: true }));
}
function openSheet(id) { $("#sheetBack").hidden = false; $(id).hidden = false; }
function closeSheets() { $("#sheetBack").hidden = true; $("#msgMenu").hidden = true; $("#projSheet").hidden = true; }
$("#sheetBack").onclick = closeSheets;
function openMsgMenu(el, msg) {
  const m = $("#msgMenu"); m.innerHTML = el.dataset.who ? `<div class="who">Ответил: ${esc(el.dataset.who)}</div>` : "";
  const item = (t, fn) => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = t; b.onclick = () => { closeSheets(); fn(); }; m.append(b); };
  item("🔊 Озвучить", () => { V.unlock(); V.speak(msg.text, { force: true, full: true }).finally(syncSendBtn); syncSendBtn(); });
  item("📋 Копировать", async () => { try { await navigator.clipboard.writeText(msg.text); toast("Скопировано.", 1500); } catch { toast("Не получилось скопировать."); } });
  item(msg.rating === 1 ? "👍 Хороший ответ ✓" : "👍 Хороший ответ", () => { msg.rating = 1; persist(); toast("Учту, что так хорошо.", 1800); });
  item("👎 Плохо — научить", () => { msg.rating = -1; persist(); askWhy(el, msg); });
  openSheet("#msgMenu"); m.querySelector("button").focus();
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
  setTimeout(() => f.scrollIntoView({ block: "nearest", behavior: "smooth" }), 300);   // после появления клавиатуры
}
function renderChat() {
  $("#log").innerHTML = "";
  D.msgs.slice(-60).forEach(m => {
    const el = addMsg(m.role === "user" ? "me" : "ai", m.text, m);
    if (m.role === "user" && m.doc) { const s = document.createElement("div"); s.className = "small"; s.textContent = "📄 " + m.doc; el.prepend(s); }
    if (m.role === "ai" && m.files) renderFileCards(el, m.files, false);
    if (m.role === "ai") addAiTools(el, m);
  });
  renderBrief();
  if (!anyBrain()) return showSetupCard();
  if (S.briefing && D.meta.lastBrief !== todayKey() && !D.meta.tempChat) showBriefing();
  // Без приветствия при каждом открытии: пустой разговор — короткая подсказка, а не сообщение
  if (!D.msgs.length) { const e = document.createElement("div"); e.className = "empty-chat"; e.innerHTML = "<b>Сумрак</b><span>Пиши или говори — 🎤 одна фраза, ≋ разговор голосом. Файлы — через 📎.</span>"; $("#log").append(e); }
}
/* Строка важного над перепиской: просроченное и ближайшее сегодня. Не сообщение и не приветствие —
   ничего не пишет в историю и пропадает, когда нечего сказать. */
function renderBrief() {
  const now = Date.now(), end = dayStart(new Date()) + 864e5;
  const open = D.tasks.filter(t => !t.done && t.due);
  const over = open.filter(t => t.due < now && now - t.due < 7 * 864e5 && !t.repeat);
  const next = open.filter(t => t.due >= now && t.due < end).sort((a, b) => a.due - b.due)[0];
  const parts = [];
  if (over.length) parts.push(`Просрочено: ${over.slice(0, 2).map(t => "«" + esc(t.text) + "»").join(", ")}${over.length > 2 ? " и ещё " + (over.length - 2) : ""}`);
  if (next) parts.push(`Дальше сегодня: ${esc(next.text)} в ${hm(new Date(next.due))}`);
  $("#brief").hidden = !parts.length;
  $("#brief").innerHTML = parts.join('<span class="sep">·</span>');
}
/* Если Сумрак сам что-то спросил (например, о незакрытых делах) — кладём это в историю,
   иначе на ответ «перенеси на завтра» нейросеть не поймёт, о чём речь. */
function rememberAsk(text) {
  if (!/Не закрыто/.test(text) || D.meta.tempChat) return;
  // Не чаще раза в 6 часов — чтобы каждое открытие приложения не засоряло историю
  if (D.msgs.slice(-12).some(m => m.role === "ai" && /Не закрыто/.test(m.text) && Date.now() - (m.ts || 0) < 6 * 36e5)) return;
  D.msgs.push({ role: "ai", text, ts: Date.now() }); persist();
}
/* Первый запуск: один рекомендуемый путь (Mistral — работает без VPN), по шагам, с проверкой ключа. */
let pendingAsk = "", pendingImg = null;   // вопрос (и фото), заданные до подключения, — отвечу сразу после
function showSetupCard() {
  const el = document.createElement("div"); el.className = "msg ai setup";
  el.innerHTML = `<div class="by">Сумрак</div>
    <div class="card">
      <h3>Привет, Дмитрий Павлович. Подключи мне нейросеть — это бесплатно</h3>
      <ol class="steps">
        <li>Открой сайт Mistral (работает из России без VPN): <a class="pill" href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener">Открыть Mistral</a></li>
        <li>Войди (через Google или почту), выбери бесплатный план и подтверди номер телефона.</li>
        <li>Нажми «Create new key» и скопируй ключ.</li>
        <li>Вернись сюда и вставь его:</li>
      </ol>
      <div class="key-row"><input id="qMistral" type="password" autocomplete="off" placeholder="Ключ Mistral" aria-label="Ключ Mistral"><button type="button" class="pill" id="qPaste">Вставить</button></div>
      <details class="more-key"><summary>Есть VPN? Добавь ещё Gemini — он умнее и умеет искать в Google</summary>
        <p class="small">Ключ: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (с включённым VPN) → «Create API key».</p>
        <input id="qGemini" type="password" autocomplete="off" placeholder="Ключ Gemini (AIza…)" aria-label="Ключ Gemini">
      </details>
      <button type="button" id="qSave" class="primary-btn">Подключить</button>
      <p class="small" id="qMsg" role="status"></p>
      <p class="small">Ключи остаются только на этом телефоне. <a href="guide.html#brain" target="_blank" rel="noopener">Подробная инструкция</a></p>
    </div>`;
  $("#log").append(el);
  const msg = t => { el.querySelector("#qMsg").textContent = t; };
  el.querySelector("#qPaste").onclick = async () => {
    try { const t = (await navigator.clipboard.readText()).trim(); if (t) { el.querySelector("#qMistral").value = t; msg(""); } else msg("В буфере пусто — сначала скопируй ключ на сайте Mistral."); }
    catch { el.querySelector("#qMistral").focus(); msg("Нажми на поле и выбери «Вставить»."); }
  };
  el.querySelector("#qSave").onclick = async e => {
    const g = el.querySelector("#qGemini").value.trim(), m = el.querySelector("#qMistral").value.trim();
    if (!g && !m) { msg("Сначала вставь ключ."); el.querySelector("#qMistral").focus(); return; }
    const btn = e.target; btn.disabled = true; btn.textContent = "Проверяю связь…"; msg("");
    if (g) S.geminiKey = g; if (m) S.mistralKey = m;
    saveSettings();
    const works = [], kept = [], bad = [];
    for (const b of [m && "mistral", g && "gemini"].filter(Boolean)) {
      try { await ping(b); works.push(b); }
      catch (err) {
        bad.push(explain(err));
        if (isKeyErr(err)) { if (b === "gemini") S.geminiKey = ""; else S.mistralKey = ""; }   // неверный ключ не оставляем
        else kept.push(b);   // ключ верный, но сейчас нет доступа (VPN, лимит, сеть) — сохраняем
      }
    }
    saveSettings(); fillSettings(); idleStatus();
    if (!works.length && !kept.length) { btn.disabled = false; btn.textContent = "Подключить"; msg("Не получилось: " + bad.join(" ") + " Проверь, что ключ скопирован целиком."); return; }
    el.remove();
    discoverGemini().then(fillGeminiModels).catch(() => {});
    if (!works.length) {   // ключ сохранён, но ответа пока нет — честно, без «я на связи»
      addMsg("ai", "Ключ сохранил, но сейчас нейросеть не отвечает: " + bad.join(" ") + "\n\nПопробуй написать чуть позже.");
      return;
    }
    addMsg("ai", "Готово, я на связи. Можешь говорить или писать." + (bad.length ? "\n\n⚠️ Второй пока не отвечает: " + bad.join(" ") : ""));
    lastFail = ""; idleStatus();
    if (pendingAsk) { const q = pendingAsk, img = pendingImg; pendingAsk = ""; pendingImg = null; send(q, { retry: true, img }).catch(() => {}); }
  };
  // Открываем карточку с начала, а не прокрученной до середины
  setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
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
  const el = addMsg("ai", `${g}, Дмитрий Павлович. ${lines.length ? "Коротко о дне:\n" + lines.join("\n") : "Дел на сегодня нет — день свободен. Чем займёмся?"}`);
  const box = document.createElement("div"); box.className = "acts";
  box.append(pill("🗓 Спланировать день", () => send("Помоги спланировать сегодняшний день с учётом моих дел и целей.")));
  if (cards) box.append(pill("🃏 Повторить карточки", startReview));
  el.append(box);
}

/* =================== Отправка =================== */
async function send(text, opts = {}) {
  text = String(text || "").trim();
  const img = "img" in opts ? opts.img : (opts.voice ? null : photo);
  if (!text && img) text = "Посмотри на фото и помоги.";
  if (!text && focusDoc && focusDoc.fresh && !opts.retry) text = "Посмотри этот документ: о чём он и что в нём главное — кратко.";
  if (!text) return "";
  if (busy) busy.abort();
  if (!opts.voice) { V.stopSpeaking(); if (micSt !== "idle") { micGen++; vbSet("idle"); } V.stopRecording(true); }
  setTab("chat");
  const temp = !!D.meta.tempChat;
  if (!opts.retry) {
    $("#input").value = ""; autosize();
    if (!opts.voice) { photo = null; showPhoto(); }
    addMsg("me", text, { img: img && img.url, temp });
    const docTag = focusDoc && focusDoc.fresh ? focusDoc.title : "";
    if (docTag) { focusDoc.fresh = false; showDoc(""); const s = document.createElement("div"); s.className = "small"; s.textContent = "📄 " + docTag; $("#log").lastElementChild.prepend(s); }
    D.msgs.push({ role: "user", text, ts: Date.now(), photo: !!img, temp, ...(docTag ? { doc: docTag } : {}) }); persist();
  }
  if (!anyBrain()) {
    pendingAsk = text; pendingImg = img;
    addMsg("sys", $("#log .setup") ? "Сначала подключи мозг — карточка выше. Твой вопрос я запомнил и отвечу сразу после подключения." : "Сначала подключи мозг: вставь ключ во вкладке «Настройки».");
    return "";
  }
  const el = addMsg("ai", "", { temp }); const body = el.querySelector(".body");
  // «Подумай глубже», «разбери тщательно» — то, что раньше было отдельной кнопкой
  const deep = /подумай (глубже|хорошенько|как следует)|разбери (подробно|тщательно|глубоко)|глубокий анализ|тщательно (проанализируй|подумай)/i.test(text);
  body.innerHTML = `<span class="thinking">${img ? "Смотрю на фото…" : deep ? "Думаю глубоко…" : "Думаю…"}</span>`;
  const ctl = new AbortController(); busy = ctl; idleStatus(); syncSendBtn();
  // Речь начинается с первой готовой фразы, пока ответ ещё пишется.
  const newSpeaker = () => opts.voice || S.speakOn ? V.createSpeaker({ limit: opts.voice ? 1200 : 600 }) : null;
  let speaker = newSpeaker();
  let spokenTo = 0;
  const feed = (v, final) => {
    if (!speaker) return;
    const rest = v.slice(spokenTo);
    if (final) { if (rest.trim()) speaker.add(rest); spokenTo = v.length; return; }
    const re = /[.!?…]+["»)]?\s+/g; let m, cut = -1;
    while ((m = re.exec(rest))) { if (m.index + m[0].length >= (spokenTo ? 120 : 40)) { cut = m.index + m[0].length; break; } }
    if (cut > 0) { speaker.add(rest.slice(0, cut)); spokenTo += cut; }
  };
  // Перерисовка не чаще кадра экрана: на длинных ответах md() для каждого кусочка тормозил телефон
  let pending = "", raf = 0;
  userScrolled = false;
  const paint = () => { raf = 0; if (pending && busy === ctl) { body.innerHTML = md(pending); showReply(el); } };
  const onText = t => { const v = stripActions(t); if (v) { pending = v; if (!raf) raf = requestAnimationFrame(paint); if (opts.onReply) opts.onReply(v); if (!/^(Ищу|Смотрю)/.test(v)) feed(v); } };
  try {
    const [facts, knowledge] = await Promise.all([relevantFacts(text).catch(() => activeFacts().slice(-40)), search(text).catch(() => [])]);
    const docs = docsForPrompt();
    // Документ в фокусе (прикреплён в последние 30 минут): небольшой — целиком, большой — выжимка по всему документу
    let doc = null;
    if (focusDoc && Date.now() - focusDoc.ts < 30 * 6e4) {
      focusDoc.ts = Date.now();
      const full = await docFull(focusDoc.id).catch(() => "");
      if (full && full.length <= 60000) doc = { title: focusDoc.title, text: full, full: true };
      else if (full && WHOLE_RE.test(text)) {
        const r = await deepPass(focusDoc.title, full, text, async p => (await chat({ system: "Ты внимательно читаешь часть документа и выписываешь нужное для задачи. По-русски, точно, без выдумок.", hist: [{ role: "user", text: p }], onText: () => {}, signal: ctl.signal, noSearch: true })).text,
          { signal: ctl.signal, onProgress: (k, n) => { body.innerHTML = `<span class="thinking">Читаю весь документ: часть ${k} из ${n}…</span>`; } });
        doc = { title: focusDoc.title, text: r.notes || "(в документе не нашлось ничего, что относится к задаче)", full: false };
        body.innerHTML = `<span class="thinking">Собираю ответ…</span>`;
      }
    }
    const system = brain => buildPrompt({ query: text, facts, knowledge, docs, voice: !!opts.voice, temp, deep, brain, doc });
    const hist = D.msgs.slice(contextStart(D.msgs)).map(m => ({ role: m.role === "user" ? "user" : "assistant", text: (m.photo && m.role === "user" ? "[прислал фото] " : "") + (m.doc && m.role === "user" ? `[прислал документ «${m.doc}»] ` : "") + m.text }));
    // В исследовательских режимах разрешаем поиск Google даже без явных слов-маркеров
    const wantSearch = deep;
    // Ответ начался заново (была пауза на поиск или сменилась модель) — заново и озвучиваем
    const onReset = () => { if (speaker) { speaker.cancel(); speaker = newSpeaker(); } spokenTo = 0; pending = ""; };
    let res = await chat({ system, hist, img, onText, onReset, signal: ctl.signal, deep, wantSearch });
    // Ответил без поиска и признался, что не знает свежего, — сам ищу в интернете и отвечаю заново
    if (res.brain === "gemini" && res.noSearch && !res.netTried && !img && NOKNOW_RE.test(stripActions(res.text))) {
      if (speaker) { speaker.cancel(); speaker = newSpeaker(); spokenTo = 0; }
      body.innerHTML = `<span class="thinking">Ищу в интернете…</span>`;
      try { res = await chat({ system, hist, img, onText, onReset, signal: ctl.signal, deep, wantSearch: true }); }
      catch (e2) { if (e2.name === "AbortError") throw e2; }   // не вышло — оставим первый ответ
    }
    const visible = stripActions(res.text) || "Готово.";
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    body.innerHTML = md(visible);
    feed(visible, true);
    const who = (BRAINS[res.brain]?.name || "") + (/^gemma/.test(res.model || "") ? " · Gemma" : /small|ministral|nemo/.test(res.model || "") ? " · запасная" : "");
    el.dataset.who = who;
    addSources(el, res.sources);
    const out = applyActions(extractActions(res.text), text, { temp });
    if (!temp && selfCheck(text, visible, out, { searched: !!(res.sources && res.sources.length) }).length) out.learned.push("свой недочёт");
    const files = extractFiles(res.text).map(f => ({ ...f, content: f.content.slice(0, 300000) }));
    const msg = { role: "ai", text: visible, ts: Date.now(), sources: (res.sources || []).slice(0, 6), brain: res.brain, temp, ...(files.length ? { files } : {}) };
    if (files.length) renderFileCards(el, files, true);
    D.msgs.push(msg); persist();
    if (out.newTasks.some(t => t.due)) addTaskButtons(el, out.newTasks.filter(t => t.due));
    if (out.device.length) addDeviceButtons(el, out.device);
    armReminder();
    addAiTools(el, msg);
    const notes = [];
    if (out.project !== undefined) { notes.push(out.project ? `◆ Проект: ${out.project}${out.projectCreated ? " (новый)" : ""}` : "◆ Вне проекта"); renderProject(); }
    if (out.noted) notes.push("📝 Заметка" + (curProject() ? " в проект «" + curProject().name + "»" : "") + (out.noted > 1 ? " ×" + out.noted : ""));
    if (out.remembered.length) notes.push("🧠 Запомнил: " + out.remembered.join("; "));
    if (out.learned.length) notes.push("📘 Выучил: " + out.learned.join(", "));
    if (out.cards) notes.push("🃏 " + plural(out.cards, "новая карточка", "новые карточки", "новых карточек"));
    if (notes.length) { const n = document.createElement("div"); n.className = "memnote"; n.textContent = notes.join(" · "); el.append(n); }
    renderLists();
    showReply(el);
    busy = null; lastFail = ""; idleStatus();
    background();
    const spoken = speaker ? speaker.end() : Promise.resolve();
    if (opts.voice) { await spoken; return visible; }
    spoken.finally(syncSendBtn); syncSendBtn();
    const toIOS = out.newTasks.find(t => t.due);
    if (toIOS && S.autoReminders) setTimeout(() => sendToIOS(toIOS), 600);
    return visible;
  } catch (e) {
    if (speaker) speaker.cancel();
    if (e.name === "AbortError") { body.innerHTML = `<span class="thinking">Остановлено.</span>`; return ""; }
    const m = e.summary || explain(e);
    lastFail = /лимит|подожд/i.test(m) ? "Лимит нейросети — подожди" : /связи|интернет/i.test(m) ? "Нет связи с нейросетью" : "Нейросеть не ответила";
    body.innerHTML = `<span class="thinking">${esc(m).replace(/\n/g, "<br>")}</span>`;
    // Подробности от сервиса — чтобы можно было переслать и понять причину
    const raw = [e.status ? "Код " + e.status : "", String(e.message || ""), ...(e.tried || [])].filter(Boolean).join("\n");
    if (raw) { const d = document.createElement("details"); d.className = "errinfo"; d.innerHTML = `<summary>Подробности</summary><pre>${esc(raw.slice(0, 1500))}</pre>`; el.append(d); }
    const box = document.createElement("div"); box.className = "acts";
    // Повтор: если после этого вопроса разговор уже ушёл дальше — задаём его заново в конце, иначе история собралась бы неверно
    box.append(pill("↻ Повторить", () => {
      el.remove();
      const last = D.msgs[D.msgs.length - 1];
      send(text, { retry: !!(last && last.role === "user" && last.text === text), img, voice: opts.voice }).catch(() => {});
    }));
    // Обычный поиск работает без лимитов нейросетей
    const q = encodeURIComponent(text.slice(0, 300));
    [["🔎 Найти в Яндексе", "https://yandex.ru/search/?text=" + q], ["🔎 Найти в Google", "https://www.google.com/search?q=" + q]].forEach(([t, u]) => {
      const a = document.createElement("a"); a.className = "pill"; a.href = u; a.target = "_blank"; a.rel = "noopener"; a.textContent = t; box.append(a);
    });
    el.append(box);
    userScrolled = false; showReply(el);   // ошибка, «Повторить» и поиск — на виду, а не под краем экрана
    if (opts.voice) throw Object.assign(new Error(m), { spoken: m });
    return "";
  } finally {
    if (busy === ctl) busy = null;
    idleStatus(); syncSendBtn();
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
    if (await selfReview().catch(() => null)) renderKnow();
    if (activeFacts().length > 80 && Date.now() - (D.meta.lastTidy || 0) > 3 * 864e5) { await tidyMemory().catch(() => {}); renderMem(); }
    await ensureFactVecs(); await ensureDocVecs();
  } finally { bg = false; }
}

/* =================== Проекты =================== */
$("#projChip").onclick = () => { renderProjects(); openSheet("#projSheet"); };
$("#projClose").onclick = closeSheets;
function setProject(id) { D.meta.currentProject = id; persist(); renderProject(); renderProjects(); renderLists(); }
function renderProjects() {
  const cur = D.meta.currentProject;
  const count = id => D.tasks.filter(t => t.project === id && !t.done).length;
  $("#projList").innerHTML = `<button type="button" class="proj-row${!cur ? " on" : ""}" data-proj="">Без проекта <span>общий разговор</span></button>` +
    D.projects.map(p => `<div class="proj-line"><button type="button" class="proj-row${cur === p.id ? " on" : ""}" data-proj="${esc(p.id)}">${esc(p.name)} <span>${plural(count(p.id), "дело", "дела", "дел")} · ${plural(D.notes.filter(n => n.project === p.id).length, "заметка", "заметки", "заметок")}</span></button><button type="button" class="x" data-projdel="${esc(p.id)}" aria-label="Удалить проект">×</button></div>`).join("");
}
$("#projList").addEventListener("click", e => {
  const del = e.target.closest("[data-projdel]");
  if (del) {
    const id = del.dataset.projdel, p = D.projects.find(x => x.id === id); if (!p) return;
    if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "Удалить?"; del.classList.add("armed"); return; }
    // Проект удаляется, его дела и заметки остаются (без проекта)
    D.projects = D.projects.filter(x => x.id !== id);
    [D.tasks, D.notes, D.docs].forEach(list => list.forEach(x => { if (x.project === id) delete x.project; }));
    if (D.meta.currentProject === id) D.meta.currentProject = null;
    persist(); renderProject(); renderProjects(); renderLists(); return;
  }
  const b = e.target.closest("[data-proj]"); if (!b) return;
  setProject(b.dataset.proj || null); closeSheets();
  toast(b.dataset.proj ? "Проект: " + curProject().name : "Без проекта", 1800);
});
$("#projAdd").addEventListener("submit", e => {
  e.preventDefault(); const name = $("#projNew").value.trim().slice(0, 60); if (!name) return;
  let p = D.projects.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { p = { id: uid(), name, ts: Date.now() }; D.projects.push(p); }
  $("#projNew").value = ""; setProject(p.id); closeSheets(); toast("Проект: " + p.name, 1800);
});

/* =================== Файлы от Сумрака =================== */
/* Карточка файла: собирается на телефоне; новый — сразу (чтобы «Отправить» сработало по первому касанию), из истории — по касанию. */
function renderFileCards(el, files, eager) {
  files.forEach(f => {
    const name = fileName(f.name, f.format);
    const card = document.createElement("div"); card.className = "filecard";
    card.innerHTML = `<div class="fc-ico" aria-hidden="true">📄</div><div class="fc-meta"><b>${esc(name)}</b><span>${esc(FORMATS[f.format] || "")}</span></div>`;
    const info = card.querySelector(".fc-meta span");
    let blob = null, building = null;
    const build = () => building || (building = makeFile(f.name, f.format, f.content).then(b => { blob = b; info.textContent = `${FORMATS[f.format]} · ${(b.size / 1024).toFixed(b.size < 10240 ? 1 : 0)} КБ`; return b; })
      .catch(e => { building = null; info.textContent = "не получилось собрать: " + (e.message || e); throw e; }));
    if (eager) build().catch(() => {});
    const box = document.createElement("div"); box.className = "acts";
    box.append(pill("📤 Отправить / сохранить", async () => { try { await shareFile(blob || await build(), name); } catch {} }, "primary"));
    const other = f.format === "pdf" ? "docx" : "pdf";
    box.append(pill(other === "pdf" ? "В PDF" : "В Word", async e => {
      const b = e.target; b.disabled = true; const t = b.textContent; b.textContent = "Собираю…";
      try { await shareFile(await makeFile(f.name, other, f.content), fileName(f.name, other)); } catch (err) { toast("Не получилось: " + (err.message || err)); }
      finally { b.disabled = false; b.textContent = t; }
    }));
    card.append(box); el.append(card);
  });
}

/* =================== Фото =================== */
$("#photoBtn").onclick = () => $("#photo").click();
$("#photo").onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  if (/^image\//.test(f.type)) { try { photo = await shrinkImage(f); showPhoto(); } catch { toast("Не получилось открыть фото."); } return; }
  attachDoc(f);
};
/* Документ, прикреплённый в чате: читаю на телефоне, кладу в «Знания» и держу «в фокусе» разговора —
   следующие вопросы и просьбы («исправь», «выпиши все суммы», «сделай PDF») — про него. */
let focusDoc = null;   // { id, title, kind, chars, ts }
const showDoc = t => { $("#docPrev").hidden = !t; if (t) $("#docPrevText").textContent = t; };
async function attachDoc(file) {
  showDoc("Читаю «" + file.name + "»…");
  try {
    const r = await fromFile(file, t => showDoc(t));
    const d = await addDoc(r.title || file.name, r.text, r.kind, { pages: r.pages || 0, background: true, onProgress: t => showDoc(t) });
    if (D.meta.currentProject) { d.project = D.meta.currentProject; persist(); }
    focusDoc = { id: d.id, title: d.title, kind: r.kind, chars: r.text.length, ts: Date.now(), fresh: true };
    showDoc(`«${d.title}» — ${r.pages ? plural(r.pages, "страница", "страницы", "страниц") : plural(Math.max(1, Math.round(r.text.length / 1800)), "страница", "страницы", "страниц")}. Напиши, что сделать: найти, выписать, исправить, сделать PDF…`);
    renderKnow(); $("#input").focus();
  } catch (e) { showDoc(""); toast("Не получилось прочитать: " + (e.message || e), 4000); }
}
$("#docDel").onclick = () => { focusDoc = null; showDoc(""); };
const WHOLE_RE = /(^|[^\p{L}])(все|всё|всех|весь|целиком|полност|список|выпиши|перечисли|найди|сводк|перескаж|кратко|итог|проанализ|сравни|исправ|перепиш|переведи|оформи|сократи|проверь)/iu;
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
/* Панель записи: видно, слушает ли Сумрак, слышит ли голос, когда распознаёт. */
let micSt = "idle", micT0 = 0, micTimer = 0, micGen = 0;
function vbSet(st, title, sub) {
  micSt = st; const bar = $("#voiceBar");
  bar.hidden = st === "idle"; bar.dataset.st = st;
  $("#mic").classList.toggle("live", st === "starting" || st === "listening" || st === "heard");
  if (title) $("#vbTitle").textContent = title;
  $("#vbSub").textContent = sub || "";
  if (st === "listening" && !micTimer) { micT0 = Date.now(); micTimer = setInterval(() => { const sec = Math.floor((Date.now() - micT0) / 1000); $("#vbTime").textContent = Math.floor(sec / 60) + ":" + pad(sec % 60); }, 250); }
  if (st !== "listening" && st !== "heard") { clearInterval(micTimer); micTimer = 0; }
  if (st === "starting") $("#vbTime").textContent = "0:00";
}
const BARS = [0.5, 0.8, 1, 0.8, 0.5];
function vbLevel(v) { $$("#voiceBar .vb-level i").forEach((el, i) => { el.style.height = Math.round(6 + v * 22 * BARS[i]) + "px"; }); }
function micStop(cancel) { if (micSt === "starting" || micSt === "listening" || micSt === "heard") V.stopRecording(cancel); }
$("#vbDone").onclick = () => { V.unlock(); micStop(false); };
$("#vbCancel").onclick = () => {
  if (micSt === "transcribing") { micGen++; vbSet("idle"); idleStatus(); return; }   // распознанное просто не отправим
  micGen++; micStop(true); vbSet("idle"); idleStatus();
};
$("#mic").onclick = async () => {
  V.unlock();
  if (micSt === "transcribing") { toast("Секунду — распознаю сказанное…", 1500); return; }
  if (micSt !== "idle" && micSt !== "miss") { micStop(false); return; }   // второе нажатие = «Готово, отправляй»
  const gen = ++micGen;
  V.stopSpeaking(); syncSendBtn(); showHint("");
  vbSet("starting", "Включаю микрофон…"); vbLevel(0); status("Слушаю…", "listen");
  V.beep(660, 1);
  try {
    const text = await V.listen({
      silenceMs: pauseMs(), noSpeechMs: 12000,
      onStart: () => { if (gen === micGen) vbSet("listening", "Слушаю — говори", "Закончишь — я сам отправлю. Или нажми «Готово»"); },
      onSpeech: () => { if (gen === micGen) vbSet("heard", "Слышу тебя…", "Договори — пауза, и я отправлю"); },
      onLevel: v => { if (gen === micGen) vbLevel(v); },
      onInterim: t => { $("#input").value = t; autosize(); },
      onTranscribing: () => { if (gen === micGen) { V.beep(440, 1); vbSet("transcribing", "Распознаю…", "Сейчас отправлю"); status("Распознаю…", "busy"); } },
    });
    if (gen !== micGen) return;     // отменено
    if (!text) {
      vbSet("miss", "Не услышал тебя", "Нажми 🎤 и скажи ещё раз — громче или ближе к телефону");
      idleStatus(); setTimeout(() => { if (gen === micGen && micSt === "miss") vbSet("idle"); }, 4000);
      return;
    }
    vbSet("idle"); idleStatus();
    // Сказал голосом — отвечаю голосом, коротко, как в живой беседе (текст тоже остаётся на экране)
    $("#input").value = ""; autosize();
    send(text, { voice: true }).catch(e => { V.speak(e.spoken || explain(e), { force: true }); });
  } catch (e) { if (gen === micGen) { vbSet("idle"); idleStatus(); showHint(voiceErr(e)); } }
};

/* =================== Голос: разговор =================== */
let talkOn = false, talkPhase = "idle", talkGen = 0;
function talkSet(phase, text) {
  talkPhase = phase;
  $("#talkView").dataset.phase = phase;
  // Ошибка (нет микрофона и т.п.) — вместо подсказки про круг предлагаем написать текстом
  const err = phase === "idle" && !!text && !/^Нажми/.test(text);
  $("#talkView").classList.toggle("err", err); $("#talkType").hidden = !err;
  $("#talkState").textContent = text || { listening: "Слушаю… Договоришь — нажми на круг", thinking: "Думаю…", speaking: "Говорю… (нажми, чтобы перебить)", idle: "Нажми на круг и говори", transcribing: "Распознаю…" }[phase];
}
function orbLevel(v) { $("#orbRing").style.transform = `scale(${1 + v * 0.45})`; }
$("#talk").onclick = () => { V.unlock(); openTalk(); };
function openTalk({ waitTap = false } = {}) {
  if (!anyBrain()) { toast("Сначала подключи мозг в «Настройках»."); return; }
  V.stopSpeaking(); if (busy) busy.abort();      // старый ответ не должен звучать в микрофон
  talkOn = true; $("#talkView").hidden = false; $("#talkText").textContent = "";
  $(".app").inert = true; setTimeout(() => $("#orb").focus(), 50);   // фокус — в окно разговора, приложение под ним недоступно
  const en = V.engineName(); $("#talkBrain").textContent = en.charAt(0).toUpperCase() + en.slice(1);   // без названий нейросетей — только чем говорю
  // При открытии приложения iPhone не даёт включить звук и микрофон без касания — ждём одно нажатие на круг
  if (waitTap) { talkGreet = true; talkSet("idle", "Нажми на круг и говори"); return; }
  talkLoop();
}
let talkGreet = false;   // поздороваться первым при начале разговора
function closeTalk() {
  talkOn = false; talkGen++; $("#talkView").hidden = true; $(".app").inert = false;
  V.stopRecording(true); V.stopSpeaking(); if (busy) busy.abort(); idleStatus();
}
$("#talkClose").onclick = closeTalk;
$("#talkType").onclick = () => { closeTalk(); $("#input").focus(); };
$("#orb").onclick = () => {
  V.unlock();
  if (talkPhase === "speaking") { V.stopSpeaking(); return; }                  // перебить
  if (talkPhase === "listening") { V.stopRecording(); return; }                // закончил говорить
  if (talkPhase === "thinking" && busy) { busy.abort(); return; }
  if (talkPhase === "idle" && talkOn) talkLoop();
};
/* Приветствие голосом — Сумрак начинает разговор первым, как живой собеседник. */
function spokenGreeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const now = Date.now(), end = dayStart(new Date()) + 864e5;
  const today = D.tasks.filter(t => !t.done && t.due && t.due >= now && t.due < end).sort((a, b) => a.due - b.due);
  const tail = today.length ? ` Сегодня у тебя: ${today.slice(0, 2).map(t => t.text + " в " + hm(new Date(t.due))).join(", ")}.` : "";
  const over = D.tasks.filter(t => !t.done && (t.notified || now - t.due >= 864e5) && t.due && t.due < now && now - t.due < 7 * 864e5 && !t.repeat);
  const late = over.length ? ` Не закрыто с прошлого: ${over.slice(0, 2).map(t => t.text).join(", ")}${over.length > 2 ? " и ещё " + (over.length - 2) : ""} — сделано или перенести?` : "";
  return `${g}, Дмитрий Павлович.${tail}${late} Слушаю тебя.`;
}
async function talkLoop() {
  const gen = ++talkGen;                      // только один цикл разговора одновременно
  const alive = () => talkOn && gen === talkGen;
  let empties = 0;
  if (talkGreet) {
    talkGreet = false;
    talkSet("speaking"); const gr = spokenGreeting(); $("#talkText").textContent = gr; rememberAsk(gr.replace("Не закрыто с прошлого", "Не закрыто"));
    await V.speak(gr, { force: true });
    if (!alive()) return;
  }
  while (alive()) {
    talkSet("listening"); orbLevel(0);
    let text = "";
    // Ждём паузу из настроек (по умолчанию 2,5 с) и до 15 с, пока Дмитрий Павлович собирается с мыслями перед первой фразой
    try { text = await V.listen({ silenceMs: pauseMs(), noSpeechMs: 15000, onLevel: orbLevel, onTranscribing: () => talkSet("transcribing"), onInterim: t => { $("#talkText").textContent = t; } }); }
    catch (e) { if (alive()) talkSet("idle", voiceErr(e)); return; }
    orbLevel(0);
    if (!alive()) return;
    if (!text) {
      if (++empties >= 2 || !S.handsFree) { talkSet("idle"); return; }
      continue;
    }
    empties = 0;
    $("#talkText").textContent = "«" + text + "»";
    if (/^(стоп|хватит|пока|выход|заверши|всё,? спасибо|отбой)[.!]?$/i.test(text.trim())) {
      talkSet("speaking"); await V.speak("До связи, Дмитрий Павлович.", { force: true }); closeTalk(); return;
    }
    talkSet("thinking");
    let reply = "";
    V.onSpeakingChange(on => { syncSendBtn(); if (on && alive()) talkSet("speaking"); });
    try { reply = await send(text, { voice: true, onReply: r => { $("#talkText").textContent = r.length > 400 ? r.slice(0, 400) + "…" : r; } }); }
    catch (e) { reply = e.spoken || explain(e); talkSet("speaking"); await V.speak(reply, { force: true }); }
    finally { V.onSpeakingChange(syncSendBtn); }
    if (!alive()) return;
    if (!reply) { talkSet("idle"); return; }
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
  if (!review || review.i >= review.q.length) { addMsg("ai", "Повторение закончено. Молодец, Дмитрий Павлович."); review = null; renderKnow(); return; }
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
$("#selfReviewBtn").onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = "Перечитываю переписку…";
  try { const r = await selfReview(true); renderKnow(); toast(r && r.length ? "Нашёл недочётов: " + r.length + ". Они в списке ниже." : r ? "Новых ошибок в недавней переписке не нашёл." : "Пока мало переписки для разбора.", 3500); }
  catch (err) { toast(explain(err)); }
  finally { b.disabled = false; b.textContent = "Проверить себя сейчас"; }
};

/* =================== Действия на iPhone через «Команды» =================== */
/* Веб-приложению iPhone не даёт трогать будильник и файлы. Это умеет приложение «Команды»:
   Сумрак передаёт задачу команде «Сумрак Действие» (её один раз создают по инструкции), она и выполняет. */
const DEVICE_SHORTCUT = "Сумрак Действие";
// Переход в «Команды» (в тестах перехватывается через window.__dpOpen)
const openURL = url => { if (window.__dpOpen) window.__dpOpen(url); else location.href = url; };
function runDevice(d) {
  openURL("shortcuts://run-shortcut?name=" + encodeURIComponent(DEVICE_SHORTCUT) + "&input=text&text=" + encodeURIComponent(JSON.stringify(d)));
}
function deviceLabel(d) {
  return d.do === "alarm" ? `⏰ Поставить будильник на ${d.time}` : d.do === "timer" ? `⏱ Запустить таймер на ${plural(d.minutes, "минуту", "минуты", "минут")}` : "🗂 Разложить файлы по папкам";
}
function addDeviceButtons(el, list) {
  const box = document.createElement("div"); box.className = "acts";
  list.forEach(d => box.append(pill(deviceLabel(d), () => runDevice(d), "primary")));
  const hint = document.createElement("div"); hint.className = "small";
  hint.innerHTML = `Сработает через приложение «Команды» — если команды «${DEVICE_SHORTCUT}» ещё нет, <a href="guide.html#apps">создай её по инструкции</a> (один раз).`;
  el.append(box, hint);
}
$("#testAlarm").onclick = () => runDevice({ do: "timer", minutes: 1 });

/* =================== Напоминания =================== */
const SHORTCUT = "Сумрак Напоминание";
function sendToIOS(t) {
  openURL("shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT) + "&input=text&text=" + encodeURIComponent(JSON.stringify({ title: t.text, due: isoLocal(t.due) })));
}
function addToCalendar(t) {
  const d = new Date(t.due), e = new Date(t.due + 15 * 6e4);
  const f = x => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  const title = t.text.replace(/[,;\\]/g, " ").replace(/\s+/g, " ").trim();
  const alarm = (trig) => ["BEGIN:VALARM", `X-WR-ALARMUID:${t.id}${trig}`, `UID:${t.id}${trig}`, `TRIGGER:${trig}`, `DESCRIPTION:${title}`, "ACTION:DISPLAY", "END:VALARM"];
  const rr = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" }[t.repeat];
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DmitriyPavlov//RU", "BEGIN:VEVENT", `UID:${t.id}@dmitriy-pavlov`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, `DTSTART:${f(d)}`, `DTEND:${f(e)}`,
    `SUMMARY:${title}`, ...(rr ? ["RRULE:" + rr] : []),
    // Оповещение в формате, который пишет сам Календарь Apple: в момент события + за 10 минут
    ...alarm("-PT0S"), ...alarm("-PT10M"), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "napominanie.ics"; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
  toast("Нажми «Добавить» в календаре. Оповещения: в момент события и за 10 минут.", 4000);
}
function checkReminders() {
  const now = Date.now(); let changed = false; const fired = [];
  D.tasks.filter(t => !t.done && !t.notified && t.due && t.due <= now).forEach(t => {
    changed = true;
    if (now - t.due < 864e5) { t.notifiedAt = now; fired.push(t.text); }
    if (t.repeat) advanceTask(t); else t.notified = true;
  });
  if (fired.length) {
    // Несколько сразу (например, пока приложение было закрыто) — одним сообщением, одним сигналом
    const msg = "Дмитрий Павлович, напоминаю: " + (fired.length === 1 ? fired[0] : fired.map(t => "«" + t + "»").join(", "));
    toast("⏰ " + (fired.length === 1 ? fired[0] : plural(fired.length, "напоминание", "напоминания", "напоминаний")), 8000);
    V.beep(); addMsg("ai", msg);
    // Не говорим поверх записи (иначе напоминание попадёт в микрофон как фраза Дмитрия Павловича)
    // и не обрываем ответ, который сейчас звучит, — тогда хватит сигнала и сообщения
    if (!talkOn && !V.isRecording() && !V.speaking() && !busy) V.speak(msg, { force: true });
  }
  if (changed) { persist(); renderTasks(); }
  armReminder();
}
/* Точный таймер на ближайшее напоминание (до секунды), пока приложение открыто. */
let remTimer = 0;
function armReminder() {
  clearTimeout(remTimer);
  const next = D.tasks.filter(t => !t.done && !t.notified && t.due).reduce((m, t) => Math.min(m, t.due), Infinity);
  const wait = next - Date.now();
  if (wait < 864e5) remTimer = setTimeout(checkReminders, Math.max(0, wait) + 30);
}

/* =================== Списки =================== */
function emptyAfter(sel, n, text) {
  const ul = $(sel); let p = ul.nextElementSibling;
  if (!p || !p.classList.contains("empty")) { p = document.createElement("p"); p.className = "empty"; ul.after(p); }
  p.textContent = text; p.hidden = n > 0;
}
/* Важность 1–10 точками (значение ограничено — испорченные данные не ломают экран). */
const dots = imp => { const k = Math.max(0, Math.min(5, Math.round((+imp || 5) / 2))); return "●".repeat(k) + "○".repeat(5 - k); };
function renderTasks() {
  const cur = D.meta.currentProject, pName = id => (D.projects.find(p => p.id === id) || {}).name || "";
  const tag = x => x.project && pName(x.project) ? `<span class="ptag">◆ ${esc(pName(x.project))}</span>` : "";
  const ts = D.tasks.slice().sort((a, b) => (a.done - b.done) || ((b.project === cur && !!cur) - (a.project === cur && !!cur)) || ((a.due ?? 9e15) - (b.due ?? 9e15)) || (a.ts - b.ts));
  const open = ts.filter(t => !t.done).length;
  $("#tstat").textContent = open ? open + " откр." : ""; $("#tcount").textContent = open ? "·" + open : "";
  $("#tasks").innerHTML = ts.map(t => `<li class="row${t.done ? " done" : ""}">
      <input type="checkbox" data-done="${esc(t.id)}" ${t.done ? "checked" : ""} aria-label="Готово">
      <div class="tx">${esc(t.text)}${tag(t)}${t.due ? `<span class="due${!t.done && t.due < Date.now() ? " over" : ""}">${fmtDue(t.due)}${t.repeat && Object.hasOwn(REPEAT_TXT, t.repeat) ? " · " + REPEAT_TXT[t.repeat] : ""}</span>` : ""}</div>
      <div class="btns">${t.due && !t.done ? `<button class="x" data-ios="${esc(t.id)}" title="В Напоминания iPhone">⏰</button>` : ""}<button class="x" data-del="tasks:${esc(t.id)}" aria-label="Удалить">×</button></div></li>`).join("");
  emptyAfter("#tasks", ts.length, "Дел нет. Скажи, например: «напомни завтра в 9 позвонить маме» или «каждый день в 8 напоминай пить воду».");
  const ns = D.notes.slice().sort((a, b) => ((b.project === cur && !!cur) - (a.project === cur && !!cur)) || b.ts - a.ts);
  $("#nstat").textContent = ns.length || "";
  $("#notes").innerHTML = ns.map(n => `<li class="row nocheck"><div class="tx">${esc(n.text)}${tag(n)}<span class="due">${fmtDue(n.ts)}</span></div><button class="x" data-del="notes:${esc(n.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#notes", ns.length, "Пока пусто. Скажи «запиши заметку…» или впиши выше.");
}
function renderKnow() {
  $("#dstat").textContent = D.docs.length || "";
  $("#docs").innerHTML = D.docs.slice().reverse().map(d => `<li class="row nocheck"><div class="tx"><b>${esc(d.title)}</b><span class="due">${esc(d.kind)} · ${plural(+d.chunks || 0, "фрагмент", "фрагмента", "фрагментов")} · ${fmtAgo(d.ts)}${d.vec ? " · поиск по смыслу" : ""}</span></div><button class="x" data-deldoc="${esc(d.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#docs", D.docs.length, "Пока ничего. Дай мне текст, ссылку или документ — изучу.");
  const due = dueCards().length;
  $("#cstat").textContent = D.cards.length ? `${due} к повтору из ${D.cards.length}` : "";

  $("#reviewBtn").textContent = due ? "Повторить " + plural(due, "карточку", "карточки", "карточек") : "Нечего повторять";
  $("#reviewBtn").disabled = !due;
  $("#sstat").textContent = D.skills.length || "";
  $("#skills").innerHTML = D.skills.map(s => `<li class="row nocheck"><div class="tx"><details><summary><b>${esc(s.name)}</b> — ${esc(s.desc)}</summary><div class="small pre">${s.trigger ? "Когда: " + esc(s.trigger) + "\n" : ""}${esc(s.steps)}</div></details><span class="due">применён ${plural(+s.uses || 0, "раз", "раза", "раз")}</span></div><button class="x" data-del="skills:${esc(s.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#skills", D.skills.length, "Пока нет навыков.");
  const open = openMistakes();
  $("#mistat").textContent = open.length ? open.length + " открыто" : D.mistakes.length ? "всё исправлено" : "";
  $("#mistakes").innerHTML = D.mistakes.slice().sort((a, b) => (a.status === "fixed") - (b.status === "fixed") || (b.last || b.ts) - (a.last || a.ts)).map(m =>
    `<li class="row nocheck"><div class="tx">${m.status === "fixed" ? "✅ " : "⚠️ "}${esc(m.what)}${m.fix ? `<span class="due">Исправляю: ${esc(m.fix)}</span>` : ""}<span class="due">${esc(m.src || "")} · ${fmtAgo(m.last || m.ts)}${(m.count || 1) > 1 ? " · повторялось " + plural(+m.count || 1, "раз", "раза", "раз") : ""}${m.status === "fixed" ? " · не повторялось 2 недели" : ""}</span></div><button class="x" data-del="mistakes:${esc(m.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#mistakes", D.mistakes.length, "Пока ничего не записано. Я замечаю свои ошибки, когда ты поправляешь меня, ставишь 👎, и раз в день сам перечитываю переписку.");
  $("#lstat").textContent = D.lessons.length || "";
  $("#lessons").innerHTML = D.lessons.map(l => `<li class="row nocheck"><div class="tx">${esc(l.text)}</div><button class="x" data-del="lessons:${esc(l.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#lessons", D.lessons.length, "Пока нет. Ставь 👎 под неудачными ответами — я сделаю выводы.");
}
function renderMem() {
  $("#cProfile").value = D.core.profile || ""; $("#cGoals").value = D.core.goals || ""; $("#cPeople").value = D.core.people || ""; $("#cPrefs").value = D.core.preferences || "";
  $("#insights").innerHTML = D.insights.slice().reverse().map(i => `<li class="row nocheck"><div class="tx">${esc(i.text)}</div><button class="x" data-del="insights:${esc(i.id)}" aria-label="Удалить">×</button></li>`).join("");
  emptyAfter("#insights", D.insights.length, "Выводы появятся, когда я узнаю тебя получше (обновляю раз в день).");
  const facts = activeFacts();
  $("#mstat").textContent = facts.length || "";
  // Неизвестная тема (например, из старой копии) — в «другое», иначе факт посчитан, но не виден
  $("#facts").innerHTML = CATS.map(c => [c, facts.filter(f => (CATS.includes(f.cat) ? f.cat : "другое") === c).sort((a, b) => (b.imp || 5) - (a.imp || 5))]).filter(g => g[1].length)
    .map(([c, list]) => `<li class="grp">${esc(c)}</li>` + list.map(f => `<li class="row nocheck"><div class="tx">${esc(f.text)}<span class="due">${dots(f.imp)} · ${fmtAgo(f.ts)}</span></div><button class="x" data-forget="${esc(f.id)}" aria-label="Забыть">×</button></li>`).join("")).join("");
  emptyAfter("#facts", facts.length, "Пока ничего. Просто разговаривай со мной — я буду запоминать важное.");
  $("#diary").textContent = D.diary.text || "Пока пусто. Когда разговоров станет больше, здесь появится краткая история: о чём мы говорили и что решили.";
}
function renderLists() { renderTasks(); renderKnow(); renderMem(); renderBrief(); renderProject(); }

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-del],[data-ios],[data-forget],[data-deldoc]"); if (!t) return;
  if (t.dataset.del) {
    const [k, id] = t.dataset.del.split(":"); const i = D[k].findIndex(x => x.id === id);
    if (i >= 0) { const [item] = D[k].splice(i, 1); undoable("Удалено", () => { D[k].splice(Math.min(i, D[k].length), 0, item); persist(); renderLists(); }); }
  }
  if (t.dataset.forget) {
    const f = D.facts.find(x => x.id === t.dataset.forget);
    if (f) { const was = f.status; f.status = "old"; f.validTo = Date.now(); undoable("Забыл", () => { f.status = was; delete f.validTo; persist(); renderLists(); }); }
  }
  if (t.dataset.ios) { const task = D.tasks.find(x => x.id === t.dataset.ios); if (task) sendToIOS(task); return; }
  if (t.dataset.deldoc) {
    // Материал удаляется безвозвратно — второе касание для подтверждения
    if (!t.dataset.armed) { t.dataset.armed = "1"; t.textContent = "Удалить?"; t.classList.add("armed"); setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = "×"; t.classList.remove("armed"); } }, 4000); return; }
    await removeDoc(t.dataset.deldoc);
  }
  persist(); renderLists();
});
document.addEventListener("change", e => {
  const id = e.target.dataset && e.target.dataset.done; if (!id) return;
  const t = D.tasks.find(x => x.id === id); if (!t) return;
  if (e.target.checked && t.repeat && t.due) { completeTask(t); toast("Отметил. Следующий раз: " + fmtDue(t.due), 2500); }
  else t.done = e.target.checked;
  persist(); renderTasks(); armReminder();
});
// Повтор имеет смысл только при выбранном времени
$("#newDue").addEventListener("input", () => { $("#newRepeat").disabled = !$("#newDue").value; if (!$("#newDue").value) $("#newRepeat").value = ""; });
$("#addTask").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newTask").value.trim(); if (!text) return;
  const due = $("#newDue").value ? parseLocal($("#newDue").value) : null;
  const repeat = due && Object.hasOwn(REPEAT_TXT, $("#newRepeat").value) ? $("#newRepeat").value : null;
  D.tasks.push({ id: uid(), text, due, repeat, done: false, notified: false, ts: Date.now(), ...(D.meta.currentProject ? { project: D.meta.currentProject } : {}) }); persist(); renderTasks();
  $("#newTask").value = ""; $("#newDue").value = ""; $("#newRepeat").value = ""; $("#newRepeat").disabled = true;
  armReminder();
});
$("#addNote").addEventListener("submit", e => {
  e.preventDefault(); const text = $("#newNote").value.trim(); if (!text) return;
  D.notes.push({ id: uid(), text, ts: Date.now(), ...(D.meta.currentProject ? { project: D.meta.currentProject } : {}) }); persist(); renderTasks(); $("#newNote").value = "";
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
    let pages = 0, note = "";
    const progress = t => { out.textContent = t; };
    if (teachKind === "file") {
      const f = $("#tFile").files[0]; if (!f) throw new Error("Выбери файл.");
      if (f.size > 200 * 1024 * 1024) throw new Error("Файл больше 200 МБ — раздели его на части.");
      const r = await fromFile(f, progress); text = r.text; title = title || r.title; kind = r.kind || "файл"; pages = r.pages || 0; note = r.note || "";
    }
    const d = await addDoc(title || "Без названия", text, kind, { pages, onProgress: progress });
    out.textContent = `Изучил «${d.title}»${d.pages ? ` (${d.pages} стр.)` : ""}: ${plural(+d.chunks || 0, "фрагмент", "фрагмента", "фрагментов")}${d.vec ? ", понимаю по смыслу" : ""}${d.summary ? ", конспект готов" : ""}. ${note}`;
    $("#tTitle").value = ""; $("#tText").value = ""; $("#tUrl").value = ""; $("#tFile").value = "";
    renderKnow();
  } catch (err) { out.textContent = err.status ? explain(err) : err.message; }
  finally { btn.disabled = false; }
});

/* =================== Настройки =================== */
const TEXT_KEYS = ["geminiKey", "mistralKey", "zaiKey", "openrouterKey", "claudeKey", "claudeModel", "customBase", "customKey", "customModel", "tavilyKey"];
const SELECT_KEYS = ["brain", "geminiModel", "mistralModel", "voiceMode", "piperVoice", "liveVoice", "iosVoice", "sttMode", "talkPause"];
/* Сколько тишины считать концом фразы (настройка «Сколько ждать…»): раньше было жёстко 1,3 с — обрывал на полуслове. */
const pauseMs = () => Math.round(Math.min(8, Math.max(1, +S.talkPause || 2.5)) * 1000);
const CHECK_KEYS = ["speakOn", "handsFree", "briefing", "autoReminders", "talkOnOpen"];
function fillGeminiModels() {
  const m = D.meta.models; const sel = $("#geminiModel");
  const ids = m ? [...new Set([...(m.chat || []), ...(m.deep || []), ...(m.lite || [])])] : [];
  sel.innerHTML = `<option value="auto">Автоматически — лучшая из доступных${m && m.chat && m.chat[0] ? " (" + esc(m.chat[0]) + ")" : ""}</option>` + ids.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
  sel.value = ids.includes(S.geminiModel) ? S.geminiModel : "auto";
}
function fillVoices() {
  const lv = V.localVoices();
  $("#piperVoice").innerHTML = Object.entries(lv).map(([id, v]) => `<option value="${id}">${esc(v.name)} — ${esc(v.note)}</option>`).join("");
  $("#piperVoice").value = lv[S.piperVoice] ? S.piperVoice : Object.keys(lv)[0];
  $("#liveVoice").innerHTML = V.liveVoices().map(v => `<option>${v}</option>`).join(""); $("#liveVoice").value = S.liveVoice;
  const vs = V.loadIOSVoices();
  $("#iosVoice").innerHTML = `<option value="">Автоматически (мужской, если есть)</option>` + vs.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join("");
  $("#iosVoice").value = vs.some(v => v.voiceURI === S.iosVoice) ? S.iosVoice : "";
}
function fillSettings() {
  $("#incognito").checked = !!D.meta.tempChat;
  const lb = D.meta.lastBackup; $("#lastBackup").textContent = lb ? "Последняя копия — " + fmtAgo(lb) + "." : "Копии ещё не было.";
  TEXT_KEYS.forEach(k => { $("#" + k).value = S[k] || ""; });
  SELECT_KEYS.forEach(k => { const el = $("#" + k); if ([...el.options].some(o => o.value === S[k])) el.value = S[k]; });
  CHECK_KEYS.forEach(k => { $("#" + k).checked = !!S[k]; });
  $("#rate").value = S.rate; $("#rateVal").textContent = "×" + (+S.rate).toFixed(2);
  $$("[data-ok]").forEach(s => { s.textContent = S[s.dataset.ok] ? "✓" : ""; });
  const list = order();
  const u = D.meta.usage && D.meta.usage.day === todayKey() ? D.meta.usage.n : {};
  const used = Object.entries(u).map(([b, n]) => `${BRAINS[b] ? BRAINS[b].name : b} — ${n}`).join(", ");
  $("#brainNow").textContent = (list.length ? "Сейчас отвечает: " + BRAINS[list[0]].name + (list.length > 1 ? ". Запасные: " + list.slice(1).map(b => BRAINS[b].name).join(", ") + "." : ". Подключи ещё один — будет запасной.") : "Ни одна нейросеть не подключена.") + (used ? ` Запросов сегодня: ${used}.` : "");
  idleStatus();
}
TEXT_KEYS.forEach(k => $("#" + k).addEventListener("change", e => {
  S[k] = e.target.value.trim(); saveSettings(); lastFail = ""; fillSettings();
  // Новый ключ — новые лимиты: забываем, какие модели были исчерпаны у старого
  if (k === "geminiKey") { D.meta.deadModels = {}; D.meta.models = null; persist(); }
  if (k === "geminiKey" && S.geminiKey) discoverGemini(true).then(fillGeminiModels).catch(err => toast(explain(err)));
  if (k === "openrouterKey" && S.openrouterKey) discoverOpenRouter(true).catch(() => {});
}));
SELECT_KEYS.forEach(k => $("#" + k).addEventListener("change", e => { S[k] = e.target.value; saveSettings(); fillSettings(); if (k === "voiceMode" || k === "piperVoice") updateLocal(); }));
$("#incognito").addEventListener("change", e => {
  D.meta.tempChat = e.target.checked;
  if (!D.meta.tempChat) D.msgs = D.msgs.filter(m => !m.temp);
  persist(); toast(D.meta.tempChat ? "Инкогнито: этот разговор не попадёт в память." : "Инкогнито выключено, разговор стёрт.", 2500);
  renderChat(); idleStatus();
});
CHECK_KEYS.forEach(k => $("#" + k).addEventListener("change", e => { S[k] = e.target.checked; saveSettings(); if (k === "speakOn" && !S.speakOn) V.stopSpeaking(); }));
/* ---------- Голос на телефоне ---------- */
let localBusy = false;
async function updateLocal() {
  $("#localBox").hidden = S.voiceMode !== "local"; $("#liveBox").hidden = S.voiceMode !== "live";
  $("#pace").value = S.pace; $("#paceVal").textContent = (+S.pace >= 1.15 ? "медленнее" : +S.pace <= 0.95 ? "быстрее" : "спокойный");
  if (localBusy) return;
  const ok = await V.refreshLocal();
  const name = (V.localVoices()[S.piperVoice] || {}).name || "";
  $("#localState").textContent = ok ? `✅ Голос «${name}» скачан и работает на телефоне.` : `Голос «${name}» ещё не скачан — пока говорю голосом iPhone.`;
  $("#localGet").hidden = ok; $("#localDel").hidden = !ok;
  if (ok) V.warmLocal();
}
async function getLocalVoice(btn, out) {
  if (localBusy) return; localBusy = true; btn.disabled = true;
  const show = t => { if (out) out.textContent = t; $("#localState").textContent = t; };
  try {
    show("Скачиваю голос… 0%");
    await V.downloadLocal((got, total) => show(`Скачиваю голос… ${Math.min(99, Math.round(got / total * 100))}% (${(got / 1048576).toFixed(0)} из ${(total / 1048576).toFixed(0)} МБ)`));
    show("Готовлю голос…");
    V.warmLocal();
    localBusy = false; await updateLocal(); idleStatus();
    V.unlock(); V.speak("Дмитрий Павлович, теперь я говорю вот так. Спокойно и по-человечески.", { force: true }).finally(syncSendBtn);
    return true;
  } catch (e) {
    show("Не получилось скачать голос: " + (e.message || e) + ". Проверь интернет и попробуй ещё раз (VPN не нужен — голос лежит на нашем сайте).");
    return false;
  } finally { localBusy = false; btn.disabled = false; }
}
$("#localGet").onclick = e => { V.unlock(); getLocalVoice(e.target); };
$("#localDel").onclick = async () => { await V.removeLocal(); updateLocal(); toast("Голос удалён с телефона.", 2000); };
$("#pace").oninput = e => { S.pace = +e.target.value; saveSettings(); updateLocal(); };
$("#rate").oninput = e => { S.rate = +e.target.value; $("#rateVal").textContent = "×" + S.rate.toFixed(2); saveSettings(); };
$("#testVoice").onclick = () => { V.unlock(); V.speak("Дмитрий Павлович, я на связи. Так звучит мой голос.", { force: true }).finally(syncSendBtn); syncSendBtn(); };
$("#testReminder").onclick = () => sendToIOS({ text: "Проверка: Сумрак", due: Date.now() + 2 * 6e4 });

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
    catch (err) { add(false, "Микрофон", err.name === "NotAllowedError" ? "доступ запрещён — разреши в настройках iPhone (Safari → Микрофон)" : err.name === "NotFoundError" ? "микрофон не найден — проверь, не подключены ли наушники без микрофона" : err.name === "NotReadableError" ? "микрофон занят другим приложением (звонок, запись) — закрой его" : "не удалось включить микрофон"); }
  } else add(false, "Микрофон", "запись звука не поддерживается");
  add(canTranscribe() ? true : V.SR ? null : false, "Распознавание речи", canTranscribe() ? "нейросетью (" + (configured().includes("gemini") && !isBlocked("gemini") ? "Gemini" : "Mistral") + ")" : V.SR ? "только встроенное iOS — в приложении с экрана «Домой» может не работать; подключи Gemini или Mistral" : "недоступно — подключи Gemini или Mistral");
  if (canTTS()) {
    try { await ttsGemini("Проверка.", S.liveVoice); add(true, "Живой голос", "работает · " + S.liveVoice); }
    catch (err) { add(false, "Живой голос", explain(err) + " — буду говорить голосом iPhone"); }
  } else add(null, "Живой голос", "нужен Gemini (с VPN); сейчас — голос iPhone");
  add(S.voiceMode !== "local" ? null : V.localAvailable() ? true : false, "Голос на телефоне", S.voiceMode !== "local" ? "выключен (выбран другой голос)" : V.localAvailable() ? "скачан, работает без лимитов" : "не скачан — «Настройки» → «Голос» → «Скачать голос»");
  const vs = V.loadIOSVoices(); add(vs.length ? true : null, "Голос iPhone", vs.length ? vs.map(v => v.name).join(", ") : "русских голосов не найдено — скачай «Юрий» в настройках iPhone");
  diagReport = "Сумрак — проверка " + new Date().toLocaleString("ru-RU") + "\n" + rows.map(r => `${r.ok === true ? "OK" : r.ok === false ? "ОШИБКА" : "внимание"} | ${r.name}: ${r.info}`).join("\n");
  $("#diagCopy").hidden = false; btn.disabled = false; btn.textContent = "Проверить ещё раз";
};
$("#diagCopy").onclick = async () => { try { await navigator.clipboard.writeText(diagReport); toast("Отчёт скопирован — пришли его Claude, если нужна помощь.", 3000); } catch { toast(diagReport); } };

/* =================== Данные =================== */
let backupCache = "", backupVer = -1;
async function prepBackup() { try { const v = dataVersion(); backupCache = JSON.stringify(await exportAll()); backupVer = v; } catch {} }
const backedUp = () => { D.meta.lastBackup = Date.now(); persist(); $("#lastBackup").textContent = "Последняя копия — только что."; setTimeout(prepBackup, 500); };
/* Сохранить копию: «Поделиться» → Файлы/AirDrop/почта; запасной путь — буфер обмена. JSON готовится заранее,
   потому что iPhone разрешает «Поделиться» только сразу после касания. */
async function doBackup() {
  // Копия — всегда свежая: если после подготовки что-то изменилось, собираем заново
  // iPhone разрешает «Поделиться» только сразу после касания: свежую копию ждём не дольше 0,4 с,
  // иначе берём подготовленную (она отстаёт максимум на минуты) — и сразу готовим новую
  let json = backupCache && backupVer === dataVersion() ? backupCache : "";
  if (!json) {
    const fresh = exportAll().then(o => JSON.stringify(o));
    json = backupCache ? await Promise.race([fresh, new Promise(r => setTimeout(() => r(backupCache), 400))]) : await fresh;
  }
  prepBackup();
  const name = "dmitriy-backup-" + todayKey() + ".json";
  try {
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Копия Сумрака" }); backedUp(); return true; }
  } catch (e) { if (e && e.name === "AbortError") return false; }
  try { await navigator.clipboard.writeText(json); backedUp(); toast("Копия скопирована. Сохрани её в Заметки iPhone.", 3500); return true; }
  catch { setTab("set"); $("#restoreBox").hidden = false; $("#restoreText").value = json; $("#restoreText").select(); toast("Выдели и скопируй текст вручную."); return false; }
}
$("#backup").onclick = () => doBackup();
/* Раз в неделю напомнить о копии, если есть что терять (всё хранится только на телефоне). */
function backupWorth() { return activeFacts().length >= 5 || D.docs.length > 0 || D.skills.length > 0 || D.msgs.length >= 40; }
function offerBackup() {
  if (!backupWorth() || Date.now() - (D.meta.lastBackup || Math.min(D.meta.firstSeen || Date.now(), (D.msgs[0] && D.msgs[0].ts) || Date.now())) < 7 * 864e5 || Date.now() - (D.meta.backupOffer || 0) < 3 * 864e5) return false;
  D.meta.backupOffer = Date.now(); persist(); prepBackup();
  const el = addMsg("ai", `Дмитрий Павлович, всё, что я о тебе знаю (${plural(activeFacts().length, "факт", "факта", "фактов")}, ${plural(D.docs.length, "материал", "материала", "материалов")}, навыки), хранится только на этом телефоне. ${D.meta.lastBackup ? "Последней копии больше недели." : "Копии ещё не было."} Сохрани её в «Файлы» — займёт секунду.`);
  const box = document.createElement("div"); box.className = "acts";
  box.append(pill("💾 Сохранить копию", async e => { if (await doBackup()) { e.target.textContent = "✓ Сохранено"; e.target.disabled = true; } }));
  el.append(box);
  return true;
}
$("#restoreBtn").onclick = () => { $("#restoreBox").hidden = !$("#restoreBox").hidden; };
async function restoreFrom(text) {
  try { await importAll(JSON.parse(text)); }
  catch { toast("Не получилось: копия повреждена. Данные не изменены."); return; }
  toast("Восстановлено.", 2000); $("#restoreBox").hidden = true;
  try { renderLists(); renderChat(); } catch {}
  ensureDocVecs().then(renderKnow).catch(() => {}); prepBackup();
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
  if (!v && !photo && !(focusDoc && focusDoc.fresh)) { if (busy) busy.abort(); else if (V.speaking()) { V.stopSpeaking(); syncSendBtn(); } return; }
  send(v);
});
function setTab(t) { if (t === "set") { if (backupVer !== dataVersion()) setTimeout(prepBackup, 400); fillSettings(); } document.body.dataset.tab = t; $$(".tabbar button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t))); if (t === "chat") { const c = $("#log .setup"); c ? c.scrollIntoView({ block: "start" }) : scrollDown(); } }
$(".tabbar").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
document.addEventListener("touchend", V.unlock, { once: true });
document.addEventListener("click", V.unlock, { once: true });

/* =================== Запуск =================== */
$("#ver").textContent = "версия " + VERSION;
setInterval(renderBrief, 6e4);
["touchmove", "wheel"].forEach(ev => $("#log").addEventListener(ev, () => { if (busy) userScrolled = true; }, { passive: true }));
setQuotaHandler(ok => toast(ok ? "Память телефона почти заполнена — я сократил старую переписку. Сделай резервную копию." : "Память телефона переполнена — последние изменения могли не сохраниться. Сделай копию и удали лишние материалы."));
renderProject(); fillSettings(); fillGeminiModels(); fillVoices(); renderLists(); renderChat(); setTab("chat");
if (S.talkOnOpen && anyBrain()) openTalk({ waitTap: true });
if (!D.meta.firstSeen) { D.meta.firstSeen = Date.now(); persist(); }
updateLocal().then(() => {
  if (offerVoice()) return;
  setTimeout(offerBackup, 1500);
});
function offerVoice() {
  // Нормальный мужской голос ещё не скачан — предложим один раз в несколько дней (после смены голоса — сразу)
  const switched = S.voiceSwitched; if (switched) { S.voiceSwitched = false; saveSettings(); }
  if (S.voiceMode !== "local" || V.localAvailable() || !anyBrain() || (!switched && Date.now() - (D.meta.voiceOffer || 0) < 3 * 864e5)) return false;
  D.meta.voiceOffer = Date.now(); persist();
  const el = addMsg("ai", switched
    ? "Дмитрий Павлович, я сменил себе голос на более низкий и спокойный — «Руслан». Скачай его один раз (около 60 МБ, лучше по Wi-Fi, VPN не нужен). Прежний голос можно вернуть в настройках."
    : "Дмитрий Павлович, хочешь, чтобы я говорил нормальным мужским голосом, а не роботом? Скачай голос один раз (около 90 МБ, лучше по Wi-Fi, VPN не нужен) — дальше он работает прямо на телефоне, бесплатно и без лимитов.");
  const box = document.createElement("div"); box.className = "acts";
  const out = document.createElement("div"); out.className = "small";
  box.append(pill("⬇️ Скачать голос", e => { V.unlock(); getLocalVoice(e.target, out); }));
  el.append(box, out);
  return true;
}
try { speechSynthesis.onvoiceschanged = fillVoices; } catch {}
V.onSpeakingChange(syncSendBtn);
setInterval(() => { checkReminders(); syncSendBtn(); }, 10000); checkReminders();
if (S.geminiKey) discoverGemini().then(fillGeminiModels).catch(() => {});
if (S.openrouterKey) discoverOpenRouter().catch(() => {});
document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkReminders(); V.audioCtx(); } else if (!talkOn) { micGen++; V.stopRecording(true); vbSet("idle"); idleStatus(); } });
// Любое касание экрана «будит» звук: iPhone разрешает играть звук только после касания
["touchend", "click"].forEach(ev => document.addEventListener(ev, () => V.unlock(), { capture: true, passive: true }));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.__dp = { D, S, send, addToCalendar };   // для отладки
