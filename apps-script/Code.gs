/**
 * Rozka lead capture: website -> Google Sheet.
 *
 * Container-bound script: create a Google Sheet, then Extensions > Apps Script, paste this file.
 *
 * SETUP (once)
 *  1. Run setup() from the editor and approve the permissions. It creates the "Leads", "Quarantine" and "Replays" tabs,
 *     the Status dropdown and the HOT/WARM/CHECK highlighting.
 *  2. Deploy > New deployment > type "Web app" > Execute as: Me > Who has access: Anyone > Deploy.
 *     Copy the web app URL (ends in /exec).
 *  3. Paste the web app URL into LEAD_ENDPOINT in scripts/build.mjs, run `node scripts/build.mjs`, push.
 *  4. BOT PROTECTION (recommended, free): Cloudflare dashboard > Turnstile > Add widget > domain rozka.work,
 *     widget mode "Invisible". Put the SITE KEY in TURNSTILE_SITEKEY in scripts/build.mjs, and the SECRET KEY in
 *     Project Settings > Script properties as TURNSTILE_SECRET (never in the repo). Without it the other layers still
 *     run, but anyone who posts straight to the web app URL can fake them.
 *  After editing this file later: Deploy > Manage deployments > Edit > New version (the URL stays the same).
 *  Upgrading from the English-only version: paste the new file, run setup() once, then Edit > New version. Leads gets a "Site language"
 *  column (English / Hindi / Marathi) at the END, so no existing column moves. The Quarantine tab's "Bot score" and "Reasons" columns
 *  now sit one column to the right, so clear the old Quarantine rows first (or ignore them).
 *
 * WHAT THE WEBSITE SENDS (POST, text/plain JSON)
 *  { v, id, ts, source, page, section, ui (site language: en | hi | mr), fields:{name,phone,...}, ctx:{score,calc,industry,...},
 *    host, visitor, env, ref, utm, hp, hm, tk, trail:{ vid, sessions:[{ sid, t0, ev:[...] }] } }
 *  The trail holds what the visitor did (pages, sections, clicks, scroll, widget use), never what they typed.
 *
 * REPLAY (no password, nothing is served over the web): reload the Sheet, click any cell in a lead's row on the Leads tab,
 *  then Rozka > Show replay JSON for the selected lead. Copy it and paste it into the viewer you run locally
 *  (open index.html?rzr=paste, or http://localhost:8000/?rzr=paste with `python3 -m http.server`).
 *  Only people who can open this Sheet can get the JSON, and it holds the visit only, no name or phone.
 *  The web app itself never returns lead or trail data: GET is a health check.
 */

var CFG = {
  SITE: 'https://rozka.work',
  LEADS: 'Leads',
  REPLAYS: 'Replays',
  CHUNK: 45000,            // Sheets cells hold 50,000 characters; replay JSON is split into parts of this size
  MAX_BODY: 3 * 1024 * 1024,
  QUARANTINE: 'Quarantine',
  QUARANTINE_AT: 5,        // bot score at or above this: row goes to the Quarantine tab, not Leads
  FLAG_AT: 3,              // at or above this: stays in Leads but marked "CHECK" with the reasons in Notes
  RATE_PER_VISITOR: 5,     // submissions per visitor per hour before points are added
  RATE_GLOBAL: 60,         // submissions per hour across the whole site before points are added
  RATE_DROP: 400,          // per hour across the site: stop writing anything (sheet flood guard)
  HOSTS: ['rozka.work', 'www.rozka.work'],      // the live site: only leads sent from here count, and Turnstile must report one of these
  STATUSES: ['New', 'Called', 'No answer', 'Demo booked', 'Won', 'Lost', 'Spam']
};

