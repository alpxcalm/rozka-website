#!/usr/bin/env node
/*
 * Build for rozka.work (GitHub Pages, no server rewrites): English at /, Hindi at /hi/, Marathi at /mr/.
 *
 * index.html is the one file you edit. After changing it, run:   node scripts/build.mjs
 *
 * It (re)writes, from index.html alone:
 *   - the SEO <head> block, per-page data-title, language switchers and the <noscript> fallbacks inside index.html itself
 *   - automation/, pricing/, about/, contact/ (same document; only the head and which page is visible on first paint differ)
 *   - the same five pages in Hindi (hi/...) and Marathi (mr/...), built by swapping every marked piece of text for its
 *     translation from i18n/hi.json and i18n/mr.json (see scripts/i18n.mjs), with prefixed links, hreflang and per-language
 *     title, description and structured data
 *   - sitemap.xml (with language alternates), robots.txt, llms.txt, 404.html, CNAME, .nojekyll
 *
 * Text that has no translation yet stays in English and is listed at the end (run with --strict to fail instead).
 * To change a title, description or the domain, edit scripts/pages.mjs or the CONFIG below and re-run. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { applyTranslations, collectScriptStrings, markedStrings, loadDict, plain } from './i18n.mjs';
import { PAGES, pageStrings } from './pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const SITE = 'https://rozka.work';
const PHONE_DISPLAY = '+91 91752 12447';
const PHONE_E164 = '+91-91752-12447';
const EMAIL = 'team@alpxcalm.cloud';
const GA_ID = 'G-VFS8DRQ3D7'; // Google Analytics 4; set to '' to leave the tag out
// Apps Script web app URL (see apps-script/Code.gs, ends in /exec). While '' the forms save nothing online and fall back to WhatsApp.
const LEAD_ENDPOINT = process.env.LEAD_ENDPOINT ?? 'https://script.google.com/macros/s/AKfycbxobz6jdyG8KKNSDXl5aA3EFlAUoG9xIZqqBkaHe1CYkbcgHDsRzwU6qZOXW2TcTOfm/exec';
// Cloudflare Turnstile SITE key (public). Create an "Invisible" widget for rozka.work; the SECRET key goes in Apps Script properties
// as TURNSTILE_SECRET, never here. While '' the invisible check is skipped (honeypot, timing and server scoring still run).
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY ?? '0x4AAAAAAFYLJAHwOknhzkt_';
// Analytics web app URL (apps-script/Analytics.gs, a separate project from the leads one). While '' no visit data is collected.
const ANALYTICS_ENDPOINT = process.env.ANALYTICS_ENDPOINT ?? 'https://script.google.com/macros/s/AKfycbzjbAgndppGXAeSiNpmeFHzSyOEnwd6EE6S8IjuSY9Hw77vbORKvc7d2VBBJvrxQslM/exec';
const OG_IMAGE = { url: `${SITE}/og-image.png`, w: 1200, h: 630, alt: 'Rozka: Attendance in. Salaries out. No register in between.' };

// ---------------------------------------------------------------- languages
const LANG = {
  en: { code: 'en', prefix: '', html: 'en-IN', hreflang: 'en-IN', og: 'en_IN', name: 'English', short: 'EN' },
  hi: { code: 'hi', prefix: '/hi', html: 'hi-IN', hreflang: 'hi-IN', og: 'hi_IN', name: 'हिन्दी', short: 'हिं' },
  mr: { code: 'mr', prefix: '/mr', html: 'mr-IN', hreflang: 'mr-IN', og: 'mr_IN', name: 'मराठी', short: 'मरा' },
};
const LANGS = ['en', 'hi', 'mr'];
const DICT = { en: {}, hi: loadDict('hi'), mr: loadDict('mr') };
const MISSING = { hi: new Set(), mr: new Set() };
const tr = (lang, s) => {
  if (lang === 'en') return s;
  if (DICT[lang][s] === undefined) { MISSING[lang].add(s); return s; }
  return DICT[lang][s];
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (p, lang = 'en') => SITE + LANG[lang].prefix + PAGES[p].path;
const jsonInScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const ldScript = (obj) => `<script type="application/ld+json">${jsonInScript(obj)}</script>`;

function jsonLd(name, lang) {
  const pg = PAGES[name], L = LANG[lang];
  const ORG = `${SITE}/#organization`, WEB = `${SITE}/#website`, APP = `${SITE}/#software`;
  const graph = [
    {
      '@type': 'Organization', '@id': ORG, name: 'Rozka', url: `${SITE}/`,
      logo: { '@type': 'ImageObject', url: `${SITE}/icon-512.png`, width: 512, height: 512 },
      email: EMAIL, telephone: PHONE_E164,
      contactPoint: [{ '@type': 'ContactPoint', contactType: 'sales', telephone: PHONE_E164, email: EMAIL, areaServed: 'IN' }],
    },
    { '@type': 'WebSite', '@id': WEB, url: `${SITE}/`, name: 'Rozka', inLanguage: LANGS.map((l) => LANG[l].html), publisher: { '@id': ORG } },
    {
      '@type': pg.ldType, '@id': `${url(name, lang)}#webpage`, url: url(name, lang), name: tr(lang, pg.title), description: tr(lang, pg.description),
      inLanguage: L.html, isPartOf: { '@id': WEB }, primaryImageOfPage: { '@type': 'ImageObject', url: OG_IMAGE.url },
      ...(name === 'home' || name === 'pricing' ? { about: { '@id': APP } } : {}),
      ...(name !== 'home' ? { breadcrumb: { '@id': `${url(name, lang)}#breadcrumb` } } : {}),
    },
  ];
  if (name === 'home' || name === 'pricing') {
    graph.push({
      '@type': 'SoftwareApplication', '@id': APP, name: 'Rozka', url: `${SITE}/`,
      applicationCategory: 'BusinessApplication', operatingSystem: 'Web browser',
      description: 'Attendance and payroll software for businesses that run on people. Records every punch, works out daily pay from your own rules, recovers advances as EMI and locks every payout in a payslip.',
      featureList: [
        'Face, fingerprint, card or QR punching at the door, with a photo on every punch',
        'Punching keeps working offline and uploads with the real time once the connection returns',
        'Daily pay worked out from your own shift, break, overtime and penalty rules',
        'Advances recovered automatically as EMI',
        'Locked monthly payouts with a payslip for each person',
        'Owner dashboard in any browser',
      ],
      offers: { '@type': 'AggregateOffer', priceCurrency: 'INR', lowPrice: '119', offerCount: 1, description: 'Starting price per employee per month, inclusive of all taxes. Customised to each business and request; the punch device is priced separately. No setup cost.' },
      provider: { '@id': ORG }, areaServed: { '@type': 'Country', name: 'India' },
    });
  }
  if (name !== 'home') {
    graph.push({
      '@type': 'BreadcrumbList', '@id': `${url(name, lang)}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: tr(lang, 'Home'), item: `${SITE}${L.prefix}/` },
        { '@type': 'ListItem', position: 2, name: tr(lang, pg.crumb), item: url(name, lang) },
      ],
    });
  }
  if (name === 'automation') {
    graph.push({
      '@type': 'Service', '@id': `${SITE}/automation/#service`, name: 'Built-to-order business automation',
      serviceType: 'Business process automation', provider: { '@id': ORG }, areaServed: { '@type': 'Country', name: 'India' },
      description: "Repeated daily work (new-order job cards, stuck-job alerts, ready-for-pickup messages, low-stock reminders, missing-staff alerts, end-of-day summaries) written as WHEN, THEN, RESULT rules and built into the system your staff already use.",
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// Dictionaries handed to the page: the script strings for this language, and a reverse map (translated text -> English)
// so analytics and the Sheet always record English labels whatever language the visitor reads.
function pageDicts(src, lang) {
  if (lang === 'en') return { I18N: null, I18N_EN: null };
  const d = DICT[lang], js = collectScriptStrings(src), mk = markedStrings(src);
  const I18N = {}; for (const s of js) { if (d[s] === undefined) MISSING[lang].add(s); else I18N[s] = d[s]; }
  const I18N_EN = {};
  for (const e of [...mk.units, ...mk.attrs, ...js, ...pageStrings()]) {
    if (d[e] === undefined) continue;
    const k = plain(d[e]), v = plain(e);
    if (k && k !== v && k.length <= 200) I18N_EN[k] = v;
  }
  return { I18N, I18N_EN };
}

function headBlock(name, lang, src) {
  const pg = PAGES[name], L = LANG[lang];
  const title = tr(lang, pg.title), desc = tr(lang, pg.description);
  const ogT = tr(lang, pg.ogTitle || pg.title), ogD = tr(lang, pg.ogDescription || pg.description);
  const { I18N, I18N_EN } = pageDicts(src, lang);
  // Runs before gtag: tells the page where leads go and which language it is in. Google Analytics only counts the live site
  // (never localhost, file:// or previews), and the local replay viewer (?rzr=...) exists only off the live host.
  // _() is the translation helper every script uses: _('English text', {vars}) -> this page's language, English if unknown.
  const liveHosts = JSON.stringify([new URL(SITE).hostname, 'www.' + new URL(SITE).hostname]);
  const config = `<script>(function(){var live=${liveHosts}.indexOf(location.hostname)>=0,r=!live&&/[?&]rzr=/.test(location.search);window.ROZKA={endpoint:${JSON.stringify(LEAD_ENDPOINT)},ts:${JSON.stringify(TURNSTILE_SITEKEY)},an:${JSON.stringify(ANALYTICS_ENDPOINT)},live:live,replay:r,lang:${JSON.stringify(lang)},lp:${JSON.stringify(L.prefix)}};${GA_ID ? `if(!live)window['ga-disable-${GA_ID}']=true;` : ''}window.I18N=${I18N ? jsonInScript(I18N) : 'null'};window.I18N_EN=${I18N_EN ? jsonInScript(I18N_EN) : 'null'};window._=function(s,v){var d=window.I18N,x=d&&d[s]!==undefined?d[s]:s;return v?x.replace(/\\{(\\w+)\\}/g,function(m,k){return v[k]===undefined?m:String(v[k]);}):x;};})();</script>`;
  const gtag = !GA_ID ? [] : [
    '<!-- Google tag (gtag.js) -->',
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>`,
    '<script>',
    '  window.dataLayer = window.dataLayer || [];',
    '  function gtag(){dataLayer.push(arguments);}',
    "  gtag('js', new Date());",
    '',
    `  gtag('config', '${GA_ID}');`,
    '</script>',
  ];
  const alternates = [...LANGS.map((l) => `<link rel="alternate" hreflang="${LANG[l].hreflang}" href="${url(name, l)}">`), `<link rel="alternate" hreflang="x-default" href="${url(name, 'en')}">`];
  return [
    config,
    ...gtag,
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${url(name, lang)}">`,
    ...alternates,
    '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Rozka">',
    `<meta property="og:locale" content="${L.og}">`,
    ...LANGS.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${LANG[l].og}">`),
    `<meta property="og:url" content="${url(name, lang)}">`,
    `<meta property="og:title" content="${esc(ogT)}">`,
    `<meta property="og:description" content="${esc(ogD)}">`,
    `<meta property="og:image" content="${OG_IMAGE.url}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${OG_IMAGE.w}">`,
    `<meta property="og:image:height" content="${OG_IMAGE.h}">`,
    `<meta property="og:image:alt" content="${esc(OG_IMAGE.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(ogT)}">`,
    `<meta name="twitter:description" content="${esc(ogD)}">`,
    `<meta name="twitter:image" content="${OG_IMAGE.url}">`,
    `<meta name="twitter:image:alt" content="${esc(OG_IMAGE.alt)}">`,
    '<meta name="theme-color" content="#0B4EA2">',
    ldScript(jsonLd(name, lang)),
  ].join('\n');
}

// ---- no-JS fallbacks: the industry and automation panels are drawn by script, so crawlers that don't run it see nothing.
function readLiteral(src, varName, nextVar, lang) {
  const m = src.match(new RegExp(`var ${varName}=(\\[[\\s\\S]*?\\]);\\s*\\n\\s*var ${nextVar}\\b`));
  if (!m) throw new Error(`could not find "var ${varName}=[...]" before "var ${nextVar}" in index.html`);
  return vm.runInNewContext('(' + m[1] + ')', { _: (s) => tr(lang, s) });
}
const li = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
const headings = (lang) => lang === 'en'
  ? { grind: 'The daily grind', fixed: 'Fixed from day one', next: 'We could automate next', when: 'When:', then: 'Then:', result: 'Result:' }
  : { grind: tr(lang, 'THE DAILY GRIND'), fixed: tr(lang, 'FIXED FROM DAY ONE'), next: tr(lang, 'WE COULD AUTOMATE NEXT'), when: tr(lang, 'WHEN') + ':', then: tr(lang, 'THEN') + ':', result: tr(lang, 'RESULT') + ':' };
function industriesNoscript(src, lang) {
  const IND = readLiteral(src, 'IND', 'ilist', lang), H = headings(lang);
  const body = IND.map((d) =>
    `<article><h3>${esc(d.n)}</h3><p><strong>${esc(d.h)}</strong> ${esc(d.p)}</p>` +
    (d.pain ? `<h4>${esc(H.grind)}</h4>${li(d.pain)}<h4>${esc(H.fixed)}</h4>${li(d.fix)}<h4>${esc(H.next)}</h4>${li(d.nx)}` : '') +
    '</article>').join('');
  return `<noscript><div class="wrap">${body}</div></noscript>`;
}
function recipesNoscript(src, lang) {
  const R = readLiteral(src, 'R', 'rlist', lang), H = headings(lang);
  const body = R.map((d) =>
    `<article><h3>${esc(d.t)}</h3><p>${esc(d.s)}</p><ul>` +
    `<li><strong>${esc(H.when)}</strong> ${esc(d.w)}. ${esc(d.ws)}</li>` +
    `<li><strong>${esc(H.then)}</strong> ${esc(d.th)}. ${esc(d.ths)}</li>` +
    `<li><strong>${esc(H.result)}</strong> ${esc(d.r)}. ${esc(d.rs)}</li></ul></article>`).join('');
  return `<noscript><div class="wrap">${body}</div></noscript>`;
}

function between(src, key, inner) {
  const re = new RegExp(`<!-- seo:${key}:start -->[\\s\\S]*?<!-- seo:${key}:end -->`);
  if (!re.test(src)) throw new Error(`marker <!-- seo:${key}:start --> ... <!-- seo:${key}:end --> missing in index.html`);
  return src.replace(re, () => `<!-- seo:${key}:start -->${inner}<!-- seo:${key}:end -->`);
}

// Real links to the same page in the other languages (they work with JavaScript off; the script re-points them as the page changes).
function switcher(name, lang, kind) {
  const items = LANGS.map((l) => {
    const L = LANG[l];
    return `<a href="${L.prefix}${PAGES[name].path}" hreflang="${L.hreflang}" lang="${L.code}" data-lang="${l}" data-no-i aria-label="${L.name}" title="${L.name}"${l === lang ? ' aria-current="true"' : ''}>${kind === 'head' ? L.short : L.name}</a>`;
  }).join('');
  return `<div class="lang${kind === 'foot' ? ' lang-full' : ''}" role="group" aria-label="${esc(tr(lang, 'Language'))}">${items}</div>`;
}

// Internal links to the five pages get the language prefix; asset links and absolute URLs are left alone. Scripts are skipped
// (they build their own links from window.ROZKA.lp).
function prefixLinks(html, prefix) {
  return html.split(/(<script[\s\S]*?<\/script>)/i).map((seg, i) => (i % 2 ? seg
    : seg.replace(/href="(\/(?:automation\/|pricing\/|about\/|contact\/)?(?:#[^"]*)?)"/g, (_, h) => `href="${prefix}${h}"`))).join('');
}

function render(src, name, lang = 'en') {
  let out = between(src, 'head', '\n' + headBlock(name, lang, src) + '\n');
  out = between(out, 'ind', industriesNoscript(src, lang));
  out = between(out, 'rec', recipesNoscript(src, lang));
  const opener = /<div class="page" data-page="(home|automation|pricing|about|contact)" id="\1"[^>]*>/g;
  let n = 0;
  out = out.replace(opener, (_, p) => {
    n++;
    return `<div class="page" data-page="${p}" id="${p}" data-title="${esc(tr(lang, PAGES[p].title))}"${p === name ? '' : ' hidden'}>`;
  });
  if (n !== 5) throw new Error(`expected 5 page containers, found ${n}`);
  if (lang !== 'en') {
    const r = applyTranslations(out, DICT[lang]);
    r.missing.forEach((m) => MISSING[lang].add(m));
    out = prefixLinks(r.html, LANG[lang].prefix).replace('<html lang="en-IN">', `<html lang="${LANG[lang].html}">`);
  }
  out = between(out, 'langhead', switcher(name, lang, 'head'));
  out = between(out, 'langfoot', switcher(name, lang, 'foot'));
  return out;
}

function write(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === data) return false;
  fs.writeFileSync(file, data);
  console.log('wrote', rel);
  return true;
}

// ---- checks
for (const [k, p] of Object.entries(PAGES)) {
  if (p.title.length > 60) console.warn(`! ${k}: title is ${p.title.length} chars (aim for 60 or fewer)`);
  if (p.description.length > 160) console.warn(`! ${k}: description is ${p.description.length} chars (aim for 160 or fewer)`);
}

// ---- pages
const srcFile = path.join(ROOT, 'index.html');
const src = fs.readFileSync(srcFile, 'utf8');
for (const lang of LANGS) {
  for (const name of Object.keys(PAGES)) {
    const dir = LANG[lang].prefix.slice(1);
    const rel = name === 'home' ? path.posix.join(dir, 'index.html') : path.posix.join(dir, name, 'index.html');
    write(rel, render(src, name, lang));
  }
}
for (const l of ['hi', 'mr']) pageStrings().forEach((s) => tr(l, s));

// ---- crawl files
const lastmod = fs.statSync(srcFile).mtime.toISOString().slice(0, 10);
const alts = (p) => [...LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${LANG[l].hreflang}" href="${url(p, l)}"/>`), `    <xhtml:link rel="alternate" hreflang="x-default" href="${url(p, 'en')}"/>`].join('\n');
write('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
  LANGS.flatMap((l) => Object.keys(PAGES).map((p) => `  <url>\n    <loc>${url(p, l)}</loc>\n    <lastmod>${lastmod}</lastmod>\n${alts(p)}\n  </url>`)).join('\n') +
  '\n</urlset>\n');

write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /apps-script/\n\nSitemap: ${SITE}/sitemap.xml\n`);

write('llms.txt', `# Rozka

> Attendance and payroll software for businesses that run on people. Rozka records every punch at your door (face, fingerprint, card or QR), works out each day's pay by your own rules, recovers advances as EMI and locks every payout with proof, with a payslip for each person. Built inside a working print shop in India.

## Pages

- [Home](${url('home')}): what Rozka does, how one day becomes a payslip, who it is for, and answers to common questions
- [Automation](${url('automation')}): small repeated jobs (job cards, stuck-job alerts, stock reminders, daily summaries) built to order into the same system
- [Pricing](${url('pricing')}): prices start at ₹119 per employee per month, inclusive of all taxes, customised to each business; a starting-price estimator for 20 or more employees
- [About](${url('about')}): where the name and the product come from
- [Book a 1-month demo](${url('contact')}): request a call back and run Rozka on your own staff for a month

## Languages

The whole site is available in English, Hindi and Marathi, with the same pages and prices.

- English: ${url('home', 'en')}
- हिन्दी (Hindi): ${url('home', 'hi')}
- मराठी (Marathi): ${url('home', 'mr')}

## Key facts

- Workers punch only at the device at the door; only the owner and managers log in, from any browser.
- Punching keeps working without internet; punches are stored on the device and upload with their real time later.
- Rozka does not send salaries from your bank account. You pay as you do today; marking a month paid records who got what, locks it and makes payslips.
- PF, ESI and TDS are entered as deductions and shown on the payslip. Rozka does not calculate them.
- Shift times, breaks, half-day limits, overtime and penalties are settings. Small customisations are available.
- Prices start at ₹119 per employee per month, inclusive of all taxes, and may vary based on your business requirements. Everything is customised to the request. Contact for exact pricing.
- No setup cost and a no-cost business analysis. The punch device is priced separately, by the model chosen.
- A free one-month trial on your own staff comes first, then you decide.

## Contact

- Phone / WhatsApp: ${PHONE_DISPLAY}
- Email: ${EMAIL}
`);

write('404.html', `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · Rozka</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,400..800&display=swap" rel="stylesheet">
<style>
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#0B4EA2;color:#fff;font:17px/1.55 'Anek Latin',system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
main{max-width:30em}
h1{margin:0 0 12px;font-size:clamp(34px,6vw,56px);line-height:1;letter-spacing:-.03em;text-wrap:balance}
p{margin:0 0 8px;color:rgba(255,255,255,.78)}
a{color:#FFC02E;font-weight:600}
</style>
</head>
<body>
<main>
<h1>That page isn't here.</h1>
<p>Head back to <a href="/">Rozka</a>, or <a href="/contact/">book a 1-month demo</a>.</p>
</main>
</body>
</html>
`);

write('CNAME', 'rozka.work'); // no trailing newline: matches what GitHub's Pages settings write
write('.nojekyll', '');

// ---- translation report
let missing = 0;
for (const l of ['hi', 'mr']) {
  if (MISSING[l].size) console.warn(`! ${l}: ${MISSING[l].size} phrase(s) have no translation yet and stay in English (node scripts/i18n.mjs check)`);
  missing += MISSING[l].size;
}
console.log('done');
if (STRICT && missing) { console.error('--strict: missing translations'); process.exit(1); }
