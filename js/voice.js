/* Голос. Слушаем через микрофон (MediaRecorder) и распознаём нейросетью — это работает
   в приложении с экрана «Домой», где встроенное распознавание iOS ломается.
   Конец фразы — по тишине. Говорим живым голосом Gemini, запасной — голос iPhone. */
import { S } from "./store.js";
import { transcribe, canTranscribe, ttsGemini, canTTS } from "./brains.js";

/* ---------- Звук ---------- */
let actx = null;
export function audioCtx() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); }
  // iOS после сворачивания или звонка ставит звук в «suspended» или «interrupted» — будим в любом случае
  if (actx && actx.state !== "running" && actx.state !== "closed") actx.resume().catch(() => {});
  return actx;
}
let unlocked = false;
export function unlock() {   // iOS: звук и речь — только после касания
  audioCtx();
  if (unlocked) return; unlocked = true;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch {}
  try { const c = audioCtx(); const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch {}
}
export function beep(freq = 880, times = 2) {
  try {
    const c = audioCtx();
    for (let i = 0; i < times; i++) {
      const o = c.createOscillator(), g = c.createGain(); o.frequency.value = freq; o.connect(g); g.connect(c.destination);
      const t = c.currentTime + i * 0.25; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.2, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .2);
      o.start(t); o.stop(t + .22);
    }
  } catch {}
}

/* ---------- Запись с определением конца фразы ---------- */
export const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const MIME = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/aac"];
let current = null;  // активная запись
export const isRecording = () => !!current;
export function stopRecording(cancel) { if (current) current.stop(cancel); }

export function record({ onLevel, onSpeech, maxMs = 60000, silenceMs = 1300, noSpeechMs = 9000, vad = true } = {}) {
  return new Promise(async (resolve, reject) => {
    if (current) current.stop(true);
    // Пока iPhone спрашивает разрешение на микрофон, запись уже можно отменить
    const pending = { cancelled: false, stop: () => { pending.cancelled = true; } };
    current = pending;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { if (current === pending) current = null; return reject(Object.assign(new Error(e && e.name === "NotAllowedError" ? "mic-denied" : "mic-failed"), { cause: e })); }
    if (pending.cancelled || current !== pending) { stream.getTracks().forEach(t => t.stop()); return resolve(null); }
    const mime = MIME.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || "";
    let mr; try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { stream.getTracks().forEach(t => t.stop()); return reject(e); }
    const chunks = []; let cancelled = false, spoke = false, done = false;
    let src, an, timer, raf;
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const cleanup = () => {
      try { src && src.disconnect(); } catch {}
      stream.getTracks().forEach(t => t.stop());   // отпускаем микрофон, иначе iOS делает звук тише
      if (current === rec) current = null;
      if (cancelled || !chunks.length) return resolve(null);
      resolve(new Blob(chunks, { type: (mr.mimeType || mime || "audio/mp4").split(";")[0] }));
    };
    const finish = () => { if (done) return; done = true; clearTimeout(raf); clearTimeout(timer); try { mr.state !== "inactive" ? mr.stop() : cleanup(); } catch { cleanup(); } };
    // Анализ громкости. Уровень шума — по самым тихим моментам (человек часто начинает говорить сразу),
    // порог речи = шум × 3, но в разумных пределах.
    const c = audioCtx();
    const t0 = performance.now(); let floor = 0.01, lastVoice = 0, heard = false;
    try {
      src = c.createMediaStreamSource(stream); an = c.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        if (done) return;
        an.getFloatTimeDomainData(buf);
        let s = 0; for (const x of buf) s += x * x; const rms = Math.sqrt(s / buf.length);
        if (rms > 0) heard = true;
        const t = performance.now() - t0;
        if (rms > 0) floor = rms < floor ? rms : Math.min(0.03, floor + (rms - floor) * 0.002);
        const thr = Math.min(0.06, Math.max(0.012, floor * 3));
        if (rms > thr) { if (!spoke) { spoke = true; onSpeech && onSpeech(); } lastVoice = t; }
        onLevel && onLevel(Math.min(1, rms / (thr * 3)));
        if (vad && spoke && t - lastVoice > silenceMs) return finish();
        // «Тишина» засчитывается, только если анализатор вообще что-то слышит (иначе звук не запущен — не выбрасываем запись)
        if (vad && !spoke && heard && t > noSpeechMs) { cancelled = true; return finish(); }
        if (t > maxMs) return finish();
        raf = setTimeout(tick, 50);
      };
      tick();
    } catch { /* без анализа — останавливать придётся кнопкой */ }
    mr.onstop = cleanup;
    const rec = { stop: cancel => { if (cancel) cancelled = true; finish(); } };
    current = rec;
    try { mr.start(250); } catch (e) { cleanup(); reject(e); }
    timer = setTimeout(finish, maxMs + 500);
  });
}