var LEAD_COLS = [
  'Lead ID', 'Received', 'Alert', 'Status', 'Name', 'Phone', 'Business', 'City', 'Wants', 'Staff', 'Message',
  'Idea: WHEN', 'Idea: THEN', 'Source', 'Page', 'Section', 'Intent score', 'Industry', 'Calc: staff', 'Calc: loss/month',
  'Visit #', 'Sessions', 'Events', 'Active seconds', 'First seen', 'Referrer', 'UTM source', 'UTM medium', 'UTM campaign',
  'Device', 'Language / TZ', 'Journey', 'Notes', 'Site language'
];
// Language of the site page the visitor was reading (payload field ui); the browser language is in 'Language / TZ'.
var SITE_LANGS = { en: 'English', hi: 'Hindi', mr: 'Marathi' };
var COL = {}; LEAD_COLS.forEach(function (c, i) { COL[c] = i + 1; });
var TEXT_COLS = ['Lead ID', 'Name', 'Phone', 'Business', 'City', 'Wants', 'Staff', 'Message', 'Idea: WHEN', 'Idea: THEN', 'Source', 'Page',
  'Section', 'Industry', 'Referrer', 'UTM source', 'UTM medium', 'UTM campaign', 'Device', 'Language / TZ', 'Journey', 'Notes', 'Site language'];

/* ------------------------------------------------------------------ setup */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var leads = ss.getSheetByName(CFG.LEADS) || ss.insertSheet(CFG.LEADS, 0);
  var replays = ss.getSheetByName(CFG.REPLAYS) || ss.insertSheet(CFG.REPLAYS);
  var quar = ss.getSheetByName(CFG.QUARANTINE) || ss.insertSheet(CFG.QUARANTINE);

  leads.getRange(1, 1, 1, LEAD_COLS.length).setValues([LEAD_COLS])
    .setFontWeight('bold').setBackground('#0B4EA2').setFontColor('#FFFFFF');
  leads.setFrozenRows(1);
  leads.setFrozenColumns(5);
  TEXT_COLS.forEach(function (c) { leads.getRange(2, COL[c], leads.getMaxRows() - 1, 1).setNumberFormat('@'); });
  leads.getRange(2, COL['Received'], leads.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy, hh:mm');
  var widths = { 'Lead ID': 150, 'Received': 130, 'Alert': 90, 'Status': 110, 'Name': 140, 'Phone': 120, 'Message': 220, 'Journey': 420 };
  Object.keys(widths).forEach(function (c) { leads.setColumnWidth(COL[c], widths[c]); });

  leads.getRange(2, COL['Status'], leads.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CFG.STATUSES, true).setAllowInvalid(false).build());

  // Alerts live in the sheet: new rows stand out, hot leads are red, status colours the rest.
  var rng = leads.getRange(2, 1, leads.getMaxRows() - 1, LEAD_COLS.length);
  var a = 'C', s = 'D';
  leads.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + s + '2="Won"').setBackground('#D9F2E3').setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR($' + s + '2="Lost",$' + s + '2="Spam")').setFontColor('#9AA0A6').setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + s + '2="New",LEFT($' + a + '2,2)="🔥")').setBackground('#FBD5D0').setBold(true).setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + s + '2="New",LEFT($' + a + '2,1)="⚠")').setBackground('#FFE0B2').setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + s + '2="New",$' + a + '2="WARM")').setBackground('#FFF1C2').setRanges([rng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + s + '2="New"').setBackground('#EEF4FC').setRanges([rng]).build()
  ]);
  if (!leads.getFilter()) leads.getRange(1, 1, leads.getMaxRows(), LEAD_COLS.length).createFilter();

  quar.getRange(1, 1, 1, LEAD_COLS.length + 2).setValues([LEAD_COLS.concat(['Bot score', 'Reasons'])])
    .setFontWeight('bold').setBackground('#5B6067').setFontColor('#FFFFFF');
  quar.setFrozenRows(1);
  TEXT_COLS.forEach(function (c) { quar.getRange(2, COL[c], quar.getMaxRows() - 1, 1).setNumberFormat('@'); });

  replays.getRange(1, 1, 1, 4).setValues([['Lead ID', 'Part', 'Parts', 'Trail JSON']]).setFontWeight('bold');
  replays.setFrozenRows(1);
  replays.getRange(2, 1, replays.getMaxRows() - 1, 4).setNumberFormat('@');
  Logger.log('Setup finished. Next: deploy as a Web app, then paste the /exec URL into scripts/build.mjs.');
}

