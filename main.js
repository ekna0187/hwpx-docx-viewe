'use strict';
// HWPX = ZIP + XML (OWPML). JSZip으로 압축을 풀고, 브라우저 내장 DOMParser로 XML을 읽는다.

const $ = (id) => document.getElementById(id);
const PX = 1 / 75; // HWPUNIT(1/7200 inch) -> px(96dpi)
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

// ---- XML 헬퍼: 접두사(hp:, hh:)에 의존하지 않도록 localName으로 찾는다 ----
const kids = (el, n) => Array.from(el.children).filter((c) => c.localName === n);
const first = (el, n) => (el ? kids(el, n)[0] : undefined);
const all = (el, n) => Array.from(el.getElementsByTagNameNS('*', n));
const num = (v) => Number(v) || 0;

function parseXml(text, label) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${label} 파싱 실패`);
  return doc;
}
const findEntry = (zip, path) => {
  const p = path.replace(/^\.?\//, '').toLowerCase();
  return Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase() === p);
};
async function readXml(zip, path) {
  const f = findEntry(zip, path);
  if (!f) throw new Error(`${path} 파일이 없습니다`);
  return parseXml(await f.async('string'), path);
}
const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');

// ---- 1단계: header.xml 의 글자/문단 스타일 ----
function parseHeader(doc) {
  const charPr = new Map(), paraPr = new Map();
  for (const el of all(doc, 'charPr')) {
    const ul = first(el, 'underline'), st = first(el, 'strikeout');
    charPr.set(el.getAttribute('id'), {
      size: num(el.getAttribute('height')) / 100, // 1000 = 10pt
      color: el.getAttribute('textColor'),
      bold: !!first(el, 'bold'),
      italic: !!first(el, 'italic'),
      underline: !!ul && ul.getAttribute('type') !== 'NONE',
      strike: !!st && st.getAttribute('shape') !== 'NONE',
    });
  }
  for (const el of all(doc, 'paraPr')) {
    const align = all(el, 'align')[0]?.getAttribute('horizontal');
    const ls = all(el, 'lineSpacing')[0];
    paraPr.set(el.getAttribute('id'), {
      align: { CENTER: 'center', RIGHT: 'right', JUSTIFY: 'justify', LEFT: 'left' }[align],
      lineHeight: ls && ls.getAttribute('type') === 'PERCENT' ? num(ls.getAttribute('value')) / 100 : 0,
    });
  }
  return { charPr, paraPr };
}

// ---- 2단계: content.hpf (섹션 순서, 이미지 ID -> 파일) ----
async function loadManifest(zip) {
  const f = findEntry(zip, 'Contents/content.hpf');
  const items = new Map(); let spine = [];
  if (f) {
    const doc = parseXml(await f.async('string'), 'content.hpf');
    for (const it of all(doc, 'item')) items.set(it.getAttribute('id'), it.getAttribute('href'));
    spine = all(doc, 'itemref').map((r) => items.get(r.getAttribute('idref'))).filter((h) => /section\d+\.xml$/i.test(h || ''));
  }
  if (!spine.length) {
    spine = Object.keys(zip.files).filter((n) => /^contents\/section\d+\.xml$/i.test(n)).sort();
  }
  return { items, spine };
}
async function loadImages(zip, manifest) {
  const urls = new Map();
  for (const f of Object.values(zip.files)) {
    if (f.dir || !/^bindata\//i.test(f.name)) continue;
    const ext = f.name.split('.').pop().toLowerCase();
    const blob = new Blob([await f.async('uint8array')], { type: MIME[ext] || '' });
    urls.set(baseName(f.name), URL.createObjectURL(blob));
  }
  for (const [id, href] of manifest.items) {
    const u = href && urls.get(baseName(href));
    if (u) urls.set(id, u);
  }
  return urls;
}

// ---- 3단계: 렌더링 (textContent / append(text)만 사용 -> XSS 방지) ----
function renderText(t, span) {
  for (const n of t.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) span.append(n.data);
    else if (n.localName === 'lineBreak') span.append(document.createElement('br'));
    else if (n.localName === 'tab') span.append('\u2003');
    else if (n.localName === 'nbSpace') span.append('\u00A0');
    else if (n.localName === 'fwSpace') span.append('\u3000');
  }
}
function applyChar(span, c) {
  if (!c) return;
  if (c.size) span.style.fontSize = c.size + 'pt';
  if (/^#[0-9a-f]{6}$/i.test(c.color || '')) span.style.color = c.color;
  if (c.bold) span.style.fontWeight = 'bold';
  if (c.italic) span.style.fontStyle = 'italic';
  const deco = [c.underline && 'underline', c.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) span.style.textDecoration = deco;
}
function missing(msg) {
  const s = document.createElement('span'); s.className = 'missing'; s.textContent = msg; return s;
}
function renderPic(pic, ctx) {
  const ref = all(pic, 'img')[0]?.getAttribute('binaryItemIDRef');
  const url = ctx.urls.get(ref);
  if (!url) return missing(`[이미지 없음: ${ref}]`);
  const w = num(first(pic, 'curSz')?.getAttribute('width')) || num(first(pic, 'sz')?.getAttribute('width'));
  const img = new Image();
  img.src = url; img.alt = '문서 이미지'; img.style.maxWidth = '100%';
  if (w) img.style.width = w * PX + 'px';
  img.onerror = () => img.replaceWith(missing('[표시할 수 없는 이미지 형식]'));
  return img;
}
function renderTable(tbl, ctx) {
  const t = document.createElement('table'); t.className = 'hwpx-tbl';
  const sz = first(tbl, 'sz');
  if (sz) t.style.width = num(sz.getAttribute('width')) * PX + 'px';
  for (const tr of kids(tbl, 'tr')) {
    const row = t.insertRow();
    for (const tc of kids(tr, 'tc')) {
      const td = row.insertCell();
      const span = first(tc, 'cellSpan');
      if (span) { td.colSpan = num(span.getAttribute('colSpan')) || 1; td.rowSpan = num(span.getAttribute('rowSpan')) || 1; }
      const cw = num(first(tc, 'cellSz')?.getAttribute('width'));
      if (cw) td.style.width = cw * PX + 'px';
      for (const p of kids(first(tc, 'subList') || tc, 'p')) td.append(renderParagraph(p, ctx));
    }
  }
  return t;
}
function renderParagraph(p, ctx) {
  const box = document.createElement('div'); box.className = 'hwpx-p';
  const pp = ctx.styles.paraPr.get(p.getAttribute('paraPrIDRef'));
  if (pp?.align) box.style.textAlign = pp.align;
  if (pp?.lineHeight) box.style.lineHeight = pp.lineHeight;
  for (const run of kids(p, 'run')) {
    const cp = ctx.styles.charPr.get(run.getAttribute('charPrIDRef'));
    for (const node of run.children) {
      if (node.localName === 't') {
        const span = document.createElement('span');
        applyChar(span, cp); renderText(node, span); box.append(span);
      } else if (node.localName === 'tbl') box.append(renderTable(node, ctx));
      else if (node.localName === 'pic') box.append(renderPic(node, ctx));
    }
  }
  if (!box.childNodes.length) box.append(document.createElement('br')); // 빈 문단도 줄 높이 유지
  return box;
}
function renderSection(doc, ctx) {
  const sheet = document.createElement('section'); sheet.className = 'sheet';
  const pg = all(doc, 'pagePr')[0], mg = first(pg, 'margin');
  if (pg) sheet.style.width = num(pg.getAttribute('width')) * PX + 'px';
  if (mg) sheet.style.padding = ['top', 'right', 'bottom', 'left'].map((k) => num(mg.getAttribute(k)) * PX + 'px').join(' ');
  for (const p of kids(doc.documentElement, 'p')) sheet.append(renderParagraph(p, ctx));
  return sheet;
}

// ======================================================================
// DOCX (WordprocessingML) 렌더러 - HWPX와 같은 방식: JSZip + DOMParser
// ======================================================================
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TW = 1 / 15;        // twip(1/1440 inch) -> px(96dpi)
const EMU = 1 / 9525;     // EMU -> px
const wa = (el, n) => (el ? el.getAttributeNS(W, n) ?? el.getAttribute('w:' + n) : null);
const wfirst = (el, n) => (el ? Array.from(el.children).find((c) => c.localName === n) : undefined);
const on = (el) => !!el && !['0', 'false', 'off', 'none'].includes((wa(el, 'val') || '').toLowerCase());
const mergeObj = (a, b) => { const o = { ...a }; for (const k in b) if (b[k] !== undefined) o[k] = b[k]; return o; };

// 글자 속성 w:rPr -> {size, color, bold, ...}
function docxRPr(rPr) {
  if (!rPr) return {};
  const o = {};
  const sz = wfirst(rPr, 'sz'); if (sz) o.size = num(wa(sz, 'val')) / 2; // half-point
  const col = wfirst(rPr, 'color'); const cv = wa(col, 'val'); if (cv && /^[0-9a-f]{6}$/i.test(cv)) o.color = '#' + cv;
  if (wfirst(rPr, 'b')) o.bold = on(wfirst(rPr, 'b'));
  if (wfirst(rPr, 'i')) o.italic = on(wfirst(rPr, 'i'));
  if (wfirst(rPr, 'u')) o.underline = on(wfirst(rPr, 'u'));
  if (wfirst(rPr, 'strike')) o.strike = on(wfirst(rPr, 'strike'));
  const hl = wa(wfirst(rPr, 'highlight'), 'val'); if (hl && hl !== 'none') o.highlight = hl;
  const va = wa(wfirst(rPr, 'vertAlign'), 'val'); if (va) o.vert = va;
  const rf = wfirst(rPr, 'rFonts'); const font = wa(rf, 'eastAsia') || wa(rf, 'ascii'); if (font) o.font = font;
  return o;
}
// 문단 속성 w:pPr -> {jc, left, right, firstLine, before, after, line, lineRule, numId, ilvl}
function docxPPr(pPr) {
  if (!pPr) return {};
  const o = {};
  const jc = wa(wfirst(pPr, 'jc'), 'val');
  if (jc) o.jc = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: 'left', start: 'left' }[jc];
  const ind = wfirst(pPr, 'ind');
  if (ind) {
    const l = wa(ind, 'left') ?? wa(ind, 'start'), r = wa(ind, 'right') ?? wa(ind, 'end');
    if (l != null) o.left = num(l) * TW;
    if (r != null) o.right = num(r) * TW;
    if (wa(ind, 'hanging')) o.firstLine = -num(wa(ind, 'hanging')) * TW;
    else if (wa(ind, 'firstLine')) o.firstLine = num(wa(ind, 'firstLine')) * TW;
  }
  const sp = wfirst(pPr, 'spacing');
  if (sp) {
    if (wa(sp, 'before') != null) o.before = num(wa(sp, 'before')) * TW;
    if (wa(sp, 'after') != null) o.after = num(wa(sp, 'after')) * TW;
    if (wa(sp, 'line') != null) { o.line = num(wa(sp, 'line')); o.lineRule = wa(sp, 'lineRule') || 'auto'; }
  }
  const np = wfirst(pPr, 'numPr');
  if (np) { o.numId = wa(wfirst(np, 'numId'), 'val'); o.ilvl = num(wa(wfirst(np, 'ilvl'), 'val')); }
  return o;
}

// styles.xml: 기본값 + 스타일(basedOn 상속)
function parseDocxStyles(doc) {
  const map = new Map();
  let defR = {}, defP = {};
  if (doc) {
    const dd = all(doc, 'docDefaults')[0];
    defR = docxRPr(wfirst(wfirst(dd, 'rPrDefault'), 'rPr'));
    defP = docxPPr(wfirst(wfirst(dd, 'pPrDefault'), 'pPr'));
    for (const st of all(doc, 'style')) {
      map.set(wa(st, 'styleId'), {
        base: wa(wfirst(st, 'basedOn'), 'val'),
        p: docxPPr(wfirst(st, 'pPr')), r: docxRPr(wfirst(st, 'rPr')),
        isDefault: wa(st, 'default') === '1' && wa(st, 'type') === 'paragraph',
      });
    }
  }
  const resolve = (id, seen = new Set()) => {
    const st = map.get(id);
    if (!st || seen.has(id)) return { p: {}, r: {} };
    seen.add(id);
    const b = st.base ? resolve(st.base, seen) : { p: {}, r: {} };
    return { p: mergeObj(b.p, st.p), r: mergeObj(b.r, st.r) };
  };
  const defId = [...map].find(([, v]) => v.isDefault)?.[0];
  return { defR, defP, resolve, defId };
}

// numbering.xml: 글머리표/번호 매기기 (기본적인 형식만)
function parseNumbering(doc) {
  const abs = new Map(), nums = new Map();
  if (doc) {
    for (const a of all(doc, 'abstractNum')) {
      const lv = new Map();
      for (const l of kids(a, 'lvl')) lv.set(num(wa(l, 'ilvl')), {
        fmt: wa(wfirst(l, 'numFmt'), 'val'), text: wa(wfirst(l, 'lvlText'), 'val') || '',
        start: num(wa(wfirst(l, 'start'), 'val') ?? 1), pPr: docxPPr(wfirst(l, 'pPr')),
      });
      abs.set(wa(a, 'abstractNumId'), lv);
    }
    for (const n of all(doc, 'num')) nums.set(wa(n, 'numId'), wa(wfirst(n, 'abstractNumId'), 'val'));
  }
  const counters = new Map();
  return (numId, ilvl) => {
    const lv = abs.get(nums.get(numId))?.get(ilvl);
    if (!lv) return null;
    const key = numId + ':';
    for (const k of [...counters.keys()]) if (k.startsWith(key) && num(k.split(':')[1]) > ilvl) counters.delete(k);
    const c = (counters.get(key + ilvl) ?? lv.start - 1) + 1;
    counters.set(key + ilvl, c);
    let label;
    if (lv.fmt === 'bullet') label = /[-]/.test(lv.text) || !lv.text ? '•' : lv.text;
    else {
      const f = { lowerLetter: (n) => String.fromCharCode(96 + ((n - 1) % 26) + 1), upperLetter: (n) => String.fromCharCode(64 + ((n - 1) % 26) + 1), decimal: (n) => String(n) }[lv.fmt] || ((n) => String(n));
      label = lv.text.replace(/%(\d)/, () => f(c));
    }
    return { label, pPr: lv.pPr };
  };
}

// 관계(rels): rId -> 대상
async function loadDocxRels(zip) {
  const f = findEntry(zip, 'word/_rels/document.xml.rels');
  const rels = new Map();
  if (!f) return rels;
  for (const r of all(parseXml(await f.async('string'), 'document.xml.rels'), 'Relationship'))
    rels.set(r.getAttribute('Id'), { type: r.getAttribute('Type'), target: r.getAttribute('Target'), external: r.getAttribute('TargetMode') === 'External' });
  return rels;
}
async function loadDocxImages(zip, rels) {
  const urls = new Map();
  for (const [id, r] of rels) {
    if (r.external || !/\/image$/.test(r.type)) continue;
    const path = 'word/' + r.target.replace(/^\/?(word\/)?/, '');
    const f = findEntry(zip, path);
    if (!f) continue;
    const ext = f.name.split('.').pop().toLowerCase();
    urls.set(id, URL.createObjectURL(new Blob([await f.async('uint8array')], { type: MIME[ext] || '' })));
  }
  return urls;
}

function docxImage(rid, wpx, hpx, ctx) {
  const url = ctx.urls.get(rid);
  if (!url) return missing(`[이미지 없음: ${rid}]`);
  const img = new Image();
  img.src = url; img.alt = '문서 이미지'; img.style.maxWidth = '100%';
  if (wpx) img.style.width = wpx + 'px';
  if (hpx) img.style.height = 'auto';
  img.onerror = () => img.replaceWith(missing('[표시할 수 없는 이미지 형식]'));
  return img;
}

function docxRun(r, ctx, base, parent) {
  const rs = mergeObj(base, mergeObj(ctx.styles.resolve(wa(wfirst(wfirst(r, 'rPr'), 'rStyle'), 'val')).r, docxRPr(wfirst(r, 'rPr'))));
  let span = document.createElement('span');
  const flush = () => { if (span.childNodes.length) { applyChar(span, rs); styleExtra(span, rs); parent.append(span); } span = document.createElement('span'); };
  for (const n of r.children) {
    const ln = n.localName;
    if (ln === 't') span.append(/wingdings/i.test(rs.font || '') ? n.textContent.replace(/[qo\u00fe\u00fc\u00a8]/g, (c) => ({ q: '\u274F', o: '\u2610', '\u00fe': '\u2611', '\u00fc': '\u2713', '\u00a8': '\u2610' }[c])) : n.textContent);
    else if (ln === 'tab') span.append(' ');
    else if (ln === 'br' || ln === 'cr') span.append(document.createElement('br'));
    else if (ln === 'noBreakHyphen') span.append('‑');
    else if (ln === 'drawing') {
      const blip = all(n, 'blip')[0];
      const ext = all(n, 'extent')[0];
      if (blip) { flush(); parent.append(docxImage(blip.getAttributeNS(REL, 'embed') || blip.getAttribute('r:embed'), num(ext?.getAttribute('cx')) * EMU, num(ext?.getAttribute('cy')) * EMU, ctx)); }
    } else if (ln === 'pict') {
      const im = all(n, 'imagedata')[0];
      if (im) { flush(); parent.append(docxImage(im.getAttributeNS(REL, 'id') || im.getAttribute('r:id'), 0, 0, ctx)); }
    }
  }
  flush();
}
function styleExtra(span, c) {
  if (c.font) span.style.fontFamily = `"${c.font}", "Malgun Gothic", sans-serif`;
  if (c.highlight) span.style.backgroundColor = { yellow: '#ff0', green: '#0f0', cyan: '#0ff', magenta: '#f0f', blue: '#00f', red: '#f00', lightGray: '#d3d3d3' }[c.highlight] || '#ff0';
  if (c.vert === 'superscript') span.style.verticalAlign = 'super';
  if (c.vert === 'subscript') span.style.verticalAlign = 'sub';
  if (c.vert) span.style.fontSize = (c.size ? c.size * 0.7 : 7) + 'pt';
}

function docxParagraph(p, ctx) {
  const box = document.createElement('div'); box.className = 'hwpx-p';
  const pPr = wfirst(p, 'pPr');
  const sid = wa(wfirst(pPr, 'pStyle'), 'val') || ctx.styles.defId;
  const st = ctx.styles.resolve(sid);
  let pp = mergeObj(ctx.styles.defP, mergeObj(st.p, docxPPr(pPr)));
  const base = mergeObj(ctx.styles.defR, st.r);
  box.style.whiteSpace = 'pre-wrap';
  let label = null;
  if (pp.numId && pp.numId !== '0') {
    label = ctx.numbering(pp.numId, pp.ilvl || 0);
    if (label) pp = mergeObj(pp, mergeObj(label.pPr, docxPPr(pPr)));
  }
  if (pp.jc) box.style.textAlign = pp.jc;
  if (pp.left) box.style.marginLeft = pp.left + 'px';
  if (pp.right) box.style.marginRight = pp.right + 'px';
  if (pp.firstLine) box.style.textIndent = pp.firstLine + 'px';
  if (pp.before) box.style.marginTop = pp.before + 'px';
  if (pp.after) box.style.marginBottom = pp.after + 'px';
  if (pp.line) {
    if (pp.lineRule === 'auto') box.style.lineHeight = pp.line / 240;
    else box.style.lineHeight = pp.line * TW + 'px';
  }
  box.style.fontSize = (base.size || 11) + 'pt';
  if (label) box.append(label.label + ' ');
  const add = (container) => {
    for (const n of container.children) {
      if (n.localName === 'r') docxRun(n, ctx, base, box);
      else if (n.localName === 'hyperlink') {
        const target = ctx.rels.get(n.getAttributeNS(REL, 'id') || n.getAttribute('r:id'));
        const a = document.createElement('a');
        if (target?.external && /^(https?:|mailto:)/i.test(target.target)) { a.href = target.target; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        for (const r of kids(n, 'r')) docxRun(r, ctx, mergeObj(base, { color: '#0563c1', underline: true }), a);
        box.append(a);
      } else if (['smartTag', 'sdt', 'ins', 'fldSimple'].includes(n.localName)) add(wfirst(n, 'sdtContent') || n);
    }
  };
  add(p);
  if (!box.childNodes.length) box.append(document.createElement('br'));
  return box;
}

function docxTable(tbl, ctx) {
  const t = document.createElement('table'); t.className = 'hwpx-tbl';
  const hasBorder = !!wfirst(wfirst(tbl, 'tblPr'), 'tblBorders');
  const grid = kids(wfirst(tbl, 'tblGrid') || tbl, 'gridCol').map((g) => num(wa(g, 'w')) * TW);
  if (grid.length) t.style.width = grid.reduce((a, b) => a + b, 0) + 'px';
  const open = []; // 세로 병합 추적: 열 index -> td
  for (const tr of kids(tbl, 'tr')) {
    const row = t.insertRow(); let col = 0;
    for (const tc of kids(tr, 'tc')) {
      const tcPr = wfirst(tc, 'tcPr');
      const span = num(wa(wfirst(tcPr, 'gridSpan'), 'val')) || 1;
      const vm = wfirst(tcPr, 'vMerge');
      if (vm && wa(vm, 'val') !== 'restart') { // 위 셀에 이어지는 병합 셀
        if (open[col]) open[col].rowSpan += 1;
        col += span; continue;
      }
      const td = row.insertCell();
      if (span > 1) td.colSpan = span;
      if (vm) open[col] = td; else open[col] = null;
      const w = num(wa(wfirst(tcPr, 'tcW'), 'w')) * TW || grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      if (w) td.style.width = w + 'px';
      const shd = wa(wfirst(tcPr, 'shd'), 'fill'); if (/^[0-9a-f]{6}$/i.test(shd || '')) td.style.backgroundColor = '#' + shd;
      if (!hasBorder) td.style.border = 'none';
      for (const n of tc.children) {
        if (n.localName === 'p') td.append(docxParagraph(n, ctx));
        else if (n.localName === 'tbl') td.append(docxTable(n, ctx));
      }
      col += span;
    }
  }
  return t;
}

function renderDocxSection(sectPr, blocks, ctx) {
  const sheet = document.createElement('section'); sheet.className = 'sheet';
  const sz = wfirst(sectPr, 'pgSz'), mg = wfirst(sectPr, 'pgMar');
  sheet.style.width = (sz ? num(wa(sz, 'w')) : 11906) * TW + 'px';
  const m = (k, d) => (mg ? num(wa(mg, k)) : d) * TW + 'px';
  sheet.style.padding = [m('top', 1440), m('right', 1440), m('bottom', 1440), m('left', 1440)].join(' ');
  for (const n of blocks) sheet.append(n.localName === 'tbl' ? docxTable(n, ctx) : docxParagraph(n, ctx));
  return sheet;
}

async function renderDocx(zip, viewer) {
  const docXml = await readXml(zip, 'word/document.xml');
  const rels = await loadDocxRels(zip);
  const urls = await loadDocxImages(zip, rels);
  const stF = findEntry(zip, 'word/styles.xml'), nmF = findEntry(zip, 'word/numbering.xml');
  const styles = parseDocxStyles(stF ? parseXml(await stF.async('string'), 'styles.xml') : null);
  const numbering = parseNumbering(nmF ? parseXml(await nmF.async('string'), 'numbering.xml') : null);
  const ctx = { styles, numbering, rels, urls };
  const body = all(docXml, 'body')[0];
  // 섹션 나누기(문단 안의 sectPr)마다 새 용지로 나눈다. 마지막 sectPr는 body 직계.
  let blocks = [], sections = 0;
  for (const n of body.children) {
    if (n.localName === 'p' || n.localName === 'tbl') blocks.push(n);
    if (n.localName === 'p') {
      const sp = wfirst(wfirst(n, 'pPr'), 'sectPr');
      if (sp) { viewer.append(renderDocxSection(sp, blocks, ctx)); blocks = []; sections++; }
    }
  }
  if (blocks.length || !sections) { viewer.append(renderDocxSection(wfirst(body, 'sectPr'), blocks, ctx)); sections++; }
  return { urls, sections };
}

// ---- 4단계: 파일 열기 / UI (형식 자동 판별) ----
let currentUrls = [];

// 확장자가 아니라 파일 내용(시그니처 + ZIP 내부 구조)으로 형식을 판별한다.
async function detectFormat(file) {
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isZip = b[0] === 0x50 && b[1] === 0x4b;
  const isOle = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // 구형 .hwp / .doc
  if (isOle) return { type: 'ole' };
  if (!isZip) return { type: 'unknown' };
  const zip = await JSZip.loadAsync(file);
  if (findEntry(zip, 'word/document.xml')) return { type: 'docx', zip };
  if (findEntry(zip, 'Contents/header.xml') || findEntry(zip, 'Contents/content.hpf')) return { type: 'hwpx', zip };
  return { type: 'unknown' };
}

async function renderHwpx(zip, viewer) {
  const styles = parseHeader(await readXml(zip, 'Contents/header.xml'));
  const manifest = await loadManifest(zip);
  const urls = await loadImages(zip, manifest);
  const ctx = { styles, urls };
  for (const path of manifest.spine) viewer.append(renderSection(await readXml(zip, path), ctx));
  return { urls, sections: manifest.spine.length };
}

async function openFile(file) {
  const status = $('status'), viewer = $('viewer');
  status.className = ''; status.textContent = `${file.name} 여는 중...`;
  currentUrls.forEach(URL.revokeObjectURL); currentUrls = []; viewer.replaceChildren();
  try {
    const fmt = await detectFormat(file);
    if (fmt.type === 'ole') throw new Error('구형 바이너리 형식(.hwp / .doc)은 지원하지 않습니다. .hwpx 또는 .docx로 저장해 주세요.');
    if (fmt.type === 'unknown') throw new Error('지원하지 않는 파일 형식입니다. (.hwpx, .docx만 가능)');
    const { urls, sections } = fmt.type === 'docx' ? await renderDocx(fmt.zip, viewer) : await renderHwpx(fmt.zip, viewer);
    currentUrls = [...urls.values()];
    const zip = fmt.zip;
    $('tree').textContent = Object.values(zip.files).map((f) => (f.dir ? f.name : `${f.name}  (${f._data?.uncompressedSize ?? '?'} B)`)).join('\n');
    $('structure').hidden = false;
    status.textContent = `${file.name} [${fmt.type.toUpperCase()}] - 섹션 ${sections}개, 이미지 ${urls.size}개`;
  } catch (e) {
    status.className = 'error';
    status.textContent = `열 수 없습니다: ${e.message}`; // 암호화/배포용 문서는 접근이 막혀 있을 수 있다
  }
}

$('file').addEventListener('change', (e) => e.target.files[0] && openFile(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && openFile(e.dataTransfer.files[0]));
