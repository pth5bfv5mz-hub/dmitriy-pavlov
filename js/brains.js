/* «Мозги» Дмитрия: несколько нейросетей с автоматическим переключением.
   Gemini — самый умный (поиск Google, голос, распознавание речи, эмбеддинги), но из России только через VPN.
   Mistral и Z.ai — работают из России без VPN; для них поиск и погода сделаны инструментами. */
import { S, D, persist } from "./store.js";
import { sleep, todayKey, neutralize } from "./util.js";

export const BRAINS = {
  gemini: { name: "Gemini", needs: "geminiKey" },
  mistral: { name: "Mistral", needs: "mistralKey" },
  zai: { name: "Z.ai GLM", needs: "zaiKey" },
  openrouter: { name: "OpenRouter", needs: "openrouterKey" },
  claude: { name: "Claude", needs: "claudeKey" },
  custom: { name: "Своя нейросеть", needs: "customKey" },
};
const has = b => !!(S[BRAINS[b].needs] || "").trim() && (b !== "custom" || (S.customBase && S.customModel));
export const configured = () => Object.keys(BRAINS).filter(has);
export const anyBrain = () => configured().length > 0;

// Если Gemini не пустил (страна) — несколько минут не пробуем его первым.
const blockedUntil = {};
export const isBlocked = b => (blockedUntil[b] || 0) > Date.now();
export function order(fresh) {
  const list = configured();
  if (S.brain !== "auto" && list.includes(S.brain)) return [S.brain, ...list.filter(b => b !== S.brain)];
  // Обычный разговор — сначала мозги с большим объёмом (у Gemini бесплатных ответов всего несколько десятков в день);
  // вопрос про свежее — сначала Gemini: у него поиск Google.
  const pref = (fresh ? ["claude", "gemini", "mistral", "openrouter", "zai", "custom"] : ["claude", "mistral", "openrouter", "gemini", "zai", "custom"]).filter(b => list.includes(b));
  const late = b => isBlocked(b) || (b === "gemini" && geminiSpent());
  return [...pref.filter(b => !late(b)), ...pref.filter(late)];
}

/* ---------- Ошибки ---------- */
export class BrainError extends Error {
  constructor(msg, status, brain) { super(msg); this.status = status; this.brain = brain; }
}
async function httpError(res, brain) {
  let msg = "", details = [];
  try { const j = await res.json(); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && (e.message || e.type)) || j.message || j.detail || JSON.stringify(j).slice(0, 300); details = (e && e.details) || []; } catch {}
  const err = new BrainError(String(msg || "HTTP " + res.status), res.status, brain);
  // Через сколько можно повторить (Google: RetryInfo / «retry in 23s»; Mistral и др.: заголовок Retry-After)
  const ri = details.find(d => d.retryDelay), ra = +(res.headers.get("retry-after") || 0);
  const sec = ri ? parseFloat(ri.retryDelay) : ra || parseFloat((msg.match(/retry in ([\d.]+)\s*s/i) || [])[1]);
  if (sec > 0) err.retryMs = Math.ceil(sec * 1000);
  // Дневной лимит, а не минутный
  err.daily = details.some(d => (d.violations || []).some(v => /PerDay/i.test(v.quotaId || ""))) || /per.?day|daily|PerDay/i.test(msg);
  throw err;
}
/* Бесплатные лимиты Google обновляются в полночь по Калифорнии (~10:00 по Москве). */
export function quotaReset() {
  const d = new Date(); d.setUTCHours(8, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}
const isDaily = e => e && e.status === 429 && (e.daily || /per.?day|daily|PerDay/i.test(e.message || ""));
export const isLocationErr = e => /location is not supported|User location|unsupported_country|not available in your (country|region)/i.test(String(e && e.message));
const isKeyErr = e => e && (e.status === 401 || /API key not valid|API_KEY_INVALID|invalid api key|Unauthorized/i.test(e.message || ""));
export function explain(e) {
  const m = String(e && e.message || ""), s = e && e.status, b = e && e.brain, who = b ? BRAINS[b]?.name || b : "Нейросеть";
  const other = b === "gemini" ? "без VPN поможет Mistral или Z.ai" : "с VPN поможет Gemini";
  if (e && e.name === "AbortError") return "Остановлено.";
  if (isLocationErr(e)) return "Gemini не пускает из России. Включи VPN (США или Европа) — или подключи Mistral/Z.ai во вкладке «Настройки», они работают без VPN.";
  if (isKeyErr(e)) return `${who}: ключ не подходит. Проверь его во вкладке «Настройки».`;
  if (s === 403) return `${who}: доступ запрещён. ${m.slice(0, 140)}`;
  if (s === 429 && /limit:\s*0\b/i.test(m)) return `${who}: бесплатному ключу не положены доступные модели (лимит 0). Подключи другой мозг (${other}) в «Настройках» — или открой «Подробности» ниже и пришли мне.`;
  if (isDaily(e)) return `${who}: дневной бесплатный лимит исчерпан${b === "gemini" ? ", обновится около " + new Date(quotaReset()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : ""}. ${b === "gemini" ? "Пока отвечаю запасными моделями." : "Подключи другой мозг (" + other + ") в «Настройках»."}`;
  if (s === 429) return `${who}: просит подождать (лимит запросов в минуту). Повтори через минуту, или подключи другой мозг (${other}) в «Настройках».`;
  if (s >= 500) return `${who} сейчас перегружен. Повтори через минуту.`;
  if (e && e.name === "TypeError") return "Нет связи с нейросетью. Проверь интернет. Для Gemini нужен включённый VPN.";
  return `${who}: не получилось. ${m.slice(0, 200)}`;
}

/* ---------- Поток SSE ---------- */
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
    let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); handle(line); }
  }
  if (buf.trim()) handle(buf.trim());
}