/* --------------------------------------------------------------- endpoints */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (!raw || raw.length > CFG.MAX_BODY) return out_({ ok: false, error: 'size' });
    var d = JSON.parse(raw);
    if (!d || d.v !== 1 || !/^L-[a-z0-9]{6,40}$/.test(String(d.id || ''))) return out_({ ok: false, error: 'shape' });
    if (d.hp) return out_({ ok: true });                       // honeypot filled: a bot. Pretend all is well.
    lock.waitLock(20000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var leads = ss.getSheetByName(CFG.LEADS), replays = ss.getSheetByName(CFG.REPLAYS), quar = ss.getSheetByName(CFG.QUARANTINE);
    if (!leads || !replays || !quar) return out_({ ok: false, error: 'run setup()' });
    if (leads.getRange(1, 1, leads.getLastRow(), 1).createTextFinder(d.id).matchEntireCell(true).findNext()) return out_({ ok: true, dup: true });

    var bot = bot_(d);
    if (bot.drop) return out_({ ok: true });                   // site-wide flood: write nothing, say nothing
    var row = buildRow_(d, bot);
    if (bot.score >= CFG.QUARANTINE_AT) {                       // looks like a bot: keep it, but out of the Leads list
      row[COL['Alert'] - 1] = '🚫 BOT?';
      var qr = quar.getLastRow() + 1;
      quar.getRange(qr, 1, 1, row.length + 2).setValues([row.concat([bot.score, bot.why.join('; ')])]);
      return out_({ ok: true });                                // never tell a bot it was caught
    }
    var r = leads.getLastRow() + 1;
    leads.getRange(r, 1, 1, row.length).setValues([row]);
    saveReplay_(replays, d.id, d.trail);
    return out_({ ok: true });
  } catch (err) {
    console.error(err && err.stack || err);
    return out_({ ok: false, error: 'server' });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
}

function doGet() { return out_({ ok: true, service: 'rozka-leads' }); }   // health check only: the web app never returns lead or trail data

/* ------------------------------------------------------- replay (Sheet menu, no password) */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rozka').addItem('Show replay JSON for the selected lead', 'showReplay').addToUi();
}

function showReplay() {
  var ui = SpreadsheetApp.getUi(), sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== CFG.LEADS) { ui.alert('Open the Leads tab and click a cell in the lead\'s row first.'); return; }
  var row = sh.getActiveRange().getRow();
  var id = String(sh.getRange(row, 1).getValue() || '');
  if (row < 2 || !/^L-[a-z0-9]{6,40}$/.test(id)) { ui.alert('Click a cell in a lead row (not the header).'); return; }
  var json = replayJson_(id);
  if (!json) { ui.alert('No replay is stored for ' + id + '.'); return; }
  var html = HtmlService.createHtmlOutput(
    '<div style="font:14px system-ui,sans-serif"><p>Select all, copy, and paste into the replay viewer (<b>?rzr=paste</b>).</p>' +
    '<textarea id="j" readonly onfocus="this.select()" style="width:100%;height:300px;font:12px monospace"></textarea></div>' +
    '<script>var t=document.getElementById("j");t.value=' + JSON.stringify(json).replace(/</g, '\\u003c') + ';t.focus();</script>')
    .setWidth(640).setHeight(420);
  ui.showModalDialog(html, 'Replay JSON for ' + id);
}

