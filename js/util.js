/* Общие мелочи: DOM, время, текст. */
export const $ = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const arr = x => Array.isArray(x) ? x : (x ? [x] : []);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return n + " " + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many);
};

export const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
export const DAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
export const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const REPEAT_TXT = { daily: "каждый день", weekdays: "по будням", weekly: "каждую неделю", monthly: "каждый месяц", yearly: "каждый год" };
/* Убрать служебные метки действий из чужого текста (страницы, документы, результаты поиска) —
   чтобы подброшенный текст не выглядел для нейросети как её собственные команды. */
export const neutralize = t => String(t || "").replace(/<<<\s*ACTIONS|ACTIONS\s*>>>/gi, "[…]");
/* Не ждать дольше ms: результат или null (для необязательных шагов перед ответом — скорость важнее). */
export const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
export const pad = n => String(n).padStart(2, "0");
export const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isoLocal = ms => { const d = new Date(ms); return `${ymd(d)} ${hm(d)}`; };
export const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
export const todayKey = () => ymd(new Date());

export function fmtDue(ms) {
  const d = new Date(ms), n = new Date();
  const diff = Math.round((dayStart(d) - dayStart(n)) / 864e5);
  const w = diff === 0 ? "сегодня" : diff === 1 ? "завтра" : diff === -1 ? "вчера"
    : d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== n.getFullYear() ? " " + d.getFullYear() : "");
  return w + ", " + hm(d);
}
export function fmtAgo(ms) {
  const m = Math.round((Date.now() - ms) / 6e4);
  if (m < 1) return "только что";
  if (m < 60) return plural(m, "минуту", "минуты", "минут") + " назад";
  const h = Math.round(m / 60); if (h < 24) return plural(h, "час", "часа", "часов") + " назад";
  const d = Math.round(h / 24); return plural(d, "день", "дня", "дней") + " назад";
}
export function nowText() {
  const d = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hm(d)}${tz ? " (часовой пояс " + tz + ")" : ""}`;
}
// Таблица ближайших дней: модели часто ошибаются в днях недели, поэтому даём их готовыми.
export function calendarText(days = 15) {
  const out = [], d = new Date();
  for (let i = 0; i < days; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    out.push(`${DAYS_SHORT[x.getDay()]} ${ymd(x)}${i === 0 ? " (сегодня)" : i === 1 ? " (завтра)" : i === 2 ? " (послезавтра)" : ""}`);
  }
  return out.join("; ");
}
export function parseLocal(s) {
  const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0).getTime();
  return isNaN(t) ? null : t;
}
export function nextDue(due, repeat, anchorDay) {
  const d = new Date(due), day = anchorDay || d.getDate();   // anchorDay — исходное число (31-е остаётся 31-м)
  // Месяц/год вперёд без «переползания»: 31 января → 28/29 февраля → 31 марта, а не 3 марта
  const addMonths = n => { d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); };
  const step = () => {
    if (repeat === "daily") d.setDate(d.getDate() + 1);
    else if (repeat === "weekdays") { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else if (repeat === "monthly") addMonths(1);
    else if (repeat === "yearly") addMonths(12);
    else return false;
    return true;
  };
  if (!step()) return null;
  while (d.getTime() <= Date.now()) step();   // приложение долго не открывали — догоняем
  return d.getTime();
}

/* Небольшой Markdown: жирный, код, заголовки, списки, ссылки. Сначала экранируем. */
export function md(s) {
  let h = esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/^#{1,4}\s*(.+)$/gm, "<strong>$1</strong>").replace(/^\s*[-*]\s+/gm, "• ");
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h.replace(/\n/g, "<br>");
}
export function parseJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const a = t.search(/[\[{]/); if (a < 0) return null;
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
// Слова для поиска: нижний регистр, без коротких и служебных, грубое отсечение окончаний.
const STOP = new Set("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это the a an of to in is and for on".split(" "));
export function terms(text) {
  return (String(text || "").toLowerCase().match(/[a-zа-яё0-9]{2,}/g) || [])
    .filter(w => !STOP.has(w)).map(w => w.length > 5 ? w.slice(0, w.length - 2) : w);
}
export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

/* Время напоминания из его фразы — страховка, если модель пообещала напомнить, но дело не создала.
   Понимает частое: «через 15 минут / полчаса / час / 2 дня», «в 18:30», «завтра в 10», «в 7 вечера».
   Сложное («в пятницу», «15 мая») остаётся модели. Возвращает { due, text } или null. */
const NUM_W = { одну: 1, одна: 1, один: 1, две: 2, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50 };
const AFTER_RE = new RegExp(`через\\s+(?:(\\d+(?:[.,]\\d+)?|${Object.keys(NUM_W).join("|")})\\s+)?(полчаса|полтора\\s+часа|сек[а-я]*|мин[а-я]*|час[а-я]*|д[не][а-я]*|сут[а-я]*|недел[а-я]*)(?![а-я])`, "i");
const AT_RE = /(?:(сегодня|завтра|послезавтра)\s+)?(?:в|к|на)\s+(\d{1,2})(?:[:.](\d{2})|\s*час[а-я]*)?(?:\s+(утра|дня|вечера|ночи))?(?![\d:.])/i;
export function parseWhen(text, now = Date.now()) {
  const s = String(text || "").replace(/ё/gi, "е");
  let due = null, m = s.match(AFTER_RE);
  if (m) {
    const unit = m[2].toLowerCase();
    const n = m[1] ? (NUM_W[m[1].toLowerCase()] || parseFloat(m[1].replace(",", "."))) : 1;
    const ms = /^полчаса/.test(unit) ? 18e5 : /^полтора/.test(unit) ? 54e5 : /^сек/.test(unit) ? 1e3 : /^мин/.test(unit) ? 6e4 : /^час/.test(unit) ? 36e5 : /^недел/.test(unit) ? 7 * 864e5 : 864e5;
    due = now + Math.round((/^пол/.test(unit) ? 1 : n) * ms);
  } else if ((m = s.match(AT_RE)) && (m[1] || m[3] !== undefined || m[4] || /час/i.test(m[0]))) {
    let h = +m[2]; const min = m[3] !== undefined ? +m[3] : 0, part = (m[4] || "").toLowerCase();
    if ((part === "вечера" || part === "дня") && h < 12) h += 12;
    if ((part === "ночи" || part === "утра") && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now); d.setSeconds(0, 0); d.setHours(h, min);
    const day = (m[1] || "").toLowerCase();
    if (day === "завтра") d.setDate(d.getDate() + 1);
    else if (day === "послезавтра") d.setDate(d.getDate() + 2);
    else if (d.getTime() <= now) { if (day === "сегодня") return null; d.setDate(d.getDate() + 1); }
    due = d.getTime();
  }
  if (!due || due <= now) return null;
  const rest = s.replace(m[0], " ")
    .replace(/(пожалуйста|поставь(те)?\s+напоминани[ея]|напомин(ай|ание)|напомни(те)?|не дай(те)?\s+(мне\s+)?забыть|разбуди(те)?(\s+меня)?|мне)(?![а-я])/gi, " ")
    .replace(/^[\s,.:;!—-]*(что(бы)?(?![а-я]))?[\s,.:;—-]*/i, "").replace(/\s+/g, " ").replace(/[\s,.;:!—-]+$/, "").trim();
  return { due, text: rest ? rest[0].toUpperCase() + rest.slice(1) : /разбуди/i.test(s) ? "Подъём" : "Напоминание" };
}
export const REMIND_INTENT_RE = /напомни|напомина|не дай(те)? (мне )?забыть|разбуди/i;
