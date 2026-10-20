/* «Мозги» Дмитрия: несколько нейросетей с автоматическим переключением.
   Gemini — самый умный (поиск Google, голос, распознавание речи, эмбеддинги), но из России только через VPN.
   Mistral и Z.ai — работают из России без VPN; для них поиск и погода сделаны инструментами. */
import { S, D, persist } from "./store.js";
import { sleep } from "./util.js";

export const BRAINS = {
  gemini: { name: "Gemini", needs: "geminiKey" },
  mistral: { name: "Mistral", needs: "mistralKey" },
  zai: { name: "Z.ai GLM", needs: "zaiKey" },
  claude: { name: "Claude", needs: "claudeKey" },
  custom: { name: "Своя нейросеть", needs: "customKey" },
};
const has = b => !!(S[BRAINS[b].needs] || "").trim() && (b !== "custom" || (S.customBase && S.customModel));
export const configured = () => Object.keys(BRAINS).filter(has);
export const anyBrain = () => configured().length > 0;

// Если Gemini не пустил (страна) — несколько минут не пробуем его первым.
const blockedUntil = {};
export const isBlocked = b => (blockedUntil[b] || 0) > Date.now();
export function order() {
  const list = configured();
  if (S.brain !== "auto" && list.includes(S.brain)) return [S.brain, ...list.filter(b => b !== S.brain)];
  const pref = ["gemini", "claude", "mistral", "zai", "custom"].filter(b => list.includes(b));
  return [...pref.filter(b => !isBlocked(b)), ...pref.filter(isBlocked)];
}

