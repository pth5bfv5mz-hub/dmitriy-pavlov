/* Документы, которые делает Дмитрий Павлов: Word (.docx), PDF и текст — собираются прямо на телефоне,
   без сервера. Источник — простой Markdown: заголовки (#), списки (-, 1.), **жирный**, *курсив*, таблицы (| a | b |).
   Библиотеки (fflate, pdf-lib, шрифт с кириллицей) грузятся только когда нужен документ; см. lib/docs/NOTICE.txt. */
const LIB = new URL("../lib/docs/", import.meta.url).href;

/* ---------- Разбор Markdown в блоки ---------- */
export function parseBlocks(md) {
  const out = []; let para = [];
  const flush = () => { if (para.length) { out.push({ t: "p", text: para.join(" ") }); para = []; } };
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], s = line.trim();
    if (!s) { flush(); continue; }
    let m;
    if ((m = s.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push({ t: "h", level: m[1].length, text: m[2] }); continue; }
    if ((m = s.match(/^[-*•]\s+(.*)$/))) { flush(); out.push({ t: "li", text: m[1] }); continue; }
    if ((m = s.match(/^(\d+)[.)]\s+(.*)$/))) { flush(); out.push({ t: "ol", n: +m[1], text: m[2] }); continue; }
    if (/^\|.*\|$/.test(s)) {   // таблица: строки «| … |», строку-разделитель «|---|» пропускаем
      flush(); const rows = [];
      for (; i < lines.length && /^\|.*\|$/.test(lines[i].trim()); i++) {
        const r = lines[i].trim();
        if (/^\|[\s:|-]+\|$/.test(r)) continue;
        rows.push(r.slice(1, -1).split("|").map(c => c.trim()));
      }
      i--; if (rows.length) out.push({ t: "table", rows }); continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(s)) { flush(); out.push({ t: "hr" }); continue; }
    para.push(s);
  }
  flush();
  return out;
}
/* Куски строки с оформлением: **жирный**, *курсив* */
export function runs(text) {
  const out = []; const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const bold = m[0].startsWith("**");
    out.push({ text: m[0].slice(bold ? 2 : 1, bold ? -2 : -1), b: bold, i: !bold });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.map(r => ({ ...r, text: r.text.replace(/`/g, "") }));
}

/* ---------- Word (.docx) ---------- */
const xesc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const wRuns = text => runs(text).map(r => `<w:r>${r.b || r.i ? `<w:rPr>${r.b ? "<w:b/>" : ""}${r.i ? "<w:i/>" : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${xesc(r.text)}</w:t></w:r>`).join("");
const wPara = (text, style, extra = "") => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}${wRuns(text)}</w:p>`;
export async function makeDocx(title, md) {
  const { zipSync, strToU8 } = await import(LIB + "fflate.js");
  const body = [];
  if (title && !/^#\s/.test(String(md).trim())) body.push(wPara(title, "Title"));
  for (const b of parseBlocks(md)) {
    if (b.t === "h") body.push(wPara(b.text, "Heading" + Math.min(3, b.level)));
    else if (b.t === "li") body.push(wPara("•\t" + b.text, "", `<w:ind w:left="567" w:hanging="283"/>`));
    else if (b.t === "ol") body.push(wPara(b.n + ".\t" + b.text, "", `<w:ind w:left="567" w:hanging="340"/>`));
    else if (b.t === "hr") body.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`);
    else if (b.t === "table") {
      const cols = Math.max(...b.rows.map(r => r.length));
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join("")}</w:tblBorders></w:tblPr>` +
        b.rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${wPara(ri === 0 ? "**" + (r[ci] || "").replace(/\*\*/g, "") + "**" : r[ci] || "")}</w:tc>`).join("")}</w:tr>`).join("") + `</w:tbl>`);
      body.push("<w:p/>");
    } else body.push(wPara(b.text));
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const st = (id, name, sz, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>${extra}</w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${st("Title", "Title", 36)}${st("Heading1", "heading 1", 32, '<w:outlineLvl w:val="0"/>')}${st("Heading2", "heading 2", 28, '<w:outlineLvl w:val="1"/>')}${st("Heading3", "heading 3", 25, '<w:outlineLvl w:val="2"/>')}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/document.xml": doc,
    "word/styles.xml": styles,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xesc(title || "")}</dc:title><dc:creator>Дмитрий Павлов</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
  return new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/* ---------- PDF ---------- */
const scripts = {};
function loadScript(src) {
  return scripts[src] || (scripts[src] = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => { delete scripts[src]; rej(new Error("Не загрузилась библиотека PDF. Проверь интернет.")); };
    document.head.append(s);
  }));
}
let fontsP = null;
const fonts = () => fontsP || (fontsP = Promise.all(["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map(f => fetch(LIB + f).then(r => { if (!r.ok) throw new Error("font"); return r.arrayBuffer(); })))
  .catch(e => { fontsP = null; throw e; }));
export async function makePdf(title, md) {
  await Promise.all([loadScript(LIB + "pdf-lib.min.js"), loadScript(LIB + "fontkit.min.js")]);
  const { PDFDocument, rgb } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(window.fontkit);
  const [reg, bold] = await fonts();
  const F = await pdf.embedFont(reg, { subset: true }), FB = await pdf.embedFont(bold, { subset: true });
  pdf.setTitle(title || "Документ"); pdf.setCreator("Дмитрий Павлов"); pdf.setLanguage("ru-RU");
  const W = 595.28, H = 841.89, M = 56, maxW = W - 2 * M;
  let page, y;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  newPage();
  // Перенос строк по ширине (с учётом жирных кусков)
  const layout = (rs, size, indent = 0) => {
    const words = []; rs.forEach(r => String(r.text).split(/(\s+)/).forEach(w => { if (w) words.push({ w, f: r.b ? FB : F }); }));
    const lines = []; let line = [], width = 0; const lim = maxW - indent;
    for (const t of words) {
      const tw = t.f.widthOfTextAtSize(t.w, size);
      if (/^\s+$/.test(t.w)) { if (line.length) { line.push(t); width += tw; } continue; }
      if (width + tw > lim && line.length) { while (line.length && /^\s+$/.test(line[line.length - 1].w)) line.pop(); lines.push(line); line = []; width = 0; }
      if (tw > lim) {   // очень длинное слово (ссылка) — режем по буквам
        let chunk = ""; for (const ch of t.w) { if (t.f.widthOfTextAtSize(chunk + ch, size) > lim) { lines.push([{ w: chunk, f: t.f }]); chunk = ""; } chunk += ch; }
        line = [{ w: chunk, f: t.f }]; width = t.f.widthOfTextAtSize(chunk, size); continue;
      }
      line.push(t); width += tw;
    }
    if (line.length) lines.push(line);
    return lines;
  };
  const draw = (rs, size, { indent = 0, before = 0, after = 6, color = rgb(0.08, 0.09, 0.1), bullet = "" } = {}) => {
    const lh = size * 1.38;
    y -= before;
    layout(rs, size, indent).forEach((line, li) => {
      if (y - lh < M) newPage();
      y -= lh;
      if (li === 0 && bullet) page.drawText(bullet, { x: M + indent - F.widthOfTextAtSize(bullet + " ", size), y, size, font: F, color });
      let x = M + indent;
      for (const t of line) { page.drawText(t.w, { x, y, size, font: t.f, color }); x += t.f.widthOfTextAtSize(t.w, size); }
    });
    y -= after;
  };
  if (title && !/^#\s/.test(String(md).trim())) draw([{ text: title, b: true }], 20, { after: 12 });
  for (const b of parseBlocks(md)) {
    if (b.t === "h") draw(runs(b.text).map(r => ({ ...r, b: true })), [18, 15, 13, 12][b.level - 1] || 12, { before: 8, after: 6 });
    else if (b.t === "li") draw(runs(b.text), 11.5, { indent: 18, bullet: "•", after: 3 });
    else if (b.t === "ol") draw(runs(b.text), 11.5, { indent: 22, bullet: b.n + ".", after: 3 });
    else if (b.t === "hr") { if (y - 12 < M) newPage(); y -= 8; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }); y -= 8; }
    else if (b.t === "table") b.rows.forEach((r, ri) => draw(runs(r.join("  ·  ")).map(x => ({ ...x, b: x.b || ri === 0 })), 11, { after: 2 }));
    else draw(runs(b.text), 11.5);
  }
  // Номера страниц
  const pages = pdf.getPages();
  if (pages.length > 1) pages.forEach((p, i) => { const s = `${i + 1} / ${pages.length}`; p.drawText(s, { x: W / 2 - F.widthOfTextAtSize(s, 9) / 2, y: 28, size: 9, font: F, color: rgb(0.5, 0.5, 0.5) }); });
  return new Blob([await pdf.save()], { type: "application/pdf" });
}

/* ---------- Общее ---------- */
export const FORMATS = { docx: "Word", pdf: "PDF", txt: "текст", md: "текст" };
export function fileName(name, format) {
  const base = String(name || "Документ").replace(/\.(docx?|pdf|txt|md)$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Документ";
  return base + "." + (format === "md" ? "txt" : format);
}
export async function makeFile(name, format, md) {
  const title = String(name || "").replace(/\.(docx?|pdf|txt|md)$/i, "");
  if (format === "pdf") return makePdf(title, md);
  if (format === "docx") return makeDocx(title, md);
  return new Blob([String(md)], { type: "text/plain;charset=utf-8" });
}
/* Отправить файл: «Поделиться» (Файлы, Telegram, почта, AirDrop); нет «Поделиться» — скачать. */
export async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return "shared"; }
  } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
/* Блоки файлов в ответе модели:
   <<<FILE name="Отчёт" format="docx"
   …Markdown…
   FILE>>>                                                                  */
export function extractFiles(text) {
  const out = []; const re = /<<<\s*FILE([^\n]*)\n([\s\S]*?)(?:FILE\s*>>>|$)/g; let m;
  while ((m = re.exec(String(text || "")))) {
    const attrs = m[1]; const name = (attrs.match(/name\s*=\s*"([^"]*)"/) || [])[1] || "Документ";
    let format = ((attrs.match(/format\s*=\s*"?(\w+)/) || [])[1] || (name.match(/\.(docx|pdf|txt|md)$/i) || [])[1] || "docx").toLowerCase();
    if (format === "doc" || format === "word") format = "docx";
    if (!FORMATS[format]) format = "docx";
    const content = m[2].replace(/<<<\s*ACTIONS[\s\S]*$/, "").trim();
    if (content) out.push({ name, format, content });
  }
  return out;
}

/* ---------- Точечные правки в его собственном Word ----------
   Модель не переписывает документ, а присылает список замен:
   <<<EDIT doc="Название"
   [{"find":"точный фрагмент из текста","replace":"как должно быть"}]
   EDIT>>>
   Приложение вносит их в исходный .docx режимом рецензирования (w:del / w:ins, ECMA-376 §17.13.5):
   оформление, сноски, таблицы и стили остаются как были, а в Word видно каждое изменение — его можно принять или отклонить. */
export function extractEdits(text) {
  const out = []; const re = /<<<\s*EDIT([^\n]*)\n([\s\S]*?)(?:EDIT\s*>>>|$)/g; let m;
  while ((m = re.exec(String(text || "")))) {
    const doc = (m[1].match(/doc\s*=\s*"([^"]*)"/) || [])[1] || "";
    let list = null;
    try { list = JSON.parse(m[2].trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); } catch {}
    const edits = (Array.isArray(list) ? list : []).filter(e => e && typeof e.find === "string" && e.find.trim() && typeof (e.replace ?? "") === "string")
      .slice(0, 200).map(e => ({ find: e.find.slice(0, 2000), replace: String(e.replace ?? "").slice(0, 4000) }));
    if (edits.length) out.push({ doc, edits });
  }
  return out;
}
const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", XMLNS = "http://www.w3.org/XML/1998/namespace";
// Сравниваем без разницы в кавычках, тире и неразрывных пробелах — замена символ в символ, позиции не сдвигаются
const fold = s => s.replace(/[«»„“”"]/g, '"').replace(/[‘’‚']/g, "'").replace(/[–—‒]/g, "-").replace(/[   ]/g, " ");
const ZERO = new Set(["rPr", "lastRenderedPageBreak", "softHyphen", "proofErr"]);
function runText(r) {
  let s = "";
  for (const c of r.children) {
    if (c.namespaceURI !== WNS || ZERO.has(c.localName)) continue;
    s += c.localName === "t" ? c.textContent : c.localName === "tab" ? "\t" : c.localName === "br" || c.localName === "cr" ? "\n" : c.localName === "noBreakHyphen" ? "-" : "￼";
  }
  return s;
}
const closest = (el, name) => { for (let x = el.parentElement; x; x = x.parentElement) if (x.namespaceURI === WNS && x.localName === name) return x; return null; };
// Каждый прогон — с одним содержимым: так его можно разрезать по символу, не трогая соседние
function explode(r) {
  const rPr = [...r.children].find(c => c.localName === "rPr");
  const parts = [...r.children].filter(c => c !== rPr && !(c.namespaceURI === WNS && ZERO.has(c.localName) && c.localName !== "rPr"));
  if (parts.length <= 1) return;
  for (const c of parts) { const n = r.ownerDocument.createElementNS(WNS, "w:r"); if (rPr) n.append(rPr.cloneNode(true)); n.append(c); r.before(n); }
  r.remove();
}
function paraRuns(p) {
  return [...p.getElementsByTagNameNS(WNS, "r")].filter(r => closest(r, "p") === p && !closest(r, "del") && !closest(r, "moveFrom"));
}
function mapRuns(p) {
  let pos = 0; const list = [];
  for (const r of paraRuns(p)) { const t = runText(r); list.push({ r, start: pos, end: pos + t.length, t }); pos += t.length; }
  return { list, text: list.map(x => x.t).join("") };
}
function splitAt(p, at) {
  const { list } = mapRuns(p);
  const x = list.find(y => y.start < at && at < y.end); if (!x) return;
  const tEl = [...x.r.children].find(c => c.localName === "t"); if (!tEl) return;
  const k = at - x.start, second = x.r.cloneNode(true), t2 = [...second.children].find(c => c.localName === "t");
  t2.textContent = tEl.textContent.slice(k); tEl.textContent = tEl.textContent.slice(0, k);
  [tEl, t2].forEach(t => t.setAttributeNS(XMLNS, "xml:space", "preserve"));
  x.r.after(second);
}
/* Отмечаем только изменившиеся слова: общее начало и конец фразы остаются как были (и с прежним оформлением). */
function trimCommon(find, rep) {
  const a = fold(find), b = fold(rep);
  const edge = (x, i) => i <= 0 || i >= x.length || /\s/.test(x[i - 1]) || /\s/.test(x[i]);   // граница слова
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  while (pre > 0 && !(edge(a, pre) && edge(b, pre))) pre--;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  while (suf > 0 && !(edge(a, a.length - suf) && edge(b, b.length - suf))) suf--;
  return { pre, suf };
}
function applyInPara(p, edit, mk) {
  paraRuns(p).forEach(explode);
  const find = fold(edit.find);
  const found = fold(mapRuns(p).text).indexOf(find); if (found < 0) return false;
  const text = edit.replace.replace(/\s*\n\s*/g, " ");
  const { pre, suf } = trimCommon(edit.find, text);
  const at = found + pre, end = found + find.length - suf, add = text.slice(pre, text.length - suf);
  if (at >= end && !add) return true;   // менять нечего
  splitAt(p, at); splitAt(p, end);
  const runs = mapRuns(p).list;
  const hit = runs.filter(x => x.start >= at && x.end <= end && (x.end > x.start || (x.start > at && x.end < end)));
  const d = p.ownerDocument;
  const mkIns = like => {
    const ins = mk("ins"), r = d.createElementNS(WNS, "w:r"), rPr = like && [...like.children].find(c => c.localName === "rPr");
    if (rPr) r.append(rPr.cloneNode(true));
    const t = d.createElementNS(WNS, "w:t"); t.setAttributeNS(XMLNS, "xml:space", "preserve"); t.textContent = add; r.append(t);
    ins.append(r); return ins;
  };
  if (at >= end) {   // только вставка — после прогона, который кончается здесь (или перед тем, что начинается)
    const before = runs.filter(x => x.end === at && x.end > x.start).pop(), after = runs.find(x => x.start === at && x.end > x.start);
    const ref = before || after; if (!ref || closest(ref.r, "ins")) return false;
    const ins = mkIns(ref.r); before ? before.r.after(ins) : after.r.before(ins);
    return true;
  }
  if (!hit.length || hit.some(x => x.r.parentNode !== hit[0].r.parentNode) || closest(hit[0].r, "ins")) return false;
  const del = mk("del"); hit[0].r.before(del);
  for (const x of hit) {
    for (const t of [...x.r.children].filter(c => c.localName === "t")) { const dt = d.createElementNS(WNS, "w:delText"); dt.setAttributeNS(XMLNS, "xml:space", "preserve"); dt.textContent = t.textContent; t.replaceWith(dt); }
    del.append(x.r);
  }
  if (add) del.after(mkIns(hit[0].r));
  return true;
}
export async function applyDocxEdits(bytes, edits, author = "Дмитрий Павлов") {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import(LIB + "fflate.js");
  const files = unzipSync(new Uint8Array(bytes));
  const names = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"].filter(n => files[n]);
  if (!names.length) throw new Error("Это не похоже на документ Word.");
  const xml = {}, docs = {};
  for (const n of names) {
    xml[n] = strFromU8(files[n]);
    const d = new DOMParser().parseFromString(xml[n], "application/xml");
    if (!d.getElementsByTagName("parsererror").length) docs[n] = d;
  }
  let id = Math.max(0, ...Object.values(xml).flatMap(s => [...s.matchAll(/w:id="(-?\d+)"/g)].map(m => +m[1]))) + 1;
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const applied = [], missed = [], touched = new Set();
  for (const e of edits) {
    let ok = false;
    for (const n of Object.keys(docs)) {
      const d = docs[n];
      const mk = tag => { const el = d.createElementNS(WNS, "w:" + tag); el.setAttributeNS(WNS, "w:id", String(id++)); el.setAttributeNS(WNS, "w:author", author); el.setAttributeNS(WNS, "w:date", date); return el; };
      for (const p of [...d.getElementsByTagNameNS(WNS, "p")]) if (applyInPara(p, e, mk)) { ok = true; touched.add(n); break; }
      if (ok) break;
    }
    (ok ? applied : missed).push(e);
  }
  for (const n of touched) {
    let s = new XMLSerializer().serializeToString(docs[n]);
    if (!/^<\?xml/.test(s)) s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + s;
    files[n] = strToU8(s);
  }
  const blob = new Blob([zipSync(files, { level: 6 })], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  return { blob, applied, missed };
}