// Reassembles the stored parts into {lead, trail}. No name or phone: only what the visitor did.
function replayJson_(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rs = ss.getSheetByName(CFG.REPLAYS), ls = ss.getSheetByName(CFG.LEADS);
  var hits = rs.getRange(1, 1, rs.getLastRow(), 1).createTextFinder(id).matchEntireCell(true).findAll();
  if (!hits.length) return '';
  var parts = hits.map(function (c) { var v = rs.getRange(c.getRow(), 2, 1, 3).getValues()[0]; return { n: Number(v[0]), s: String(v[2]) }; })
    .sort(function (a, b) { return a.n - b.n; });
  var trail;
  try { trail = JSON.parse(parts.map(function (x) { return x.s; }).join('')); } catch (err) { return ''; }
  var lead = { id: id };
  var hit = ls.getRange(1, 1, ls.getLastRow(), 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (hit) {
    var v = ls.getRange(hit.getRow(), 1, 1, LEAD_COLS.length).getValues()[0];
    lead = { id: id, source: v[COL['Source'] - 1], page: v[COL['Page'] - 1], section: v[COL['Section'] - 1], alert: v[COL['Alert'] - 1] };
  }
  return JSON.stringify({ lead: lead, trail: trail });
}

/* ----------------------------------------------------------------- helpers */

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function str_(v, n) { return (v === undefined || v === null) ? '' : String(v).slice(0, n || 500); }

function buildRow_(d, bot) {
  var f = d.fields || {}, c = d.ctx || {}, v = d.visitor || {}, env = d.env || {}, utm = d.utm || {};
  var trail = d.trail || {}, sessions = trail.sessions || [];
  var events = 0, active = 0;
  sessions.forEach(function (s) { events += (s.ev || []).length; active += Number(s.act || 0); });
  var phone = String(f.phone || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.indexOf('91') === 0) phone = phone.slice(2);
  var idea = f.idea || c.idea || {};
  var calc = c.calc || {};
  var m = {};
  m['Lead ID'] = d.id;
  m['Received'] = new Date();
  m['Alert'] = (bot && bot.score >= CFG.FLAG_AT) ? '⚠ CHECK' : heat_(d);
  m['Status'] = 'New';
  m['Name'] = str_(f.name, 120);
  m['Phone'] = phone ? (phone.length === 10 ? '+91' + phone : '+' + phone) : str_(f.phone, 30);
  m['Business'] = str_(f.business, 160);
  m['City'] = str_(f.city, 80);
  m['Wants'] = str_(f.what, 80);
  m['Staff'] = str_(f.staff, 40);
  m['Message'] = str_(f.message, 1500);
  m['Idea: WHEN'] = str_(idea.when, 400);
  m['Idea: THEN'] = str_(idea.then, 400);
  m['Source'] = str_(d.source, 60);
  m['Page'] = str_(d.page, 30);
  m['Section'] = str_(d.section, 60);
  m['Intent score'] = Number(c.score || 0);
  m['Industry'] = str_(c.industry, 60);
  m['Calc: staff'] = calc.staff !== undefined ? calc.staff : '';
  m['Calc: loss/month'] = str_(calc.loss, 20);
  m['Visit #'] = Number(v.visit || 0);
  m['Sessions'] = sessions.length;
  m['Events'] = events;
  m['Active seconds'] = active;
  m['First seen'] = v.first ? str_(v.first, 30) : '';
  m['Referrer'] = str_(d.ref, 300);
  m['UTM source'] = str_(utm.utm_source, 80);
  m['UTM medium'] = str_(utm.utm_medium, 80);
  m['UTM campaign'] = str_(utm.utm_campaign, 120);
  m['Device'] = str_((env.w || '?') + 'x' + (env.h || '?') + (env.touch ? ' touch' : ' pointer'), 40);
  m['Language / TZ'] = str_((env.lang || '') + ' / ' + (env.tz || ''), 60);
  m['Journey'] = journey_(trail, d.id);
  m['Notes'] = (bot && bot.score >= CFG.FLAG_AT) ? 'Bot score ' + bot.score + ': ' + bot.why.join('; ') : '';
  m['Site language'] = Object.prototype.hasOwnProperty.call(SITE_LANGS, d.ui) ? SITE_LANGS[d.ui] : 'English';
  return LEAD_COLS.map(function (name) { return m[name]; });
}

function heat_(d) {
  var score = Number((d.ctx || {}).score || 0), src = String(d.source || '');
  if (src === 'contact_form' || src === 'nudge_price' || src === 'nudge_calc' || score >= 14) return '🔥 HOT';
  if (/^nudge_/.test(src) || src === 'automation_idea' || score >= 7) return 'WARM';
  return 'NEW';
}

var PAGE_NAMES = { home: 'Home', automation: 'Automation', pricing: 'Pricing', about: 'About', contact: 'Contact' };

// One readable line: Home > problem 24s > leaks 5/5 > industry Print shops > calc 20 staff -Rs9,375 > SUBMIT contact_form
function journey_(trail, leadId) {
  var sessions = (trail && trail.sessions) || [];
  var s = null;
  sessions.forEach(function (x) { (x.ev || []).forEach(function (e) { if (e.k === 'lead' && e.id === leadId) s = x; }); });
  if (!s) s = sessions[sessions.length - 1];
  if (!s) return '';
  var out = [], last = '';
  (s.ev || []).forEach(function (e) {
    var x = '';
    if (e.k === 'pv') x = PAGE_NAMES[e.pg] || e.pg;
    else if (e.k === 'sec' && e.d >= 4000) x = e.s + ' ' + Math.round(e.d / 1000) + 's';
    else if (e.k === 'w') {
      if (e.w === 'calc') x = 'calc ' + e.n + ' staff ' + e.loss;
      else if (e.w === 'industry') x = 'industry ' + (e.n || e.i);
      else if (e.w === 'leak') x = 'leaks ' + e.c + '/5';
      else if (e.w === 'cap') x = 'part ' + (Number(e.i) + 1);
      else if (e.w === 'scn') x = 'ran day ' + (Number(e.i) + 1);
      else if (e.w === 'rec') x = 'recipe ' + (Number(e.i) + 1);
      else if (e.w === 'faq') x = 'faq "' + String(e.q || '').slice(0, 30) + '"';
      else if (e.w === 'audit') x = 'audit ' + e.n + '/3';
    } else if (e.k === 'clk' && /^(https:\/\/wa\.me|tel:|mailto:)/.test(e.h || '')) x = 'clicked ' + String(e.h).split(':')[0].replace('https', 'whatsapp');
    else if (e.k === 'nd' && e.a === 'show') x = 'card:' + e.id;
    else if (e.k === 'lead') x = 'SUBMIT ' + e.src;
    if (x && x !== last) { out.push(x); last = x; }
  });
  var line = out.join(' > ');
  return line.length > 1500 ? '...' + line.slice(-1500) : line;
}

function saveReplay_(sh, id, trail) {
  var json = JSON.stringify(trail || {});
  var n = Math.max(1, Math.ceil(json.length / CFG.CHUNK));
  var rows = [];
  for (var i = 0; i < n; i++) rows.push([id, i + 1, n, json.slice(i * CFG.CHUNK, (i + 1) * CFG.CHUNK)]);
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 4).setValues(rows);
}

