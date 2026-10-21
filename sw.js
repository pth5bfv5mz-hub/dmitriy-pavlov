/* Офлайн-оболочка: приложение открывается даже без сети; запросы к нейросетям идут мимо кэша. */
const CACHE = "dp-v3.7.0";
const LIB_CACHE = "dp-lib-v1";   // тяжёлые библиотеки (голосовой движок, PDF) — не перекачиваем при обновлениях
const KEEP = ["dp-voice-", "dp-lib-"]; // кэш скачанного голоса и библиотек обновление НЕ стирает
const SHELL = ["./", "index.html", "style.css", "js/main.js", "js/util.js", "js/store.js", "js/brains.js", "js/memory.js", "js/knowledge.js", "js/prompt.js", "js/voice.js", "js/piper.js", "guide.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && !KEEP.some(p => k.startsWith(p))).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/voices/")) return;   // модели голоса хранит сам голосовой модуль — не дублируем 60 МБ
  // Библиотеки в /lib/ не меняются — сначала кэш, сеть только в первый раз.
  if (url.pathname.includes("/lib/")) {
    e.respondWith(caches.open(LIB_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) c.put(e.request, res.clone()).catch(() => {});
      return res;
    }))));
    return;
  }
  // Остальное: сначала сеть (чтобы обновления приходили сразу), без сети — кэш.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }   // ошибки не кэшируем
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