/* Встроенное распознавание (работает во вкладке Safari, не всегда — в приложении). */
function listenSR({ onInterim } = {}) {
  return new Promise((resolve, reject) => {
    const r = new SR(); r.lang = "ru-RU"; r.interimResults = true; r.continuous = false;
    let fin = "";
    r.onresult = e => { let it = ""; fin = ""; for (const x of e.results) (x.isFinal ? fin += x[0].transcript : it += x[0].transcript); onInterim && onInterim((fin + " " + it).trim()); };
    r.onerror = e => reject(new Error(e.error === "not-allowed" ? "mic-denied" : "sr-" + e.error));
    r.onend = () => resolve(fin.trim());
    current = { stop: cancel => { try { cancel ? r.abort() : r.stop(); } catch {} } };
    try { r.start(); } catch (e) { reject(e); }
  }).finally(() => { current = null; });
}

/* Услышать одну фразу и вернуть текст. */
export async function listen(opts = {}) {
  const mode = S.sttMode;
  const neural = canRecord() && canTranscribe() && mode !== "ios";
  if (neural) {
    const blob = await record(opts);
    if (!blob) return "";
    opts.onTranscribing && opts.onTranscribing();
    return await transcribe(blob);
  }
  if (SR) return listenSR(opts);
  throw new Error(canRecord() ? "no-stt" : "no-mic");
}