/* ------------------------------------------------------------- bot protection */

// Adds up suspicion points. >= FLAG_AT: flagged in Leads. >= QUARANTINE_AT: Quarantine tab.
// The honeypot is checked earlier and never reaches here. Turnstile is the strong signal; the rest are speed bumps
// that stop lazy bots and catch careless ones.
function bot_(d) {
  var score = 0, why = [];
  function hit(n, r) { score += n; why.push(r + ' +' + n); }
  var f = d.fields || {}, hm = d.hm || {}, trail = d.trail || {}, sessions = trail.sessions || [];
  var cache = CacheService.getScriptCache();

  // 0. only the live site counts: local previews and test posts land in Quarantine, so Leads shows hosted traffic only
  var host = String(d.host || '');
  if (CFG.HOSTS.indexOf(host) < 0) hit(5, 'not sent from the live site (' + (host || 'no host') + ')');

  // 1. Turnstile (only when TURNSTILE_SECRET is set)
  var ts = verifyTurnstile_(d.tk), human = false;
  if (ts.configured) {
    if (ts.ok) human = true;
    else if (ts.soft) hit(3, 'Turnstile unverified' + (ts.why ? ' (' + ts.why + ')' : ''));
    else hit(8, 'Turnstile failed ' + (ts.why || ''));
  }

  // 2. did a person use the form? (time from first touch to submit, trusted key/pointer events)
  var dt = Number(hm.dt), ev = Number(hm.ev);
  if (!isFinite(dt)) hit(2, 'no timing');
  else if (dt < 800) hit(3, 'submitted in ' + Math.round(dt) + 'ms');
  else if (dt < 2000) hit(1, 'submitted in ' + Math.round(dt) + 'ms');
  if (!isFinite(ev) || ev < 1) hit(3, 'no real input events');

  // 3. does the trail look like a real visit?
  var events = 0, pv = 0;
  sessions.forEach(function (s) { (s.ev || []).forEach(function (e) { events++; if (e.k === 'pv') pv++; }); });
  if (!sessions.length) hit(4, 'no trail');
  else { if (events < 3) hit(2, 'trail has ' + events + ' events'); if (!pv) hit(2, 'trail has no page view'); }

  // 4. phone
  var ph = String(f.phone || '').replace(/\D/g, '');
  if (ph.length === 12 && ph.indexOf('91') === 0) ph = ph.slice(2);
  if (ph.length === 11 && ph.charAt(0) === '0') ph = ph.slice(1);
  if (ph.length !== 10) hit(3, 'phone is ' + ph.length + ' digits');
  else {
    if (/^(\d)\1{9}$/.test(ph) || '01234567890123456789'.indexOf(ph) >= 0 || '98765432109876543210'.indexOf(ph) >= 0) hit(4, 'phone pattern');
    else if (Number(ph.charAt(0)) < 6) hit(1, 'phone does not start 6-9');
  }

  // 5. text fields
  var name = String(f.name || '');
  if (/https?:|www\.|@|\.(com|ru|xyz|top)\b/i.test(name)) hit(4, 'link in name');
  if (/^[\d\s]+$/.test(name)) hit(3, 'numeric name'); else if (name.trim().length < 2) hit(2, 'very short name');
  var text = [f.name, f.business, f.city, f.message, (f.idea || (d.ctx || {}).idea || {}).when, (f.idea || (d.ctx || {}).idea || {}).then].join(' ');
  var links = (text.match(/https?:\/\/|www\./gi) || []).length;
  if (links >= 2) hit(5, links + ' links in text'); else if (links === 1) hit(3, 'link in text');
  if (/\b(seo|backlinks?|crypto|bitcoin|casino|viagra|forex|guest post|telegram|escort)\b/i.test(text)) hit(3, 'spam words');
  if (/(.)\1{7,}/.test(text)) hit(2, 'repeated characters');

  // 6. rate limits (CacheService keeps counters for up to 6 hours)
  var vid = String((d.visitor || {}).vid || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (vid) {
    var vn = Number(cache.get('rv_' + vid) || 0) + 1; cache.put('rv_' + vid, String(vn), 3600);
    if (vn > CFG.RATE_PER_VISITOR) hit(4, 'visitor sent ' + vn + ' this hour');
  } else hit(1, 'no visitor id');
  var gn = Number(cache.get('rg') || 0) + 1; cache.put('rg', String(gn), 3600);
  if (gn > CFG.RATE_DROP) return { score: 99, why: ['site flood'], drop: true };
  if (gn > CFG.RATE_GLOBAL) hit(3, 'site busy: ' + gn + ' this hour');
  if (ph.length === 10) {
    if (cache.get('ph_' + ph)) hit(2, 'same phone in the last 6h');
    cache.put('ph_' + ph, '1', 21600);
  }

  if (human) score = Math.max(0, score - 3);                  // a verified Turnstile pass buys back some doubt
  return { score: score, why: why, human: human };
}

// Cloudflare Turnstile server-side check. configured:false when no secret is set (layer then skipped).
function verifyTurnstile_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) return { configured: false };
  if (!token) return { configured: true, ok: false, soft: true, why: 'no token' };
  try {
    var res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post', payload: { secret: secret, response: String(token).slice(0, 2048) }, muteHttpExceptions: true
    });
    var j = JSON.parse(res.getContentText());
    if (!j.success) return { configured: true, ok: false, why: (j['error-codes'] || []).join(',') };
    if (j.hostname && CFG.HOSTS.indexOf(j.hostname) < 0) return { configured: true, ok: false, why: 'hostname ' + j.hostname };
    return { configured: true, ok: true };
  } catch (err) {
    return { configured: true, ok: false, soft: true, why: 'verify error' };   // Cloudflare unreachable: unverified, not proof of a bot
  }
}
