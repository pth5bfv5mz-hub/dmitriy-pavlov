/* Голос Дмитрия на телефоне: нейросеть Piper (проект rhasspy/piper).
   Бесплатно и без лимитов: синтез идёт прямо на устройстве, интернет не нужен после загрузки.
   Движок (ONNX Runtime + espeak-ng) лежит в приложении, модель голоса (~60 МБ) скачивается один раз
   с нашего сайта (запасные источники — Hugging Face) и хранится в кэше телефона. */
const LIB = new URL("../lib/piper/", import.meta.url).href;
// Откуда качать голос: сначала с нашего сайта на GitHub (открывается из России без VPN),
// потом — Hugging Face и зеркала.
const OWN = new URL("../voices/", import.meta.url).href;
const SOURCES = [
  path => OWN + path.split("/").pop(),
  path => "https://huggingface.co/rhasspy/piper-voices/resolve/main/" + path,
  path => "https://huggingface.co/diffusionstudio/piper-voices/resolve/main/" + path,
  path => "https://hf-mirror.com/rhasspy/piper-voices/resolve/main/" + path,
];
// Порядок — от самого низкого и спокойного. Тон проверен на реальном синтезе: Руслан ~116 Гц, Денис ~148 Гц, Дмитрий ~181 Гц.
export const VOICES = {
  "ru_RU-ruslan-medium": { name: "Руслан", note: "мужской, низкий и спокойный (рекомендую)", path: "ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx" },
  "ru_RU-denis-medium": { name: "Денис", note: "мужской, средний", path: "ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx" },
  "ru_RU-dmitri-medium": { name: "Дмитрий", note: "мужской, повыше", path: "ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx" },
  "ru_RU-irina-medium": { name: "Ирина", note: "женский", path: "ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx" },
};
const CACHE = "dp-voice-v1";
const key = (id, ext) => new Request(LIB + "models/" + id + ext);   // свой адрес-ключ в кэше

/* ---------- Загрузка и хранение модели ---------- */
async function cached(id, ext) {
  try { const c = await caches.open(CACHE); const r = await c.match(key(id, ext)); return r ? await r.arrayBuffer() : null; } catch { return null; }
}
export async function isDownloaded(id) {
  try { const c = await caches.open(CACHE); return !!(await c.match(key(id, ".onnx"))) && !!(await c.match(key(id, ".onnx.json"))); } catch { return false; }
}
async function fetchFirst(path, onProgress) {
  let last;
  for (const src of SOURCES) {
    try {
      const res = await fetch(src(path));
      if (!res.ok) { last = new Error("HTTP " + res.status); continue; }
      if (/text\/html/.test(res.headers.get("content-type") || "")) { last = new Error("not a model"); continue; }   // страница-заглушка вместо файла
      const total = +(res.headers.get("content-length") || 0);
      if (!res.body || !onProgress) return await res.blob();
      const reader = res.body.getReader(); const parts = []; let got = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        parts.push(value); got += value.length; onProgress(got, total);
      }
      return new Blob(parts);
    } catch (e) { last = e; }
  }
  throw last || new Error("download");
}
/* Скачать голос: сначала описание, потом модель с прогрессом. */
export async function download(id, onProgress = () => {}) {
  const v = VOICES[id]; if (!v) throw new Error("Нет такого голоса");
  try { await navigator.storage?.persist?.(); } catch {}
  const c = await caches.open(CACHE);
  const json = await fetchFirst(v.path + ".json");
  const model = await fetchFirst(v.path, (got, total) => onProgress(got, total || 63e6));
  if (model.size < 1e6) throw new Error("Модель скачалась не полностью. Попробуй ещё раз (лучше по Wi-Fi).");
  await c.put(key(id, ".onnx.json"), new Response(json));
  await c.put(key(id, ".onnx"), new Response(model));
  if (sessId === id) { sess = null; sessId = ""; }
}
export async function remove(id) {
  try { const c = await caches.open(CACHE); await c.delete(key(id, ".onnx")); await c.delete(key(id, ".onnx.json")); } catch {}
  if (sessId === id) { sess = null; sessId = ""; }
}