/* ---------- Речь ---------- */
let playing = null, token = 0, liveCooldown = 0, onChange = () => {};
export const speaking = () => !!playing;
export const onSpeakingChange = f => { onChange = f || (() => {}); };
const setPlaying = p => { playing = p; try { onChange(!!p); } catch {} };
export function stopSpeaking() {
  token++;
  try { speechSynthesis.cancel(); } catch {}
  if (playing) { try { playing.stop(); } catch {} setPlaying(null); }
}
export function speakable(text, full) {
  let t = String(text || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "")
    .replace(/[*#`•_>|]/g, "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
  if (full || t.length <= 700) return t;
  const parts = t.match(/[^.!?…]+[.!?…]*\s*/g) || [t]; let out = "";
  for (const p of parts) { if ((out + p).length > 550) break; out += p; }
  return (out || t.slice(0, 550)).trim() + " Остальное — на экране.";
}
function splitForSpeech(t) {
  const parts = t.match(/[^.!?…]+[.!?…]*\s*/g) || [t];
  const first = []; let len = 0, i = 0;
  for (; i < parts.length && (len < 90 || !first.length); i++) { first.push(parts[i]); len += parts[i].length; if (len > 220) { i++; break; } }
  return [first.join("").trim(), parts.slice(i).join("").trim()].filter(Boolean);
}
const VOICES_LIVE = ["Charon", "Orus", "Fenrir", "Iapetus", "Algenib", "Alnilam", "Enceladus", "Puck", "Umbriel", "Schedar", "Sadaltager", "Rasalgethi"];
export const liveVoices = () => VOICES_LIVE;
export const liveAvailable = () => S.voiceMode === "live" && canTTS() && Date.now() > liveCooldown;

/* Говорить. Возвращает промис, который завершается, когда речь закончилась (или прервана). */
export async function speak(text, { force, full } = {}) {
  if ((!S.speakOn && !force) || !text) return;
  stopSpeaking();
  const my = ++token;
  const t = speakable(text, full);
  if (liveAvailable()) {
    const parts = splitForSpeech(t);
    const reqs = parts.map(p => ttsGemini(p, S.liveVoice));   // первая фраза приходит быстрее — начинаем с неё
    reqs.forEach(r => r.catch(() => {}));
    let i = 0;
    try {
      for (; i < reqs.length; i++) {
        const audio = await reqs[i];
        if (my !== token) return;
        await playAudio(audio, my);
        if (my !== token) return;
      }
      return;
    } catch (e) {
      if (my !== token) return;
      if (!e || e.message !== "audio-off") liveCooldown = Date.now() + 10 * 6e4;   // лимит или сбой — 10 минут говорим голосом iPhone
      return speakIOS(parts.slice(i).join(" "), my);
    }
  }
  return speakIOS(t, my);
}
/* Потоковая речь: фразы добавляются по мере того, как нейросеть пишет ответ.
   Звук для следующей фразы запрашивается заранее, пока звучит текущая. */
export function createSpeaker({ limit = 0 } = {}) {
  stopSpeaking();
  const my = ++token;
  const segs = []; let closed = false, wake = null, total = 0, cut = false, live = liveAvailable();
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  const ask = seg => { seg.audio = ttsGemini(seg.text, S.liveVoice); seg.audio.catch(() => {}); };
  const add = text => {
    if (cut || my !== token) return;
    let t = speakable(text, true); if (!t) return;
    if (limit && total + t.length > limit) { t = total ? "Остальное — на экране." : t.slice(0, limit); cut = true; }
    total += t.length;
    const seg = { text: t }; if (live) ask(seg);
    segs.push(seg); notify();
  };
  const run = (async () => {
    for (let i = 0; ; i++) {
      while (i >= segs.length) { if (closed || my !== token) return; await new Promise(r => { wake = r; }); }
      if (my !== token) return;
      const seg = segs[i];
      if (live && seg.audio) {
        try { await playAudio(await seg.audio, my); continue; }
        catch (e) { if (my !== token) return; live = false; if (!e || e.message !== "audio-off") liveCooldown = Date.now() + 10 * 6e4; }
      }
      await speakIOS(seg.text, my);
    }
  })();
  return {
    add,
    end: () => { closed = true; notify(); return run; },
    cancel: () => { if (my === token) stopSpeaking(); closed = true; notify(); },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function playAudio({ mime, b64 }, my) {
  const c = audioCtx();
  if (c.state !== "running") { try { await Promise.race([c.resume(), sleep(800)]); } catch {} }
  if (c.state !== "running") throw new Error("audio-off");   // звук не запустился — пусть говорит iPhone
  const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
  let buf;
  if (/wav|mpeg|mp3|ogg|aac|mp4/i.test(mime)) {
    buf = await new Promise((res, rej) => c.decodeAudioData(bytes.buffer.slice(0), res, rej));
  } else {   // audio/L16;rate=24000 — 16-битный PCM
    const rate = +(mime.match(/rate=(\d+)/) || [0, 24000])[1];
    const n = Math.floor(bytes.length / 2), dv = new DataView(bytes.buffer);
    buf = c.createBuffer(1, n, rate); const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  }
  if (my !== token) return;
  await new Promise(resolve => {
    const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination);
    let fin = false;
    const end = () => { if (fin) return; fin = true; clearTimeout(dog); if (playing && playing.s === s) setPlaying(null); resolve(); };
    const dog = setTimeout(end, buf.duration * 1000 + 1500);   // страховка: onended может не прийти
    s.onended = end;
    setPlaying({ s, stop: () => { try { s.stop(); } catch {} end(); } });
    s.start(0);
  });
}
let iosVoices = [];
export function loadIOSVoices() { try { iosVoices = (speechSynthesis.getVoices() || []).filter(v => /^ru/i.test(v.lang)); } catch { iosVoices = []; } return iosVoices; }
function pickIOS() { return iosVoices.find(v => v.voiceURI === S.iosVoice) || iosVoices.find(v => /yuri|юрий|dmitr|pavel|maxim|male/i.test(v.name)) || iosVoices[0] || null; }
function speakIOS(t, my) {
  if (!window.speechSynthesis) return;
  const parts = []; let cur = "";
  (t.match(/[^.!?…]+[.!?…]*\s*/g) || [t]).forEach(p => { if ((cur + p).length > 220 && cur) { parts.push(cur); cur = ""; } cur += p; });
  if (cur.trim()) parts.push(cur);
  const v = pickIOS();
  return new Promise(resolve => {
    const handle = { ios: true, stop: () => { try { speechSynthesis.cancel(); } catch {} resolve(); } };
    const next = i => {
      if (my !== token || i >= parts.length) { if (playing === handle) setPlaying(null); return resolve(); }
      const u = new SpeechSynthesisUtterance(parts[i].trim()); u.lang = "ru-RU"; if (v) u.voice = v; u.rate = +S.rate || 1; u.pitch = 0.95;
      let moved = false;
      const go = () => { if (moved) return; moved = true; clearTimeout(dog); next(i + 1); };
      // iOS иногда теряет фразу после cancel() и не присылает onend — страхуемся по длине текста
      const dog = setTimeout(go, 2500 + parts[i].length * 110 / (+S.rate || 1));
      u.onend = u.onerror = go;
      if (playing !== handle) setPlaying(handle);
      speechSynthesis.speak(u);
    };
    next(0);
  });
}