/* =====================================================================
   GEMINI
   ===================================================================== */
const G = "https://generativelanguage.googleapis.com/v1beta";
// Ключ — в заголовке, а не в адресе: адреса оседают в журналах и истории
export const gHeaders = (extra = {}) => ({ "x-goog-api-key": S.geminiKey.trim(), ...extra });
// Модели с бесплатной квотой у новых ключей (октябрь 2026). Новейшие (3.x) и псевдонимы *-latest
// дают новым ключам лимит 0, поэтому их НЕ ставим вперёд — сначала проверенно-бесплатные 2.x.
const FREE_CHAT = ["gemini-2.5-flash", "gemini-2.0-flash"];
const FREE_LITE = ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];
const STATIC = {
  chat: [...FREE_CHAT, "gemini-flash-latest"],
  deep: ["gemini-2.5-pro", "gemini-pro-latest"],
  lite: [...FREE_LITE, "gemini-flash-lite-latest"],
  tts: ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts", "gemini-3.8-flash-tts"],
  embed: ["gemini-embedding-001", "gemini-embedding-2"],
  // Открытые модели Google (Gemma) в том же ключе: свой, гораздо больший бесплатный лимит (тысячи запросов в день).
  // Без поиска и без «системной» инструкции — её кладём в начало вопроса.
  gemma: ["gemma-3-27b-it", "gemma-3-12b-it"],
};
const isGemma = id => /^gemma/.test(id);
const ver = n => (n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
const byVer = (a, b) => ver(b) - ver(a) || a.length - b.length;
// Для бесплатного ключа ставим вперёд проверенно-бесплатные модели, новейшие — в конец.
const freeFirst = (ids, free) => [...free.filter(id => ids.includes(id)), ...ids.filter(id => !free.includes(id) && !/latest/.test(id)), ...ids.filter(id => /latest/.test(id))];
/* Спрашиваем у Google, какие модели доступны этому ключу, и раскладываем по ролям.
   Так Дмитрий не сломается, когда Google переименует модели. */
export async function discoverGemini(force) {
  const cached = D.meta.models;
  if (!force && cached && Date.now() - cached.at < 3 * 864e5 && cached.chat?.length) return cached;
  try {
    const res = await fetch(`${G}/models?pageSize=1000`, { headers: gHeaders() });
    if (!res.ok) await httpError(res, "gemini");
    const j = await res.json();
    const all = (j.models || []).map(m => ({ id: m.name.replace(/^models\//, ""), methods: m.supportedGenerationMethods || [] }));
    const gen = all.filter(m => m.methods.includes("generateContent") && /^gemini/.test(m.id));
    const plainText = m => !/tts|image|live|audio|embedding|robotics|computer|native|exp|learnlm|nano|veo|imagen|aqa|vision|thinking/i.test(m.id);
    const pick = (re, alias) => {
      const ids = gen.filter(plainText).map(m => m.id).filter(id => re.test(id));
      const stable = ids.filter(id => !/preview/.test(id)).sort(byVer), prev = ids.filter(id => /preview/.test(id)).sort(byVer);
      return [...ids.filter(id => id === alias), ...stable.filter(id => id !== alias), ...prev];
    };
    const models = {
      at: Date.now(),
      chat: freeFirst(pick(/flash(?!-lite)/, "gemini-flash-latest"), FREE_CHAT),
      deep: pick(/pro/, "gemini-pro-latest"),   // «Глубже» — пусть берёт лучшую (с billing); на free упадёт на flash
      lite: freeFirst(pick(/flash-lite/, "gemini-flash-lite-latest"), FREE_LITE),
      tts: gen.filter(m => /tts/.test(m.id)).map(m => m.id).sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (/preview/.test(a) - /preview/.test(b)) || byVer(a, b)),
      embed: all.filter(m => m.methods.includes("embedContent") && /embedding/.test(m.id)).map(m => m.id).sort((a, b) => (b === "gemini-embedding-001") - (a === "gemini-embedding-001")),
      // Gemma: самая крупная текстовая модель «-it» первой (gemma-4-…, gemma-3-27b-it, …)
      gemma: all.filter(m => m.methods.includes("generateContent") && /^gemma-\d+(\.\d+)?-\d+b-it$/.test(m.id)).map(m => m.id)
        .sort((a, b) => ver(b) - ver(a) || parseInt(b.split("-")[2]) - parseInt(a.split("-")[2])),
    };
    if (!models.gemma.length) models.gemma = STATIC.gemma;
    // Проверенно-бесплатные модели держим в списке даже если их нет в ответе — вдруг ключу они доступны
    FREE_CHAT.forEach(id => { if (!models.chat.includes(id)) models.chat.push(id); });
    FREE_LITE.forEach(id => { if (!models.lite.includes(id)) models.lite.push(id); });
    models.chat = freeFirst(models.chat, FREE_CHAT);
    models.lite = freeFirst(models.lite, FREE_LITE);
    if (!models.chat.length) models.chat = STATIC.chat;
    D.meta.models = models; persist();
    return models;
  } catch (e) {
    if (isLocationErr(e)) { blockedUntil.gemini = Date.now() + 5 * 6e4; throw e; }
    if (isKeyErr(e)) throw e;
    return cached || { at: 0, ...STATIC };
  }
}
/* Модели, к которым у бесплатного ключа нет доступа (лимит 0) или которых нет, — пропускаем сутки. */
const dead = () => (D.meta.deadModels = D.meta.deadModels || {});
const isDead = id => (dead()[id] || 0) > Date.now();
function markDead(id, e) {
  const m = String(e && e.message || "");
  if (e && e.status === 404) dead()[id] = Date.now() + 7 * 864e5;
  else if (e && e.status === 429 && /limit:\s*0\b|free.?tier.*not|not available.*free/i.test(m)) dead()[id] = Date.now() + 864e5;
  else if (isDaily(e)) dead()[id] = quotaReset();                       // дневной лимит — не тратим время до обновления
  else if (e && e.status === 429) dead()[id] = Date.now() + Math.min(65e3, e.retryMs || 65e3);   // минутный — пробуем другие, к этой вернёмся позже
  else return;
  persist();
}
async function gModels(kind) {
  const m = await discoverGemini();
  const pref = S.geminiModel && S.geminiModel !== "auto" && (kind === "chat" || kind === "deep") ? [S.geminiModel] : [];
  const get = k => (m[k] && m[k].length ? m[k] : STATIC[k]);
  // Для ответа: обычные модели, а за ними облегчённые — у них самые щедрые бесплатные лимиты
  const list = kind === "deep" ? [...get("deep"), ...get("chat"), ...get("lite"), ...get("gemma").slice(0, 2)]
    : kind === "chat" ? [...get("chat"), ...get("lite"), ...get("gemma").slice(0, 2)]
    : kind === "bg" ? [...get("gemma").slice(0, 2), ...get("lite"), ...get("chat")]   // фоновая работа памяти — сначала Gemma, бережём лимит ответов
    : get(kind);
  const all = [...new Set([...pref, ...list])];
  const alive = all.filter(id => !isDead(id));
  return (alive.length ? alive : all).slice(0, 10);
}
/* Все модели Gemini на сегодня исчерпаны — тогда первым отвечает другой мозг. */
export function geminiSpent() {
  const m = D.meta.models; if (!m) return false;
  const ids = [...(m.chat || []), ...(m.lite || []), ...(m.gemma || STATIC.gemma).slice(0, 2)];
  return ids.length > 0 && ids.every(isDead);
}
const gRetriable = e => !isLocationErr(e) && !isKeyErr(e) && e.name !== "AbortError" && [400, 403, 404, 429, 500, 502, 503, 504].includes(e.status);

function gContents(hist, img) {
  const out = [];
  hist.forEach(h => {
    const role = h.role === "user" ? "user" : "model";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts[0].text += "\n\n" + h.text;
    else out.push({ role, parts: [{ text: h.text }] });
  });
  if (img && out.length) out[out.length - 1].parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
  return out;
}
async function gStream(model, body, onText, signal) {
  const res = await fetch(`${G}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    { method: "POST", headers: gHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body), signal });
  if (!res.ok) await httpError(res, "gemini");
  let text = "", blocked = ""; const sources = [];
  await readSSE(res, ev => {
    if (ev.error) throw new BrainError(ev.error.message || "Ошибка Gemini", ev.error.code, "gemini");
    if (ev.promptFeedback && ev.promptFeedback.blockReason) blocked = ev.promptFeedback.blockReason;
    const c = ev.candidates && ev.candidates[0]; if (!c) return;
    ((c.content && c.content.parts) || []).forEach(p => { if (p.text && !p.thought) { text += p.text; onText(text); } });
    const g = c.groundingMetadata;
    if (g && g.groundingChunks) g.groundingChunks.forEach(ch => { if (ch.web && ch.web.uri && !sources.some(s => s.url === ch.web.uri)) sources.push({ url: ch.web.uri, title: ch.web.title || "" }); });
  }, signal);
  if (!text && blocked) text = "На это я ответить не могу — запрос заблокирован фильтром Google. Сформулируй иначе.";
  if (!text) throw new BrainError("Пустой ответ", 503, "gemini");
  return { text, sources, model };
}
let searchOffUntil = 0;   // кончился отдельный бесплатный лимит поиска Google — отвечаем без поиска
let thinkOff = true;      // отключать «раздумья» 2.5-flash ради скорости (если модель это поддерживает)
// Поиск Google у бесплатного ключа — крошечная отдельная квота (~500/день, только на 2.5-flash).
// Поэтому включаем его ТОЛЬКО когда вопрос явно про свежее/внешнее, а не на каждый «привет».
const FRESH_RE = /новост|сейчас|сегодня|завтра|вчера|текущ|погод|курс|котировк|цен[аыу]|сколько стоит|стоит ли|прогноз|расписан|когда (выйд|будет|состо|начн|откро)|последн|актуальн|свеж|нынешн|202[4-9]|203\d|кто (сейчас|выиграл|победил|президент|глава)|результат|счёт матч|кто такой|что такое|where|погугли|найди|поищи|в интернете|ссылк|http/i;
async function chatGemini({ system, hist, img, onText, signal, deep, wantSearch }) {
  const base = { system_instruction: { parts: [{ text: system }] }, contents: gContents(hist, img), generationConfig: { temperature: deep ? 0.3 : 0.45 } };
  let last; const tried = [];
  const lastUser = [...hist].reverse().find(h => h.role === "user");
  const wantNet = !img && (wantSearch || FRESH_RE.test(lastUser ? lastUser.text : ""));
  const needSearch = wantNet && Date.now() > searchOffUntil;
  // Лимит поиска Google кончился — не отвечаем вслепую: подкладываем найденное запасным поиском (Tavily/Википедия, ссылки, погода)
  let extra = null;
  const backup = async () => { if (!extra) extra = netContext(lastUser ? lastUser.text : "").catch(() => ({ text: "", sources: [] })); return extra; };
  // При любом отказе с поиском сразу отвечаем той же моделью без поиска, а не долбим квоту.
  // Чтение страниц (url_context) — только когда Сумрак сам прислал ссылку: иначе подброшенная в поиске
  // инструкция могла бы заставить «открыть» чужой адрес с его данными в строке запроса.
  const userLink = /https?:\/\//i.test(lastUser ? lastUser.text : "");
  const toolSets = needSearch ? [[{ google_search: {} }, ...(userLink ? [{ url_context: {} }] : [])], undefined] : [undefined];
  for (const model of await gModels(deep ? "deep" : "chat")) {
    const sets = isGemma(model) ? [undefined] : toolSets;   // у Gemma нет поиска Google
    for (let ti = 0; ti < sets.length; ti++) {
      const tools = sets[ti];
      // Быстрый ответ: у 2.5-flash отключаем «раздумья» перед ответом (кроме режима «Глубже») — это секунды экономии
      const think = !deep && thinkOff && /^gemini-2\.5-flash/.test(model);
      const net = !tools && wantNet ? await backup() : null;
      const sysText = net && net.text ? system + "\n\nНАЙДЕНО В ИНТЕРНЕТЕ (запасной поиск, опирайся на это и называй источник):\n" + net.text : system;
      let body = { ...base, system_instruction: { parts: [{ text: sysText }] }, generationConfig: { ...base.generationConfig, ...(think ? { thinkingConfig: { thinkingBudget: 0 } } : {}) }, ...(tools ? { tools } : {}) };
      if (isGemma(model)) {   // у Gemma нет системной инструкции — кладём её в начало разговора
        const contents = JSON.parse(JSON.stringify(base.contents));
        contents[0].parts[0].text = "ИНСТРУКЦИЯ (кто ты и как отвечать):\n" + sysText + "\n\n---\n\n" + contents[0].parts[0].text;
        body = { contents, generationConfig: base.generationConfig };
      }
      try {
        const r = await gStream(model, body, onText, signal); r.noSearch = !tools; r.netTried = !!net;
        if (net && net.text) { r.sources = [...(r.sources || []), ...net.sources]; r.noSearch = false; }
        return r;
      }
      catch (e) {
        last = e;
        if (think && e.status === 400 && /thinking/i.test(e.message || "")) { thinkOff = false; ti--; continue; }   // модель не знает этот параметр — повтор без него
        // Любой сбой с инструментами поиска — не мучаем квоту поиска, отвечаем без него
        if (tools && (e.status === 429 || e.status === 400 || e.status >= 500)) { if (e.status === 429) searchOffUntil = Date.now() + 36e5; continue; }
        break;   // без инструментов — это уже проблема самой модели
      }
    }
    tried.push(`${model}: ${last.status || ""} ${String(last.message || "").slice(0, 160)}`);
    markDead(model, last);
    if (isLocationErr(last)) { blockedUntil.gemini = Date.now() + 5 * 6e4; throw last; }
    if (!gRetriable(last)) throw last;
  }
  if (last) last.tried = tried;
  throw last;
}
async function plainGemini(system, prompt, { json } = {}) {
  let last;
  for (const model of (await gModels("bg")).slice(0, 6)) {
    try {
      const g = isGemma(model);
      const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: gHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(g ? { contents: [{ role: "user", parts: [{ text: system + "\n\n" + prompt }] }], generationConfig: { temperature: 0.2 } }
          : { system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: "application/json" } : {}) } }),
      });
      if (!res.ok) await httpError(res, "gemini");
      const j = await res.json();
      return ((j.candidates?.[0]?.content?.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    } catch (e) { last = e; markDead(model, e); if (!gRetriable(e)) throw e; }
  }
  throw last;
}
export async function embedGemini(texts, task) {
  const models = await gModels("embed");
  let last;
  for (const model of models) {
    try {
      const out = [];
      for (let i = 0; i < texts.length; i += 90) {
        const batch = texts.slice(i, i + 90);
        const res = await fetch(`${G}/models/${model}:batchEmbedContents`, {
          method: "POST", headers: gHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ requests: batch.map(t => ({ model: "models/" + model, content: { parts: [{ text: t.slice(0, 7000) }] }, taskType: task, outputDimensionality: 768 })) }),
        });
        if (!res.ok) await httpError(res, "gemini");
        const j = await res.json();
        (j.embeddings || []).forEach(e => out.push(normalize(e.values || [])));
      }
      return { model, vecs: out };
    } catch (e) { last = e; if (!gRetriable(e)) throw e; }
  }
  throw last;
}
function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, x => x / n); }

async function transcribeGemini(b64, mime) {
  let last;
  for (const model of [...await gModels("lite"), ...await gModels("chat")].slice(0, 4)) {
    for (const m of [mime, "audio/aac", "audio/mp4"].filter((x, i, a) => x && a.indexOf(x) === i)) {
      try {
        const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", headers: gHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ contents: [{ role: "user", parts: [
            { text: "Распознай речь на записи дословно. Язык обычно русский. Верни только распознанный текст без кавычек и пояснений. Если речи нет — верни пустую строку." },
            { inline_data: { mime_type: m, data: b64 } }] }], generationConfig: { temperature: 0, ...(/^gemini-2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }),
        });
        if (!res.ok) await httpError(res, "gemini");
        const j = await res.json();
        return ((j.candidates?.[0]?.content?.parts) || []).map(p => p.text || "").join("").trim();
      } catch (e) { last = e; if (e.status === 400 && /mime|audio|format|unsupported/i.test(e.message || "")) continue; break; }
    }
    markDead(model, last);
    if (!gRetriable(last)) throw last;
  }
  throw last;
}
/* Живой голос Gemini. Ответ — WAV или «сырой» PCM 24 кГц; возвращаем то, что пришло. */
export async function ttsGemini(text, voice) {
  let last;
  for (const model of (await gModels("tts")).slice(0, 3)) {
    try {
      const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: gHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Charon" } } } } }),
      });
      if (!res.ok) await httpError(res, "gemini");
      const j = await res.json();
      const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
      const d = part && (part.inlineData || part.inline_data);
      if (!d || !d.data) throw new BrainError("Нет звука в ответе", 503, "gemini");
      return { mime: d.mimeType || d.mime_type || "audio/L16;rate=24000", b64: d.data };
    } catch (e) { last = e; if (!gRetriable(e)) throw e; }
  }
  throw last;
}

/* =====================================================================
   СОВМЕСТИМЫЕ С OPENAI: Mistral, Z.ai, своя
   ===================================================================== */
const COMPAT = {
  mistral: () => ({ url: "https://api.mistral.ai/v1/chat/completions", key: S.mistralKey, model: S.mistralModel || "mistral-medium-latest", vision: S.mistralModel || "mistral-medium-latest", lite: "mistral-small-latest",
    spare: ["mistral-small-latest", "ministral-8b-latest", "open-mistral-nemo"] }),
  zai: () => ({ url: "https://api.z.ai/api/paas/v4/chat/completions", key: S.zaiKey, model: S.zaiModel || "glm-4.7-flash", vision: "glm-4.6v-flash", lite: S.zaiModel || "glm-4.7-flash" }),
  openrouter: () => {
    const free = (D.meta.orFree && D.meta.orFree.ids) || OR_FREE;
    const main = S.openrouterModel && S.openrouterModel !== "auto" ? S.openrouterModel : free[0];
    return { url: "https://openrouter.ai/api/v1/chat/completions", key: S.openrouterKey, model: main, vision: main, lite: free[0], spare: free.slice(0, 5),
      headers: { "HTTP-Referer": "https://pth5bfv5mz-hub.github.io/dmitriy-pavlov/", "X-Title": "Dmitriy Pavlov" } };
  },
  custom: () => ({ url: S.customBase.trim().replace(/\/+$/, "") + "/chat/completions", key: S.customKey, model: S.customModel, vision: S.customModel, lite: S.customModel }),
};
/* Бесплатные модели OpenRouter: спрашиваем список у сервиса (раз в 3 дня), сильные — вперёд. */
const OR_FREE = ["deepseek/deepseek-chat-v3-0324:free", "qwen/qwen3-235b-a22b:free", "meta-llama/llama-4-maverick:free", "google/gemma-3-27b-it:free", "mistralai/mistral-small-3.2-24b-instruct:free"];
const OR_PREF = [/deepseek.*(chat|v3)/i, /qwen3.*(235|coder|max)/i, /deepseek.*r1/i, /llama-4/i, /gpt-oss/i, /qwen/i, /gemma/i, /mistral/i, /glm/i];
export async function discoverOpenRouter(force) {
  const c = D.meta.orFree;
  if (!force && c && Date.now() - c.at < 3 * 864e5 && c.ids?.length) return c.ids;
  try {
    const j = await getJSON("https://openrouter.ai/api/v1/models");
    const ids = (j.data || []).filter(m => /:free$/.test(m.id) && (m.context_length || 0) >= 32000 && !/vision|image|audio|embed|guard/i.test(m.id)).map(m => m.id)
      .sort((a, b) => { const r = id => { const i = OR_PREF.findIndex(re => re.test(id)); return i < 0 ? 99 : i; }; return r(a) - r(b); });
    if (ids.length) { D.meta.orFree = { at: Date.now(), ids: ids.slice(0, 12) }; persist(); return D.meta.orFree.ids; }
  } catch {}
  return (c && c.ids) || OR_FREE;
}
const TOOLS = [
  { type: "function", function: { name: "web_search", description: "Поиск в интернете: новости, цены, факты, события, люди, расписания. Возвращает выдержки и ссылки. Вызывай для всего, что могло измениться или в чём ты не уверен.", parameters: { type: "object", properties: { query: { type: "string", description: "поисковый запрос" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_url", description: "Прочитать страницу по ссылке и вернуть её текст.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "get_weather", description: "Текущая погода и прогноз на 3 дня для города.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
];
async function getJSON(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
async function toolWebSearch(q, sources) {
  if (S.tavilyKey) {
    try {
      const j = await getJSON("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + S.tavilyKey.trim() },
        body: JSON.stringify({ query: q, max_results: 5, include_answer: true, search_depth: "basic" }) });
      (j.results || []).forEach(r => sources.push({ url: r.url, title: r.title }));
      return { answer: j.answer, results: (j.results || []).map(r => ({ title: r.title, url: r.url, text: (r.content || "").slice(0, 1200) })) };
    } catch {}
  }
  const out = [];
  for (const lang of ["ru", "en"]) {
    try {
      const s = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`);
      const titles = (s.query?.search || []).map(x => x.title); if (!titles.length) continue;
      const e = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=1200&titles=${encodeURIComponent(titles.join("|"))}&format=json&origin=*`);
      Object.values(e.query?.pages || {}).forEach(p => {
        const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
        out.push({ title: p.title, url, text: p.extract || "" }); sources.push({ url, title: p.title });
      });
      if (out.length) break;
    } catch {}
  }
  return out.length ? { note: S.tavilyKey ? "" : "Поиск только по Википедии (для полного поиска нужен ключ Tavily в настройках). Свежих новостей и цен здесь нет.", results: out } : "Ничего не найдено.";
}
/* Запасной доступ в интернет без Google: ссылки из вопроса читаем, погоду берём с Open-Meteo, остальное — поиск. */
const WEATHER_RE = /погод[аеуы]?\s+(?:в|во)\s+([А-ЯЁA-Z][\p{L}-]+(?:[ -][А-ЯЁA-Z][\p{L}-]+)?)/u;
async function netContext(q) {
  const sources = []; const parts = [];
  const urls = (q.match(/https?:\/\/\S+/g) || []).slice(0, 2);
  for (const u of urls) { try { parts.push(`Страница ${u}:\n` + (await readUrl(u)).slice(0, 6000)); sources.push({ url: u, title: "" }); } catch {} }
  const w = q.match(WEATHER_RE);
  if (w) { try { const r = await toolWeather(w[1]); if (typeof r === "object") { parts.push("Погода: " + JSON.stringify(r)); sources.push({ url: "https://open-meteo.com", title: "Open-Meteo (погода)" }); } } catch {} }
  if (!urls.length && !w) {
    const r = await toolWebSearch(q.replace(/[?!.]+$/, "").slice(0, 200), sources);
    if (typeof r === "object") parts.push(JSON.stringify(r).slice(0, 7000));
  }
  return { text: neutralize(parts.join("\n\n")), sources };
}
export async function readUrl(url) {
  const r = await fetch("https://r.jina.ai/" + url, { headers: { "Accept": "text/plain" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.text()).slice(0, 15000);
}
async function toolWeather(city) {
  const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`);
  const p = g.results && g.results[0]; if (!p) return "Город не найден.";
  const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3`);
  return { place: `${p.name}${p.country ? ", " + p.country : ""}`, current: w.current, daily: w.daily, note: "weather_code по WMO: 0 ясно, 1-3 облачно, 45-48 туман, 51-67 дождь, 71-77 снег, 80-82 ливни, 95-99 гроза" };
}
async function runTool(call, sources, allowed = new Set()) {
  let a = {}; try { a = JSON.parse(call.function.arguments || "{}"); } catch {}
  try {
    if (call.function.name === "get_weather") { sources.push({ url: "https://open-meteo.com", title: "Open-Meteo (погода)" }); return await toolWeather(String(a.city || "")); }
    if (call.function.name === "read_url") {
      const url = String(a.url || "");
      // Открываем только ссылки от Сумрака или из найденного поиском — не те, что «подсказала» страница
      if (![...allowed, ...sources.map(x => x.url)].some(u => u && (url === u || url.startsWith(u.replace(/[#?].*$/, ""))))) return "Эту ссылку открыть нельзя: открываю только ссылки из сообщения Сумрака или из результатов поиска.";
      const t = await readUrl(url); sources.push({ url, title: "" }); return t;
    }
    return await toolWebSearch(String(a.query || ""), sources);
  } catch (e) { return "Ошибка инструмента: " + e.message; }
}
// Mistral и Z.ai на бесплатном плане: 1 запрос в секунду. Разносим вызовы, чтобы не ловить 429.
const lastCall = {};
async function spacedFetch(brain, url, opts, signal, retries = 1) {
  const gap = 1100, since = Date.now() - (lastCall[brain] || 0);
  if (since < gap) await sleep(gap - since);
  for (let attempt = 0; attempt <= retries; attempt++) {
    lastCall[brain] = Date.now();
    const res = await fetch(url, opts);
    if (res.status === 429 && attempt < retries) {   // одна короткая повторная попытка; дальше — другая модель
      const ra = +(res.headers.get("retry-after") || 0);
      await sleep(Math.min(3000, ra ? ra * 1000 : 1500));
      if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
      continue;
    }
    return res;
  }
}
const noTools = new Set();
async function chatCompat(brain, { system, hist, img, onText, onStatus, signal }) {
  const c = COMPAT[brain]();
  const messages = [{ role: "system", content: system }, ...hist.map(h => ({ role: h.role, content: h.text }))];
  if (img) { const last = messages[messages.length - 1]; last.content = [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: img.url } }]; }
  const sources = [];
  const lastUserText = [...hist].reverse().find(h => h.role === "user")?.text || "";
  const allowed = new Set(lastUserText.match(/https?:\/\/[^\s<>"')]+/g) || []);
  // Запасные модели того же сервиса: у каждой своя очередь и свой лимит
  const models = [...new Set([img ? c.vision : c.model, ...(img ? [] : c.spare || [])])].filter(Boolean).slice(0, 3);
  let mi = 0;
  for (let round = 0; round < 5; round++) {
    const body = { model: models[mi], messages, temperature: 0.4, stream: true };   // поток: текст появляется сразу
    if (round < 4) body.tools = TOOLS;
    if (noTools.has(body.model)) delete body.tools;
    const res = await spacedFetch(brain, c.url, { method: "POST", signal, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key.trim(), ...(c.headers || {}) }, body: JSON.stringify(body) }, signal, 0);
    // Модель не умеет инструменты (бывает у бесплатных моделей OpenRouter) — та же модель без них
    if (!res.ok && body.tools && (res.status === 400 || res.status === 404)) {
      const t = await res.clone().text().catch(() => "");
      if (/tool/i.test(t)) { noTools.add(body.model); round--; continue; }
    }
    if (!res.ok && (res.status === 429 || res.status >= 500 || (brain === "openrouter" && res.status === 404)) && mi < models.length - 1) { mi++; round--; continue; }
    if (!res.ok) await httpError(res, brain);
    const m = /event-stream/i.test(res.headers.get("content-type") || "") ? await readCompatStream(res, onText, signal) : (await res.json()).choices?.[0]?.message;
    if (!m || (!m.content && !(m.tool_calls && m.tool_calls.length))) throw new BrainError("Пустой ответ", 503, brain);
    if (m.tool_calls && m.tool_calls.length) {
      messages.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls });
      (onStatus || onText)(m.tool_calls.some(t => t.function.name === "web_search") ? "Ищу в интернете…" : "Смотрю…");
      for (const call of m.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: neutralize(JSON.stringify(await runTool(call, sources, allowed))).slice(0, 14000) });
      continue;
    }
    const text = typeof m.content === "string" ? m.content : (m.content || []).map(p => p.text || "").join("");
    onText(text);
    return { text, sources, model: body.model };
  }
  throw new BrainError("Слишком много шагов поиска", 500, brain);
}
/* Поток в формате OpenAI: текст — кусками в delta.content, вызовы инструментов — частями в delta.tool_calls
   (склеиваем по index, а если его нет — по id или порядку). */
async function readCompatStream(res, onText, signal) {
  let text = ""; const calls = [];
  await readSSE(res, ev => {
    if (ev.error) throw new BrainError(ev.error.message || "Ошибка", ev.error.code || 500, "");
    const d = ev.choices && ev.choices[0] && (ev.choices[0].delta || ev.choices[0].message); if (!d) return;
    if (d.content) {
      text += typeof d.content === "string" ? d.content : (Array.isArray(d.content) ? d.content.map(p => p.text || "").join("") : "");
      if (!calls.length) onText(text);
    }
    (d.tool_calls || []).forEach((tc, k) => {
      let i = Number.isInteger(tc.index) ? tc.index : tc.id ? calls.findIndex(c => c && c.id === tc.id) : -1;
      if (i < 0) i = tc.id || !calls.length ? calls.length : calls.length - 1;
      const c = calls[i] || (calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) c.id = tc.id;
      if (tc.function && tc.function.name) c.function.name = c.function.name || tc.function.name;
      if (tc.function && tc.function.arguments != null) c.function.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    });
  }, signal);
  const tool_calls = calls.filter(c => c && c.function.name).map((c, i) => ({ ...c, id: c.id || "call_" + i }));
  return { content: text, tool_calls };
}
async function plainCompat(brain, system, prompt) {
  const c = COMPAT[brain]();
  const res = await spacedFetch(brain, c.url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key.trim(), ...(c.headers || {}) },
    body: JSON.stringify({ model: c.lite, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
  if (!res.ok) await httpError(res, brain);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}
async function transcribeMistral(blob) {
  const send = withLang => {
    const fd = new FormData();
    fd.append("model", "voxtral-mini-latest");
    fd.append("file", blob, "speech." + (blob.type.includes("webm") ? "webm" : blob.type.includes("wav") ? "wav" : "m4a"));
    if (withLang) fd.append("language", "ru");   // язык известен заранее — распознаёт точнее
    return fetch("https://api.mistral.ai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": "Bearer " + S.mistralKey.trim() }, body: fd });
  };
  let res = await send(true);
  if (res.status === 400 || res.status === 422) res = await send(false);   // параметр языка не приняли — без него
  if (!res.ok) await httpError(res, "mistral");
  return ((await res.json()).text || "").trim();
}

/* =====================================================================
   CLAUDE
   ===================================================================== */
const cHeaders = () => ({ "content-type": "application/json", "x-api-key": S.claudeKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
function cMessages(hist, img) {
  const out = [];
  hist.forEach(h => { if (out.length && out[out.length - 1].role === h.role) out[out.length - 1].content += "\n\n" + h.text; else out.push({ role: h.role, content: h.text }); });
  while (out.length && out[0].role !== "user") out.shift();
  if (img && out.length) { const l = out[out.length - 1]; l.content = [{ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } }, { type: "text", text: l.content }]; }
  return out;
}
async function chatClaude({ system, hist, img, onText, signal }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal, headers: cHeaders(),
    body: JSON.stringify({ model: S.claudeModel || "claude-sonnet-5-5", max_tokens: 4096, system, messages: cMessages(hist, img), stream: true,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }) });
  if (!res.ok) await httpError(res, "claude");
  let text = ""; const sources = [];
  await readSSE(res, ev => {
    if (ev.type === "content_block_start" && ev.content_block?.type === "text" && text && !/\s$/.test(text)) text += " ";
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; onText(text); }
    if (ev.type === "content_block_start" && ev.content_block?.type === "web_search_tool_result" && Array.isArray(ev.content_block.content))
      ev.content_block.content.forEach(r => { if (r.url && !sources.some(s => s.url === r.url)) sources.push({ url: r.url, title: r.title || "" }); });
    if (ev.type === "error") throw new BrainError(ev.error?.message || "Ошибка Claude", ev.error?.type === "overloaded_error" ? 529 : 500, "claude");
  }, signal);
  return { text, sources: sources.slice(0, 6), model: S.claudeModel };
}
async function plainClaude(system, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: cHeaders(),
    body: JSON.stringify({ model: S.claudeModel || "claude-sonnet-5-5", max_tokens: 2048, system, messages: [{ role: "user", content: prompt }] }) });
  if (!res.ok) await httpError(res, "claude");
  return ((await res.json()).content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

/* =====================================================================
   ОБЩИЙ ВХОД: перебираем мозги по порядку
   ===================================================================== */
const shouldFallback = e => e.name !== "AbortError" && (isLocationErr(e) || e.name === "TypeError" || e.status === 429 || e.status >= 500 || e.status === 403 || e.status === 404 || (e.status === 400 && !isKeyErr(e)));
/* Счётчик запросов за день — чтобы видеть, сколько тратится. */
function bump(b) {
  const day = todayKey();
  if (!D.meta.usage || D.meta.usage.day !== day) D.meta.usage = { day, n: {} };
  D.meta.usage.n[b] = (D.meta.usage.n[b] || 0) + 1;
}
/* История для любой нейросети: начинается с вопроса, одинаковые роли подряд склеены. */
function normHist(hist) {
  const out = [];
  hist.forEach(h => {
    if (!h.text) return;
    if (out.length && out[out.length - 1].role === h.role) out[out.length - 1] = { role: h.role, text: out[out.length - 1].text + "\n\n" + h.text };
    else out.push({ role: h.role, text: h.text });
  });
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
export async function chat(opts) {
  try { return await chatOnce(opts); }
  catch (e) {
    const errs = e.all || [e];
    // Все упёрлись в минутный лимит — подождём (не дольше 30 с) и повторим, показывая отсчёт
    // (дневной лимит и «лимит 0» ожиданием не лечатся)
    const wait = errs.every(x => x.status === 429 && !isDaily(x) && !/limit:\s*0\b/i.test(x.message || "")) ? Math.max(5e3, Math.min(...errs.map(x => x.retryMs || 1e4))) : 0;
    if (!wait || wait > 30e3 || opts.signal?.aborted) throw e;
    for (let left = Math.ceil(wait / 1000); left > 0; left--) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      opts.onText(`Нейросети просят подождать (лимит в минуту) — повторю сам через ${left} с…`);
      await sleep(1000);
    }
    opts.onText("Повторяю…");
    return await chatOnce(opts);
  }
}
async function chatOnce(opts) {
  const lastUser = [...(opts.hist || [])].reverse().find(h => h.role === "user");
  const list = order(!opts.img && (opts.wantSearch || FRESH_RE.test(lastUser ? lastUser.text : ""))); let last; const all = [];
  if (!list.length) throw new BrainError("Нет подключённой нейросети", 0, null);
  const hist = normHist(opts.hist);
  for (const b of list) {
    let gotText = false;
    // Правила собираются под тот мозг, который реально отвечает (у Mistral и Z.ai поиск — инструментами).
    // «Ищу в интернете…» — статус, а не ответ: он не мешает перейти на запасной мозг.
    const o = { ...opts, hist, system: typeof opts.system === "function" ? opts.system(b) : opts.system,
      onStatus: t => opts.onText(t), onText: t => { gotText = true; opts.onText(t); } };
    try {
      const r = b === "gemini" ? await chatGemini(o) : b === "claude" ? await chatClaude(o) : await chatCompat(b, o);
      bump(b); persist();
      return { ...r, brain: b };
    } catch (e) {
      e.brain = e.brain || b; last = e; all.push(e);
      if (isLocationErr(e)) blockedUntil.gemini = Date.now() + 5 * 6e4;
      if (e.status === 429 && b !== "gemini") blockedUntil[b] = Date.now() + (isDaily(e) ? 30 * 6e4 : Math.min(120e3, e.retryMs || 60e3));
      if (gotText || !shouldFallback(e)) throw e;
    }
  }
  // Объяснение по каждому мозгу, а не только по последнему
  if (all.length > 1) { last.all = all; last.summary = all.map(explain).join("\n"); last.tried = [...(last.tried || []), ...all.slice(0, -1).map(x => `${x.brain}: ${x.status || ""} ${String(x.message || "").slice(0, 200)}`)]; }
  throw last;
}
export async function plain(system, prompt, opts) {
  let last;
  // Фоновая работа (память, конспекты): сначала Gemini — там она идёт на Gemma и не тратит лимит ответов
  const list = order(); const gi = list.indexOf("gemini");
  if (gi > 0 && !isBlocked("gemini") && !geminiSpent()) list.unshift(...list.splice(gi, 1));
  for (const b of list) {
    try { const t = b === "gemini" ? await plainGemini(system, prompt, opts) : b === "claude" ? await plainClaude(system, prompt) : await plainCompat(b, system, prompt); bump(b); return t; }
    catch (e) { e.brain = e.brain || b; last = e; if (!shouldFallback(e)) throw e; }
  }
  throw last || new BrainError("Нет подключённой нейросети", 0, null);
}
export const canEmbed = () => configured().includes("gemini") && !isBlocked("gemini");
export async function embed(texts, task) { return canEmbed() ? embedGemini(texts, task) : null; }

/* Распознавание записанной речи нейросетью. */
export const canTranscribe = () => (configured().includes("gemini") && !isBlocked("gemini")) || configured().includes("mistral");
export async function transcribe(blob) {
  let last;
  if (configured().includes("mistral") && !isBlocked("mistral-stt")) {
    try { const t = await transcribeMistral(blob); if (t || !configured().includes("gemini")) return t; }
    catch (e) { last = e; blockedUntil["mistral-stt"] = Date.now() + (e.status === 429 ? 5 : 30) * 6e4; }
  }
  if (configured().includes("gemini") && !isBlocked("gemini")) {
    try { return await transcribeGemini(await blobB64(blob), (blob.type || "audio/mp4").split(";")[0]); }
    catch (e) { last = e; if (isLocationErr(e)) blockedUntil.gemini = Date.now() + 5 * 6e4; }
  }
  throw last || new BrainError("Для распознавания речи нужен Gemini или Mistral", 0, null);
}
export const canTTS = () => configured().includes("gemini") && !isBlocked("gemini");
function blobB64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(blob); });
}

/* Проверка одного мозга для экрана диагностики. */
export async function ping(b) {
  const t0 = performance.now();
  const o = { system: "Отвечай очень коротко по-русски.", hist: [{ role: "user", text: "Скажи одним словом: на связи?" }], img: null, onText: () => {}, signal: undefined };
  const r = b === "gemini" ? await chatGemini(o) : b === "claude" ? await chatClaude(o) : await chatCompat(b, o);
  return { ms: Math.round(performance.now() - t0), model: r.model, text: r.text.slice(0, 60) };
}