/* ---------- Ошибки ---------- */
export class BrainError extends Error {
  constructor(msg, status, brain) { super(msg); this.status = status; this.brain = brain; }
}
async function httpError(res, brain) {
  let msg = "";
  try { const j = await res.json(); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && (e.message || e.type)) || j.message || j.detail || JSON.stringify(j).slice(0, 300); } catch {}
  throw new BrainError(String(msg || "HTTP " + res.status), res.status, brain);
}
export const isLocationErr = e => /location is not supported|User location|unsupported_country|not available in your (country|region)/i.test(String(e && e.message));
const isKeyErr = e => e && (e.status === 401 || /API key not valid|API_KEY_INVALID|invalid api key|Unauthorized/i.test(e.message || ""));
export function explain(e) {
  const m = String(e && e.message || ""), s = e && e.status, who = e && e.brain ? BRAINS[e.brain]?.name || e.brain : "Нейросеть";
  if (e && e.name === "AbortError") return "Остановлено.";
  if (isLocationErr(e)) return "Gemini не пускает из России. Включи VPN (США или Европа) — или подключи Mistral во вкладке «Настройки», он работает без VPN.";
  if (isKeyErr(e)) return `${who}: ключ не подходит. Проверь его во вкладке «Настройки».`;
  if (s === 403) return `${who}: доступ запрещён. ${m.slice(0, 140)}`;
  if (s === 429) return `${who}: бесплатный лимит на сейчас исчерпан. Подожди минуту (или до завтра, если это дневной лимит). Можно подключить запасную нейросеть в «Настройках».`;
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
const gkey = () => encodeURIComponent(S.geminiKey.trim());
const STATIC = {
  chat: ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"],
  deep: ["gemini-pro-latest", "gemini-3.8-pro", "gemini-2.5-pro"],
  lite: ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  tts: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts"],
  embed: ["gemini-embedding-001", "gemini-embedding-2"],
};
const ver = n => (n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
const byVer = (a, b) => ver(b) - ver(a) || a.length - b.length;
/* Спрашиваем у Google, какие модели доступны этому ключу, и раскладываем по ролям.
   Так Дмитрий не сломается, когда Google переименует модели. */
export async function discoverGemini(force) {
  const cached = D.meta.models;
  if (!force && cached && Date.now() - cached.at < 3 * 864e5 && cached.chat?.length) return cached;
  try {
    const res = await fetch(`${G}/models?pageSize=1000&key=${gkey()}`);
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
      chat: pick(/flash(?!-lite)/, "gemini-flash-latest"),
      deep: pick(/pro/, "gemini-pro-latest"),
      lite: pick(/flash-lite/, "gemini-flash-lite-latest"),
      tts: gen.filter(m => /tts/.test(m.id)).map(m => m.id).sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (/preview/.test(a) - /preview/.test(b)) || byVer(a, b)),
      embed: all.filter(m => m.methods.includes("embedContent") && /embedding/.test(m.id)).map(m => m.id).sort((a, b) => (b === "gemini-embedding-001") - (a === "gemini-embedding-001")),
    };
    if (!models.chat.length) models.chat = STATIC.chat;
    D.meta.models = models; persist();
    return models;
  } catch (e) {
    if (isLocationErr(e)) { blockedUntil.gemini = Date.now() + 5 * 6e4; throw e; }
    if (isKeyErr(e)) throw e;
    return cached || { at: 0, ...STATIC };
  }
}
async function gModels(kind) {
  const m = await discoverGemini();
  const pref = S.geminiModel && S.geminiModel !== "auto" && kind === "chat" ? [S.geminiModel] : [];
  const list = kind === "deep" ? [...(m.deep || []), ...(m.chat || [])] : (m[kind] && m[kind].length ? m[kind] : STATIC[kind]);
  return [...new Set([...pref, ...list])].slice(0, 5);
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
  const res = await fetch(`${G}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${gkey()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
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
async function chatGemini({ system, hist, img, onText, signal, deep }) {
  const base = { system_instruction: { parts: [{ text: system }] }, contents: gContents(hist, img), generationConfig: { temperature: deep ? 0.4 : 0.6 } };
  let last;
  for (const model of await gModels(deep ? "deep" : "chat")) {
    for (const tools of [[{ google_search: {} }, { url_context: {} }], [{ google_search: {} }], undefined]) {
      try { return await gStream(model, tools ? { ...base, tools } : base, onText, signal); }
      catch (e) {
        last = e;
        if (e.status === 400 && /tool|url_context|search|grounding/i.test(e.message || "")) continue;
        break;
      }
    }
    if (isLocationErr(last)) blockedUntil.gemini = Date.now() + 5 * 6e4;
    if (!gRetriable(last)) throw last;
  }
  throw last;
}
async function plainGemini(system, prompt, { json } = {}) {
  let last;
  for (const model of [...await gModels("lite"), ...await gModels("chat")].slice(0, 6)) {
    try {
      const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent?key=${gkey()}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: "application/json" } : {}) } }),
      });
      if (!res.ok) await httpError(res, "gemini");
      const j = await res.json();
      return ((j.candidates?.[0]?.content?.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    } catch (e) { last = e; if (!gRetriable(e)) throw e; }
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
        const res = await fetch(`${G}/models/${model}:batchEmbedContents?key=${gkey()}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
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
        const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent?key=${gkey()}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [
            { text: "Распознай речь на записи дословно. Язык обычно русский. Верни только распознанный текст без кавычек и пояснений. Если речи нет — верни пустую строку." },
            { inline_data: { mime_type: m, data: b64 } }] }], generationConfig: { temperature: 0 } }),
        });
        if (!res.ok) await httpError(res, "gemini");
        const j = await res.json();
        return ((j.candidates?.[0]?.content?.parts) || []).map(p => p.text || "").join("").trim();
      } catch (e) { last = e; if (e.status === 400 && /mime|audio|format|unsupported/i.test(e.message || "")) continue; break; }
    }
    if (!gRetriable(last)) throw last;
  }
  throw last;
}
/* Живой голос Gemini. Ответ — WAV или «сырой» PCM 24 кГц; возвращаем то, что пришло. */
export async function ttsGemini(text, voice) {
  let last;
  for (const model of (await gModels("tts")).slice(0, 3)) {
    try {
      const res = await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent?key=${gkey()}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
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
  mistral: () => ({ url: "https://api.mistral.ai/v1/chat/completions", key: S.mistralKey, model: S.mistralModel || "mistral-medium-latest", vision: S.mistralModel || "mistral-medium-latest", lite: "mistral-small-latest" }),
  zai: () => ({ url: "https://api.z.ai/api/paas/v4/chat/completions", key: S.zaiKey, model: S.zaiModel || "glm-4.7-flash", vision: "glm-4.6v-flash", lite: S.zaiModel || "glm-4.7-flash" }),
  custom: () => ({ url: S.customBase.trim().replace(/\/+$/, "") + "/chat/completions", key: S.customKey, model: S.customModel, vision: S.customModel, lite: S.customModel }),
};
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
async function runTool(call, sources) {
  let a = {}; try { a = JSON.parse(call.function.arguments || "{}"); } catch {}
  try {
    if (call.function.name === "get_weather") return await toolWeather(String(a.city || ""));
    if (call.function.name === "read_url") { const t = await readUrl(String(a.url || "")); sources.push({ url: String(a.url), title: "" }); return t; }
    return await toolWebSearch(String(a.query || ""), sources);
  } catch (e) { return "Ошибка инструмента: " + e.message; }
}
async function chatCompat(brain, { system, hist, img, onText, onStatus, signal }) {
  const c = COMPAT[brain]();
  const messages = [{ role: "system", content: system }, ...hist.map(h => ({ role: h.role, content: h.text }))];
  if (img) { const last = messages[messages.length - 1]; last.content = [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: img.url } }]; }
  const sources = [];
  for (let round = 0; round < 5; round++) {
    const body = { model: img ? c.vision : c.model, messages, temperature: 0.5 };
    if (round < 4) body.tools = TOOLS;
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(c.url, { method: "POST", signal, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key.trim() }, body: JSON.stringify(body) });
      if (res.status === 429 && attempt === 0) { await sleep(1500); continue; }   // бесплатные планы: 1 запрос в секунду
      break;
    }
    if (!res.ok) await httpError(res, brain);
    const j = await res.json();
    const m = j.choices?.[0]?.message;
    if (!m) throw new BrainError("Пустой ответ", 503, brain);
    if (m.tool_calls && m.tool_calls.length) {
      messages.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls });
      (onStatus || onText)(m.tool_calls.some(t => t.function.name === "web_search") ? "Ищу в интернете…" : "Смотрю…");
      for (const call of m.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(await runTool(call, sources)).slice(0, 14000) });
      continue;
    }
    const text = typeof m.content === "string" ? m.content : (m.content || []).map(p => p.text || "").join("");
    onText(text);
    return { text, sources, model: body.model };
  }
  throw new BrainError("Слишком много шагов поиска", 500, brain);
}
async function plainCompat(brain, system, prompt) {
  const c = COMPAT[brain]();
  const res = await fetch(c.url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key.trim() },
    body: JSON.stringify({ model: c.lite, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
  if (!res.ok) await httpError(res, brain);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}
async function transcribeMistral(blob) {
  const fd = new FormData();
  fd.append("model", "voxtral-mini-latest");
  fd.append("file", blob, "speech." + (blob.type.includes("webm") ? "webm" : blob.type.includes("wav") ? "wav" : "m4a"));
  fd.append("language", "ru");
  const res = await fetch("https://api.mistral.ai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": "Bearer " + S.mistralKey.trim() }, body: fd });
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
  const list = order(); let last;
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
      return { ...r, brain: b };
    } catch (e) {
      e.brain = e.brain || b; last = e;
      if (isLocationErr(e)) blockedUntil.gemini = Date.now() + 5 * 6e4;
      if (gotText || !shouldFallback(e)) throw e;
    }
  }
  throw last;
}
export async function plain(system, prompt, opts) {
  let last;
  for (const b of order()) {
    try { return b === "gemini" ? await plainGemini(system, prompt, opts) : b === "claude" ? await plainClaude(system, prompt) : await plainCompat(b, system, prompt); }
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
  if (configured().includes("gemini") && !isBlocked("gemini")) {
    try { return await transcribeGemini(await blobB64(blob), (blob.type || "audio/mp4").split(";")[0]); }
    catch (e) { last = e; if (isLocationErr(e)) blockedUntil.gemini = Date.now() + 5 * 6e4; }
  }
  if (configured().includes("mistral")) return transcribeMistral(blob);
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
