#!/usr/bin/env node
/*
 * SEO build for rozka.work (GitHub Pages, no server rewrites).
 *
 * index.html is the one file you edit. After changing it, run:   node scripts/build.mjs
 *
 * It (re)writes, from index.html alone:
 *   - the SEO <head> block, per-page data-title and the <noscript> fallbacks inside index.html itself
 *   - automation/index.html, about/index.html, contact/index.html
 *     (same document; only the head and which page is visible on first paint differ)
 *   - sitemap.xml, robots.txt, llms.txt, 404.html, CNAME, .nojekyll
 *
 * To change a title, description or the domain, edit the CONFIG below and re-run. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://rozka.work';
const PHONE_DISPLAY = '+91 91752 12447';
const PHONE_E164 = '+91-91752-12447';
const EMAIL = 'team@alpxcalm.cloud';
const GA_ID = 'G-VFS8DRQ3D7'; // Google Analytics 4; set to '' to leave the tag out
const OG_IMAGE = { url: `${SITE}/og-image.png`, w: 1200, h: 630, alt: 'Rozka: Attendance in. Salaries out. No register in between.' };

// ---------------------------------------------------------------- CONFIG
const PAGES = {
  home: {
    path: '/',
    title: 'Rozka · Attendance & payroll software that runs itself',
    description: "Rozka records every punch at your door, works out each day's pay by your rules and locks every payout with proof. Book a 1-month demo on your own staff.",
    ogTitle: 'Rozka · Attendance in. Salaries out. No register in between.',
    ogDescription: 'Face, fingerprint, card or QR punching, daily pay from your own rules, advances recovered as EMI, and locked payslips. Try it on your real staff for a month.',
    ldType: 'WebPage',
  },
  automation: {
    path: '/automation/',
    title: 'Business automation, built to order · Rozka',
    description: "If it happens every day, it shouldn't need you every day. Rozka builds your repeated work into rules that run on their own, from job cards to stock reminders.",
    ldType: 'WebPage',
    crumb: 'Automation',
  },
  about: {
    path: '/about/',
    title: 'About Rozka · Built inside a working print shop',
    description: 'Roz ka kaam, roz ka hisaab: the everyday work and everyday accounts. Rozka was built inside a working print shop, for the owner still at the counter at 9 pm.',
    ldType: 'AboutPage',
    crumb: 'About',
  },
  contact: {
    path: '/contact/',
    title: 'Book a 1-month demo · Rozka',
    description: "Run Rozka on your own staff for a month. Tell us about your business and we'll call you back, set up the punch device at your place and put your rules in.",
    ldType: 'ContactPage',
    crumb: 'Book a demo',
  },
};
// ----------------------------------------------------------------------

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (p) => SITE + PAGES[p].path;
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function jsonLd(name) {
  const pg = PAGES[name];
  const ORG = `${SITE}/#organization`, WEB = `${SITE}/#website`, APP = `${SITE}/#software`;
  const graph = [
    {
      '@type': 'Organization', '@id': ORG, name: 'Rozka', url: `${SITE}/`,
      logo: { '@type': 'ImageObject', url: `${SITE}/icon-512.png`, width: 512, height: 512 },
      email: EMAIL, telephone: PHONE_E164,
      contactPoint: [{ '@type': 'ContactPoint', contactType: 'sales', telephone: PHONE_E164, email: EMAIL, areaServed: 'IN' }],
    },
    { '@type': 'WebSite', '@id': WEB, url: `${SITE}/`, name: 'Rozka', inLanguage: 'en-IN', publisher: { '@id': ORG } },
    {
      '@type': pg.ldType, '@id': `${url(name)}#webpage`, url: url(name), name: pg.title, description: pg.description,
      inLanguage: 'en-IN', isPartOf: { '@id': WEB }, primaryImageOfPage: { '@type': 'ImageObject', url: OG_IMAGE.url },
      ...(name === 'home' ? { about: { '@id': APP } } : { breadcrumb: { '@id': `${url(name)}#breadcrumb` } }),
    },
  ];
  if (name === 'home') {
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
      provider: { '@id': ORG }, areaServed: { '@type': 'Country', name: 'India' },
    });
  } else {
    graph.push({
      '@type': 'BreadcrumbList', '@id': `${url(name)}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: pg.crumb, item: url(name) },
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

function headBlock(name) {
  const pg = PAGES[name];
  const ogT = pg.ogTitle || pg.title, ogD = pg.ogDescription || pg.description;
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
  return [
    ...gtag,
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<title>${esc(pg.title)}</title>`,
    `<meta name="description" content="${esc(pg.description)}">`,
    `<link rel="canonical" href="${url(name)}">`,
    '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Rozka">',
    '<meta property="og:locale" content="en_IN">',
    `<meta property="og:url" content="${url(name)}">`,
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
    ldScript(jsonLd(name)),
  ].join('\n');
}

// ---- no-JS fallbacks: the industry and automation panels are drawn by script, so crawlers that don't run it see nothing.
function readLiteral(src, varName, nextVar) {
  const m = src.match(new RegExp(`var ${varName}=(\\[[\\s\\S]*?\\]);\\s*\\n\\s*var ${nextVar}\\b`));
  if (!m) throw new Error(`could not find "var ${varName}=[...]" before "var ${nextVar}" in index.html`);
  return vm.runInNewContext('(' + m[1] + ')', Object.create(null));
}
const li = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
function industriesNoscript(src) {
  const IND = readLiteral(src, 'IND', 'ilist');
  const body = IND.map((d) =>
    `<article><h3>${esc(d.n)}</h3><p><strong>${esc(d.h)}</strong> ${esc(d.p)}</p>` +
    (d.pain ? `<h4>The daily grind</h4>${li(d.pain)}<h4>Fixed from day one</h4>${li(d.fix)}<h4>We could automate next</h4>${li(d.nx)}` : '') +
    '</article>').join('');
  return `<noscript><div class="wrap">${body}</div></noscript>`;
}
function recipesNoscript(src) {
  const R = readLiteral(src, 'R', 'rlist');
  const body = R.map((d) =>
    `<article><h3>${esc(d.t)}</h3><p>${esc(d.s)}</p><ul>` +
    `<li><strong>When:</strong> ${esc(d.w)}. ${esc(d.ws)}</li>` +
    `<li><strong>Then:</strong> ${esc(d.th)}. ${esc(d.ths)}</li>` +
    `<li><strong>Result:</strong> ${esc(d.r)}. ${esc(d.rs)}</li></ul></article>`).join('');
  return `<noscript><div class="wrap">${body}</div></noscript>`;
}

function between(src, key, inner) {
  const re = new RegExp(`<!-- seo:${key}:start -->[\\s\\S]*?<!-- seo:${key}:end -->`);
  if (!re.test(src)) throw new Error(`marker <!-- seo:${key}:start --> ... <!-- seo:${key}:end --> missing in index.html`);
  return src.replace(re, () => `<!-- seo:${key}:start -->${inner}<!-- seo:${key}:end -->`);
}

function render(src, name) {
  let out = between(src, 'head', '\n' + headBlock(name) + '\n');
  out = between(out, 'ind', industriesNoscript(src));
  out = between(out, 'rec', recipesNoscript(src));
  const opener = /<div class="page" data-page="(home|automation|about|contact)" id="\1"[^>]*>/g;
  let n = 0;
  out = out.replace(opener, (_, p) => {
    n++;
    return `<div class="page" data-page="${p}" id="${p}" data-title="${esc(PAGES[p].title)}"${p === name ? '' : ' hidden'}>`;
  });
  if (n !== 4) throw new Error(`expected 4 page containers, found ${n}`);
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
for (const [name, pg] of Object.entries(PAGES)) {
  write(name === 'home' ? 'index.html' : `${name}/index.html`, render(src, name));
}

// ---- crawl files
const lastmod = fs.statSync(srcFile).mtime.toISOString().slice(0, 10);
write('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  Object.keys(PAGES).map((p) => `  <url>\n    <loc>${url(p)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join('\n') +
  '\n</urlset>\n');

write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

write('llms.txt', `# Rozka

> Attendance and payroll software for businesses that run on people. Rozka records every punch at your door (face, fingerprint, card or QR), works out each day's pay by your own rules, recovers advances as EMI and locks every payout with proof, with a payslip for each person. Built inside a working print shop in India.

## Pages

- [Home](${url('home')}): what Rozka does, how one day becomes a payslip, who it is for, and answers to common questions
- [Automation](${url('automation')}): small repeated jobs (job cards, stuck-job alerts, stock reminders, daily summaries) built to order into the same system
- [About](${url('about')}): where the name and the product come from
- [Book a 1-month demo](${url('contact')}): request a call back and run Rozka on your own staff for a month

## Key facts

- Workers punch only at the device at the door; only the owner and managers log in, from any browser.
- Punching keeps working without internet; punches are stored on the device and upload with their real time later.
- Rozka does not send salaries from your bank account. You pay as you do today; marking a month paid records who got what, locks it and makes payslips.
- PF, ESI and TDS are entered as deductions and shown on the payslip. Rozka does not calculate them.
- Shift times, breaks, half-day limits, overtime and penalties are settings. Small customisations are available.
- Pricing depends on staff count and the punch device chosen. A 1-month demo on your own staff comes first.

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

console.log('done');