/* ---------- Движок ---------- */
let ortP = null, ort = null;
function getOrt() {
  if (!ortP) ortP = import(LIB + "ort/ort.wasm.min.js").then(m => {
    const o = m.InferenceSession ? m : m.default;
    o.env.wasm.wasmPaths = LIB + "ort/";
    o.env.wasm.numThreads = 1;      // без многопоточности: на iPhone в приложении она недоступна
    ort = o; return o;
  }).catch(e => { ortP = null; throw e; });
  return ortP;
}
let phonP = null;
function phonAssets() {
  // Бинарник и данные espeak (~19 МБ) берём один раз за запуск — а не на каждую фразу
  if (!phonP) phonP = Promise.all([
    fetch(LIB + "piper_phonemize.wasm").then(r => { if (!r.ok) throw new Error("phonemize wasm"); return r.arrayBuffer(); }),
    fetch(LIB + "piper_phonemize.data").then(r => { if (!r.ok) throw new Error("phonemize data"); return r.arrayBuffer(); }),
    import(LIB + "phonemize.js"),
  ]).then(([wasm, data, m]) => ({ wasm, data, create: m.createPiperPhonemize })).catch(e => { phonP = null; throw e; });
  return phonP;
}
async function phonemize(text, voice) {
  const a = await phonAssets();
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("phonemize timeout")); } }, 20000);
    a.create({
      print: line => { if (done) return; try { const j = JSON.parse(line); if (j.phoneme_ids) { done = true; clearTimeout(timer); resolve(j.phoneme_ids); } } catch {} },
      printErr: () => {},
      wasmBinary: a.wasm,
      getPreloadedPackage: () => a.data,
      locateFile: f => LIB + (f.endsWith(".wasm") ? "piper_phonemize.wasm" : f.endsWith(".data") ? "piper_phonemize.data" : f),
    }).then(mod => {
      try { mod.callMain(["-l", voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]); }
      catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }   // сразу, а не через 20 с
    }, e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
let sess = null, sessId = "", cfg = null, loading = null;
/* Подготовить голос (загрузить модель в память). Повторный вызов — мгновенно. */
export async function ensure(id) {
  if (sess && sessId === id) return;
  if (loading && loading.id === id) return loading.p;
  const p = (async () => {
    const o = await getOrt();
    const [cfgBuf, model] = await Promise.all([cached(id, ".onnx.json"), cached(id, ".onnx")]);
    if (!cfgBuf || !model) throw new Error("not-downloaded");
    cfg = JSON.parse(new TextDecoder().decode(cfgBuf));
    sess = await o.InferenceSession.create(model, { executionProviders: ["wasm"] });
    sessId = id;
    await phonAssets();
  })();
  loading = { id, p };
  try { await p; } finally { if (loading && loading.p === p) loading = null; }
}
let queue = Promise.resolve();
/* Синтез фразы → { pcm: Float32Array, rate }. Фразы идут по очереди (одна модель в памяти). */
export function synth(text, id, { pace = 1 } = {}) {
  const job = queue.then(async () => {
    await ensure(id);
    const ids = await phonemize(text, (cfg.espeak && cfg.espeak.voice) || "ru");
    const inf = cfg.inference || {};
    const T = ort.Tensor;
    const feeds = {
      input: new T("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new T("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new T("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) * pace, inf.noise_w ?? 0.8]), [3]),
    };
    if ((cfg.num_speakers || 1) > 1) feeds.sid = new T("int64", BigInt64Array.from([0n]), [1]);
    const out = await sess.run(feeds);
    const pcm = (out.output || out[Object.keys(out)[0]]).data;
    return { pcm: pcm instanceof Float32Array ? pcm : Float32Array.from(pcm), rate: (cfg.audio && cfg.audio.sample_rate) || 22050 };
  });
  queue = job.catch(() => {});
  return job;
}
export const ready = id => !!(sess && sessId === id);
