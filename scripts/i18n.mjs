/*
 * Translation tooling for rozka.work (English source, Hindi and Marathi pages).
 *
 * How it works (gettext style): text that should be translated is MARKED in index.html with a bare `data-i` attribute (a whole
 * element's inner HTML) and attributes with `data-ia="aria-label,placeholder"`. Script text is wrapped in _('English text').
 * The translation files i18n/hi.json and i18n/mr.json map the English text to its translation. If a phrase has no translation,
 * the page keeps the English (and `node scripts/i18n.mjs check` lists what is missing).
 *
 *   node scripts/i18n.mjs scan    dry run: what would be marked
 *   node scripts/i18n.mjs mark    add data-i / data-ia to any unmarked text in index.html (safe to re-run)
 *   node scripts/i18n.mjs check   missing translations, broken tags, leftover English in the translated files
 *   node scripts/i18n.mjs export  write i18n/review.tsv (English | Hindi | Marathi) for a native speaker to review
 *
 * build.mjs imports applyTranslations() / collectScriptStrings() from here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pageStrings } from './pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LANGS = ['hi', 'mr'];

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source']);
const OPAQUE = new Set(['script', 'style', 'svg', 'noscript', 'textarea']);
const INLINE = new Set(['a', 'b', 'strong', 'em', 'i', 'span', 'br', 'small', 'code', 'mark', 'abbr', 'sub', 'sup', 'wbr', 'u', 's', 'time', 'kbd']);
const ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/g;

// Elements whose text is rewritten by scripts, or that are brand marks: never marked statically.
const SKIP_IDS = new Set(['kName', 'kTime', 'kSay', 'payBig', 'cPresent', 'cLate', 'cOut', 'logLast', 'feed', 'depts', 'lcTag', 'lcBody', 'lcQ', 'auditN', 'seenTxt',
  'catchMsg', 'oWorkers', 'oSalary', 'oMin', 'leakMonth', 'leakYear', 'monthTotal', 'oEstStaff', 'estMonth', 'estStaff', 'estMore', 'rulesK', 'rulesV',
  'ilist', 'ipanel', 'rlist', 'rpanel', 'cal', 'sent', 'yMsg', 'auditToast', 'footNote']);
const SKIP_CLASSES = new Set(['wm', 'clock', 'wm-o']);
// Mock product screens (the hero window and the five capability panels) stay in English on purpose: they show the real product
// UI and nothing is promised about Hindi/Marathi screens. The element's own attributes (aria-label) are still translated.
const MOCK_CLASSES = new Set(['stage', 'cap-vis']);

function parseAttrs(s) {
  const o = {}; const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g; let m;
  while ((m = re.exec(s))) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return o;
}

export function parse(html) {
  const root = { tag: '#root', children: [], start: 0, openEnd: 0, attrMap: {} };
  const stack = [root]; let pos = 0, m; TAG_RE.lastIndex = 0;
  const addText = (a, b) => { if (b > a) stack[stack.length - 1].children.push({ type: 'text', start: a, end: b }); };
  while ((m = TAG_RE.exec(html))) {
    addText(pos, m.index); pos = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3] || '', selfClose = m[4] === '/';
    if (closing) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack[i].closeStart = m.index; stack[i].end = pos; stack.length = i; break; } continue; }
    const node = { type: 'el', tag, start: m.index, openEnd: pos, children: [], attrMap: parseAttrs(attrs), parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (OPAQUE.has(tag)) {
      const re = new RegExp('</' + tag + '\\s*>', 'ig'); re.lastIndex = pos; const c = re.exec(html);
      node.closeStart = c ? c.index : html.length; node.end = c ? c.index + c[0].length : html.length; node.opaque = true; TAG_RE.lastIndex = pos = node.end; continue;
    }
    if (VOID.has(tag) || selfClose) { node.end = pos; node.closeStart = pos; continue; }
    stack.push(node);
  }
  addText(pos, html.length); return root;
}

const stripEnt = (t) => t.replace(/&[#\w]+;/g, ' ');
export const hasWords = (t) => /[A-Za-z]{2,}/.test(stripEnt(t));
export const norm = (t) => t.replace(/\s+/g, ' ').trim();
// What a visitor reads: tags removed, entities decoded. Used to map a translated label back to its English original for analytics.
export const plain = (t) => norm(t.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

function safeInline(el) {
  return el.children.every((c) => c.type === 'text' || (INLINE.has(c.tag) && !c.opaque && !c.attrMap['data-f'] && safeInline(c)));
}
function skipEl(el) {
  if (el.opaque || el.attrMap['data-no-i'] !== undefined || (el.attrMap.id && SKIP_IDS.has(el.attrMap.id))) return true;
  return (el.attrMap.class || '').split(/\s+/).some((c) => SKIP_CLASSES.has(c));
}

// Walks the body and returns edits ({at, insert}) plus the list of strings found. `html` is the whole file.
export function plan(html) {
  const root = parse(html), edits = [], units = [], attrs = [];
  const body = (function find(n) { for (const c of n.children || []) { if (c.type !== 'el') continue; if (c.tag === 'body') return c; const r = find(c); if (r) return r; } return null; })(root);
  const text = (c) => html.slice(c.start, c.end);
  function openTagEnd(el) { return el.openEnd - 1 - (html[el.openEnd - 2] === '/' ? 1 : 0); }   // index of the '>' (or '/>')
  function addAttrEdit(el) {
    if (el.attrMap['data-ia'] !== undefined) { for (const a of String(el.attrMap['data-ia']).split(',')) if (el.attrMap[a]) attrs.push(norm(el.attrMap[a])); return; }
    const found = ATTRS.filter((a) => el.attrMap[a] && hasWords(el.attrMap[a]));
    if (!found.length) return;
    found.forEach((a) => attrs.push(norm(el.attrMap[a])));
    edits.push({ at: openTagEnd(el), insert: ` data-ia="${found.join(',')}"` });
  }
  function walk(parent) {
    for (const el of parent.children) {
      if (el.type !== 'el' || skipEl(el)) continue;
      addAttrEdit(el);
      if ((el.attrMap.class || '').split(/\s+/).some((c) => MOCK_CLASSES.has(c))) continue;
      if (el.attrMap['data-i'] !== undefined) { units.push(norm(html.slice(el.openEnd, el.closeStart))); continue; }
      const direct = el.children.filter((c) => c.type === 'text' && hasWords(text(c)));
      if (direct.length) {
        if (safeInline(el) && !['svg'].includes(el.tag)) {
          edits.push({ at: openTagEnd(el), insert: ' data-i' }); units.push(norm(html.slice(el.openEnd, el.closeStart)));
        } else {
          for (const c of direct) {
            const raw = text(c), lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
            edits.push({ at: c.start + lead, insert: '<span data-i>' }); edits.push({ at: c.end - trail, insert: '</span>' });
            units.push(norm(raw));
          }
          walk(el);
        }
      } else walk(el);
    }
  }
  if (body) walk(body);
  return { edits, units, attrs };
}

export function applyEdits(html, edits) {
  return [...edits].sort((a, b) => b.at - a.at || (a.insert === '</span>' ? -1 : 1)).reduce((s, e) => s.slice(0, e.at) + e.insert + s.slice(e.at), html);
}

// All marked strings already in the file (unit inner HTML and attribute values).
export function markedStrings(html) {
  const root = parse(html), units = new Set(), attrs = new Set();
  (function walk(n) {
    for (const el of n.children || []) {
      if (el.type !== 'el') continue;
      if (el.attrMap['data-ia'] !== undefined) for (const a of String(el.attrMap['data-ia']).split(',')) if (el.attrMap[a]) attrs.add(norm(el.attrMap[a]));
      if (el.attrMap['data-i'] !== undefined) { units.add(norm(html.slice(el.openEnd, el.closeStart))); continue; }
      if (!el.opaque) walk(el);
    }
  })(root);
  return { units: [...units], attrs: [...attrs] };
}

// Replaces every marked element's inner HTML and marked attribute with its translation. Returns html + the phrases with no translation.
export function applyTranslations(html, dict) {
  const root = parse(html), edits = [], missing = new Set();
  const esc = (v) => String(v).replace(/"/g, '&quot;');
  (function walk(n) {
    for (const el of n.children || []) {
      if (el.type !== 'el') continue;
      if (el.attrMap['data-ia'] !== undefined) {
        const names = String(el.attrMap['data-ia']).split(',');
        const tag = html.slice(el.start, el.openEnd); let out = tag;
        for (const a of names) {
          const v = el.attrMap[a]; if (!v) continue; const tr = dict[norm(v)];
          if (tr === undefined) { missing.add(norm(v)); continue; }
          out = out.replace(new RegExp('(\\s' + a + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\')'), (_, p) => p + '"' + esc(tr) + '"');
        }
        if (out !== tag) edits.push({ s: el.start, e: el.openEnd, v: out });
      }
      if (el.attrMap['data-i'] !== undefined) {
        const key = norm(html.slice(el.openEnd, el.closeStart)), tr = dict[key];
        if (tr === undefined) missing.add(key); else edits.push({ s: el.openEnd, e: el.closeStart, v: tr });
        continue;
      }
      if (!el.opaque) walk(el);
    }
  })(root);
  edits.sort((a, b) => b.s - a.s);
  // an element's own tag edit (attributes) and its inner edit never overlap, but nested inner edits are skipped by `continue` above
  let out = html; for (const e of edits) out = out.slice(0, e.s) + e.v + out.slice(e.e);
  return { html: out, missing: [...missing] };
}

// _('English text') calls in the inline scripts. Single-quoted literals only; \' and \\ are unescaped.
const T_RE = /(?<![\w$.])_\(\s*'((?:[^'\\]|\\.)*)'/g;
const unesc = (s) => s.replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n');
export function collectScriptStrings(html) {
  const out = new Set(); let m;
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  for (const sc of scripts) { T_RE.lastIndex = 0; while ((m = T_RE.exec(sc))) out.add(unesc(m[1])); }
  return [...out];
}

export function loadDict(lang) {
  const f = path.join(ROOT, 'i18n', `${lang}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

const tagsOf = (s) => (s.match(/<\/?[a-zA-Z][^>]*>/g) || []).map((t) => t.replace(/\s+/g, ' ')).sort().join('|');
const phs = (s) => (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join('|');

/* ---------------------------------------------------------------- CLI */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2], file = path.join(ROOT, 'index.html'), html = fs.readFileSync(file, 'utf8');
  if (cmd === 'scan' || cmd === 'mark') {
    const { edits, units, attrs } = plan(html);
    const uniq = new Set(units), uniqA = new Set(attrs);
    console.log(`unmarked text units: ${edits.filter((e) => e.insert === ' data-i' || e.insert === '<span data-i>').length}, attributes: ${edits.filter((e) => e.insert.startsWith(' data-ia')).length}`);
    console.log(`unique phrases: ${uniq.size} text, ${uniqA.size} attribute values`);
    if (cmd === 'mark') { fs.writeFileSync(file, applyEdits(html, edits)); console.log('marked index.html'); }
    else if (process.argv[3] === '-v') { [...uniq].forEach((u) => console.log('  T ' + u.slice(0, 110))); [...uniqA].forEach((u) => console.log('  A ' + u.slice(0, 110))); }
  } else if (cmd === 'check' || cmd === 'export') {
    const { units, attrs } = markedStrings(html), js = collectScriptStrings(html);
    const all = [...new Set([...units, ...attrs, ...js, ...pageStrings()])];
    const dicts = Object.fromEntries(LANGS.map((l) => [l, loadDict(l)]));
    if (cmd === 'export') {
      const rows = [['English', ...LANGS.map((l) => l.toUpperCase())].join('\t'), ...all.map((e) => [e, ...LANGS.map((l) => dicts[l][e] ?? '')].map((x) => x.replace(/\t|\n/g, ' ')).join('\t'))];
      fs.mkdirSync(path.join(ROOT, 'i18n'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'i18n', 'review.tsv'), rows.join('\n') + '\n'); console.log(`wrote i18n/review.tsv (${all.length} phrases)`);
    } else {
      let bad = 0;
      for (const l of LANGS) {
        const d = dicts[l], missing = all.filter((e) => d[e] === undefined), stale = Object.keys(d).filter((k) => !all.includes(k));
        const tagBad = all.filter((e) => d[e] !== undefined && tagsOf(e) !== tagsOf(d[e])), phBad = all.filter((e) => d[e] !== undefined && phs(e) !== phs(d[e]));
        const english = all.filter((e) => d[e] !== undefined && d[e] === e && hasWords(e) && e.split(' ').length > 2);
        console.log(`\n[${l}] ${all.length - missing.length}/${all.length} translated | missing ${missing.length} | tag mismatch ${tagBad.length} | placeholder mismatch ${phBad.length} | unchanged English ${english.length} | stale ${stale.length}`);
        missing.slice(0, 15).forEach((m) => console.log('   missing: ' + m.slice(0, 100))); tagBad.slice(0, 10).forEach((m) => console.log('   TAGS: ' + m.slice(0, 100))); phBad.slice(0, 10).forEach((m) => console.log('   {}: ' + m.slice(0, 100)));
        bad += tagBad.length + phBad.length;
      }
      process.exitCode = bad ? 1 : 0;
    }
  } else console.log('usage: node scripts/i18n.mjs scan|mark|check|export');
}
