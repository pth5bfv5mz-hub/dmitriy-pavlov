/* Офлайн-оболочка: приложение открывается даже без сети; запросы к нейросетям идут мимо кэша. */
const CACHE = "dp-v3.13.2";
const LIB_CACHE = "dp-lib-v1";   // тяжёлые библиотеки (голосовой движок, PDF). Поменял файлы в lib/ — поменяй и номер здесь
const KEEP = ["dp-voice-"];      // кэш скачанного голоса обновление НЕ стирает
const SHELL = ["./", "index.html", "style.css", "js/main.js", "js/util.js", "js/store.js", "js/brains.js", "js/memory.js", "js/knowledge.js", "js/prompt.js", "js/voice.js", "js/piper.js", "guide.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== LIB_CACHE && !KEEP.some(p => k.startsWith(p))).map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
  // Остальное: сначала сеть мимо HTTP-кэша браузера (чтобы обновления приходили сразу), без сети — кэш.
  const nav = e.request.mode === "navigate";
  const net = nav ? fetch(url.href, { cache: "no-cache", credentials: "same-origin" }) : fetch(new Request(e.request, { cache: "no-cache" }));
  e.respondWith(net.then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }   // ошибки не кэшируем
    return res;
  }).catch(() => caches.match(e.request).then(r => r || (nav ? caches.match("index.html") : Response.error()))));
});
