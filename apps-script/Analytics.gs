/**
 * Rozka site analytics: website -> Google Sheet -> Looker Studio.
 *
 * A SECOND, separate Apps Script project (not the leads one). It holds anonymous visit data only: no names, no phones,
 * no IP addresses. Keep it in its own Sheet so you can share it with anyone without exposing leads.
 *
 * SETUP (once)
 *  1. Create a new Google Sheet called "Rozka Analytics", then Extensions > Apps Script, paste this file, Save.
 *  2. Run setup() and approve the permissions. It creates the tabs and an hourly trigger that runs aggregate().
 *  3. Deploy > New deployment > type "Web app" > Execute as: Me > Who has access: Anyone > Deploy. Copy the /exec URL.
 *  4. Put that URL in ANALYTICS_ENDPOINT in scripts/build.mjs, run `node scripts/build.mjs`, push.
 *  5. HTML DASHBOARD (private, owner only): Project files (+) > HTML > name it exactly "Dashboard" > paste Dashboard.html. Then Deploy >
 *     New deployment > Web app > Execute as: Me > Who has access: ONLY MYSELF > Deploy. That second URL shows the dashboard to you when you are signed in.
 *     Keep the first deployment (Anyone) for the website; it never shows the dashboard. Teammates: give them Looker Studio access instead.
 *  6. After some visits, run aggregate() once (or wait an hour; or use the Rozka menu > Refresh now). Then open the Dashboard tab:
 *     it is built by this script, charts included, with nothing to set up. Insights holds the plain-English headlines.
 *  7. Optional: for a shareable version, connect Looker Studio to the aggregated tabs (apps-script/Looker-Studio-guide.md).
 *  After editing this file later: Deploy > Manage deployments > Edit > New version (the URL stays the same).
 *  Opt yourself out of the counts: visit https://rozka.work/?an=off once in each browser you use (?an=on turns it back on).
 *
 * WHAT THE WEBSITE SENDS (POST, text/plain JSON, batched every ~15s and when the tab is closed)
 *  { v:1, bid, seq, s:{ sid, vid, t0, visit, lp, ref(host only), utm, w, h, touch, lang, tz }, ev:[ { t, k, pg, ... } ] }
 *  Only from rozka.work, never from localhost, bots, or browsers that send Do-Not-Track / Global Privacy Control.
 *
 * TABS
 *  Raw (appended to):    Events, Sessions
 *  For Looker Studio:    Daily, Pages, Sections, Interactions, Clicks, Funnel, Sources, Cards, Devices   (rebuilt hourly)
 *  For people:           Dashboard (charts, rebuilt hourly), Insights (plain-English headlines + key numbers, last 30 days vs the 30 before)
 *  Chart data:           DashData (the small tables behind the Dashboard charts)
 */

var CFG = {
  TZ: 'Asia/Kolkata',
  KEEP_DAYS: 120,              // aggregate over this many recent days
  MAX_READ_ROWS: 300000,       // never read more than this many raw event rows in one aggregate()
  MAX_BODY: 100 * 1024,
  MAX_EVENTS_PER_BATCH: 60,
  MAX_EVENTS_PER_SESSION: 800, // a person does not produce more than this; a script might
  FLOOD_PER_HOUR: 20000,       // batches per hour across the site before new ones are ignored
  MIN_SESSIONS_FOR_INSIGHTS: 20,   // for a 30-day window; shorter and longer windows scale with it
  RANGES: [7, 30, 90],             // day ranges the HTML dashboard can switch between
  SNAP_CHUNK: 45000
};

var PAGES = ['home', 'automation', 'pricing', 'about', 'contact'];
var PAGE_LABEL = { home: 'Home', automation: 'Automation', pricing: 'Pricing', about: 'About', contact: 'Contact' };
// Reading order of the sections on each page, used to find where visitors drop off.
var ORDER = {
  home: ['hero', 'problem', 'product', 'how', 'industries', 'why', 'beyond', 'faq', 'close'],
  automation: ['automation-hero', 'recipes', 'process', 'vs-it', 'book-a-demo'],
  pricing: ['pricing-hero', 'what-you-pay', 'estimator', 'price-factors', 'how-we-quote', 'pricing-faq', 'book-a-demo'],
  about: ['about-hero', 'name', 'story', 'promises', 'book-a-demo'],
  contact: ['contact-hero', 'after-send']
};
var SECTION_LABEL = { hero: 'Hero', problem: 'Register problem + loss calculator', product: 'Product tour (5 parts)', how: 'Watch one day become a payslip',
  industries: 'Industries', why: 'Built inside a print shop', beyond: 'Beyond attendance (automation)', faq: 'FAQ', close: 'Closing call to action',
  'automation-hero': 'Automation hero', recipes: 'Automation examples', process: 'How we build it', 'vs-it': 'Automation vs IT department',
  'book-a-demo': 'Book-a-demo band', 'about-hero': 'About hero', name: 'Where the name comes from', story: 'Where it started', promises: 'Four promises',
  'pricing-hero': 'Pricing hero', 'what-you-pay': 'What you pay', estimator: 'Price estimator', 'price-factors': 'What can change the price', 'how-we-quote': 'How we quote', 'pricing-faq': 'Pricing FAQ',
  'contact-hero': 'Contact: form', 'after-send': 'Contact: what happens next' };

var EVENT_COLS = ['Received', 'Date', 'Hour', 'Session', 'Visitor', 'Page', 'Type', 'Section', 'Label', 'Detail', 'Value'];
var SESSION_COLS = ['Session', 'Visitor', 'Started', 'Date', 'Visit #', 'Visitor type', 'Landing', 'Referrer', 'Channel',
  'UTM source', 'UTM medium', 'UTM campaign', 'Device', 'Width', 'Language', 'Time zone'];
var ID = /^[a-z0-9-]{6,48}$/;

/* ------------------------------------------------------------------ setup */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CFG.TZ);        // so dates read back from the Sheet match the dates written
  var ev = sheet_(ss, 'Events'), se = sheet_(ss, 'Sessions');
  head_(ev, EVENT_COLS, '#0B4EA2'); head_(se, SESSION_COLS, '#0B4EA2');
  ['Dashboard', 'Insights', 'Daily', 'Pages', 'Sections', 'Interactions', 'Clicks', 'Funnel', 'Sources', 'Cards', 'Devices', 'DashData', 'DashJson'].forEach(function (n) { sheet_(ss, n); });
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'aggregate') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('aggregate').timeBased().everyHours(1).create();
  Logger.log('Setup finished. Deploy as a Web app, paste the /exec URL into scripts/build.mjs (ANALYTICS_ENDPOINT).');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rozka').addItem('Refresh insights and dashboard now', 'aggregate').addToUi();
}

function sheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function head_(sh, cols, color) {
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground(color).setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
}

/* ---------------------------------------------------------------- endpoint */

// The public deployment (Anyone) never knows who is asking, so it can only answer the health check. The dashboard page is served
// only when the visitor is the signed-in owner, which happens on the "Only myself" deployment.
function doGet() {
  if (ownerOnly_()) {
    return HtmlService.createHtmlOutputFromFile('Dashboard').setTitle('Rozka analytics').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return out_({ ok: true, service: 'rozka-analytics' });
}

function ownerOnly_() {
  var me = '', you = '';
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); you = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return false; }
  return !!me && me === you;
}

// Called by the dashboard page (google.script.run). Checks the owner again, so the data is never reachable any other way.
function getDashboardData() {
  if (!ownerOnly_()) throw new Error('Not allowed');
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DashJson');
  var last = sh ? sh.getLastRow() : 0;
  if (last < 2) return { empty: true };
  var rows = sh.getRange(2, 1, last - 1, 3).getValues().sort(function (a, b) { return Number(a[0]) - Number(b[0]); });
  return JSON.parse(rows.map(function (r) { return String(r[2]); }).join(''));
}

function doPost(e) {
  var lock = LockService.getScriptLock(), locked = false;
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (!raw || raw.length > CFG.MAX_BODY) return out_({ ok: false });
    var d = JSON.parse(raw);
    if (!d || d.v !== 1 || !ID.test(String(d.bid || '')) || !d.s || !ID.test(String(d.s.sid || '')) || !ID.test(String(d.s.vid || '')) || !Array.isArray(d.ev)) return out_({ ok: false });

    var cache = CacheService.getScriptCache();
    if (cache.get('b_' + d.bid)) return out_({ ok: true });                       // a retry of a batch we already stored
    var flood = Number(cache.get('flood') || 0) + 1; cache.put('flood', String(flood), 3600);
    if (flood > CFG.FLOOD_PER_HOUR) return out_({ ok: true });
    var seen = Number(cache.get('n_' + d.s.sid) || 0);
    var room = CFG.MAX_EVENTS_PER_SESSION - seen;
    if (room <= 0) return out_({ ok: true });

    var now = Date.now(), t0 = Number(d.s.t0);
    if (!isFinite(t0) || t0 > now + 3600e3 || t0 < now - 8 * 864e5) return out_({ ok: false });

    var rows = [];
    d.ev.slice(0, Math.min(CFG.MAX_EVENTS_PER_BATCH, room)).forEach(function (x) { var r = eventRow_(d.s, x, now); if (r) rows.push(r); });

    lock.waitLock(20000); locked = true;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var evSh = ss.getSheetByName('Events'), seSh = ss.getSheetByName('Sessions');
    if (!evSh || !seSh) return out_({ ok: false });
    if (!cache.get('s_' + d.s.sid)) {
      var found = seSh.getRange(1, 1, Math.max(seSh.getLastRow(), 1), 1).createTextFinder(d.s.sid).matchEntireCell(true).findNext();
      if (!found) { var sr = sessionRow_(d.s); seSh.getRange(seSh.getLastRow() + 1, 1, 1, sr.length).setValues([sr]); }
      cache.put('s_' + d.s.sid, '1', 21600);
    }
    if (rows.length) evSh.getRange(evSh.getLastRow() + 1, 1, rows.length, EVENT_COLS.length).setValues(rows);
    cache.put('b_' + d.bid, '1', 21600);
    cache.put('n_' + d.s.sid, String(seen + rows.length), 21600);
    return out_({ ok: true });
  } catch (err) {
    console.error(err && err.stack || err);
    return out_({ ok: false });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (x) { /* not held */ } }
  }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function str_(v, n) { return (v === undefined || v === null) ? '' : String(v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 80); }
function day_(ms) { return Utilities.formatDate(new Date(ms), CFG.TZ, 'yyyy-MM-dd'); }
function hour_(ms) { return Number(Utilities.formatDate(new Date(ms), CFG.TZ, 'H')); }

function hostOf_(h) { return str_(h, 80).toLowerCase().replace(/^www\./, ''); }

function channel_(ref, utm) {
  utm = utm || {};
  var med = String(utm.utm_medium || '').toLowerCase(), src = String(utm.utm_source || '').toLowerCase();
  if (/^(cpc|ppc|paid|paidsearch|paid_social|display)$/.test(med)) return 'Paid';
  if (src) return 'Campaign: ' + str_(src, 30);
  var h = hostOf_(ref);
  if (!h) return 'Direct';
  if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\./.test(h + '.')) return 'Organic search';
  if (/(facebook|instagram|linkedin|twitter|t\.co|youtube|x\.com|pinterest|reddit)/.test(h)) return 'Social';
  if (/(wa\.me|whatsapp)/.test(h)) return 'WhatsApp';
  if (/(^|\.)rozka\.work$/.test(h)) return 'Internal';
  return 'Referral';
}

function device_(w, touch) {
  w = Number(w) || 0;
  if (w && w < 700) return 'Mobile';
  if (w && w < 1100) return touch ? 'Tablet' : 'Desktop';
  return 'Desktop';
}

function sessionRow_(s) {
  var utm = s.utm || {}, t0 = Number(s.t0);
  return [str_(s.sid, 48), str_(s.vid, 48), new Date(t0), day_(t0), Number(s.visit) || 1, (Number(s.visit) || 1) > 1 ? 'Returning' : 'New',
    PAGES.indexOf(s.lp) >= 0 ? s.lp : '', hostOf_(s.ref), channel_(s.ref, utm), str_(utm.utm_source, 60), str_(utm.utm_medium, 60), str_(utm.utm_campaign, 80),
    device_(s.w, s.touch), Number(s.w) || '', str_(s.lang, 12), str_(s.tz, 40)];
}

function eventRow_(s, e, received) {
  if (!e || typeof e !== 'object') return null;
  var abs = Number(s.t0) + Number(e.t);
  if (!isFinite(abs) || abs > received + 3600e3) return null;
  var pg = PAGES.indexOf(e.pg) >= 0 ? e.pg : '';
  var type = '', sec = '', label = '', detail = '', val = '';
  switch (e.k) {
    case 'pv': type = 'pageview'; label = str_(e.h, 40); break;
    case 'sec': type = 'section'; sec = str_(e.s, 40); val = Math.min(Math.max(Number(e.d) || 0, 0), 30 * 60 * 1000); break;
    case 'sd': type = 'scroll'; val = Math.min(Math.max(Number(e.d) || 0, 0), 100); break;
    case 'clk': type = 'click'; sec = str_(e.s, 40); label = str_(e.tx, 60); detail = str_(e.h, 80); break;
    case 'w':
      type = 'widget'; label = str_(e.w, 20);
      if (e.w === 'est') { detail = str_(e.n, 10); val = Number(e.n) || ''; }
      else if (e.w === 'calc') { detail = [e.n, e.sal, e.min, str_(e.loss, 14)].join('|'); val = Number(e.n) || ''; }
      else {
        detail = str_(e.n !== undefined ? e.n : (e.q !== undefined ? e.q : ''), 70);
        val = e.w === 'leak' ? Number(e.c) : e.w === 'audit' ? Number(e.n) : (e.w === 'cap' || e.w === 'scn' || e.w === 'rec' || e.w === 'industry') ? Number(e.i) : '';
        if (val !== '' && !isFinite(val)) val = '';
      }
      break;
    case 'chg': type = 'change'; label = str_(e.f, 20); detail = str_(e.v, 40); break;
    case 'fld': type = 'form_start'; label = str_(e.fm, 20); detail = str_(e.f, 30); break;
    case 'nd': type = 'card'; label = str_(e.id, 20); detail = (e.a === 'done' && e.ok === 0) ? 'done-failed' : str_(e.a, 20); break;
    case 'lead': type = 'lead'; label = str_(e.src, 30); break;
    default: return null;
  }
  return [new Date(received), day_(abs), hour_(abs), str_(s.sid, 48), str_(s.vid, 48), pg, type, sec, label, detail, val];
}

/* ------------------------------------------------------------- aggregation */

function aggregate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var evSh = ss.getSheetByName('Events'), seSh = ss.getSheetByName('Sessions');
  var events = readTail_(evSh, EVENT_COLS.length), sessions = readTail_(seSh, SESSION_COLS.length);
  var result = compute_(events, sessions, new Date());
  Object.keys(result.tabs).forEach(function (name) { write_(ss, name, result.tabs[name].cols, result.tabs[name].rows); });
  writeInsights_(ss, result.insights);
  buildDashboard_(ss, result.insights, result.dash);
  writeSnapshot_(ss, result.snapshot);
  return result;
}

function readTail_(sh, ncols) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(last - 1, CFG.MAX_READ_ROWS);
  return sh.getRange(last - n + 1, 1, n, ncols).getValues();
}

function write_(ss, name, cols, rows) {
  var sh = sheet_(ss, name);
  sh.clearContents();
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#0B4EA2').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, cols.length).setValues(rows);
  sh.getRange(2, 1, Math.max(rows.length, 1), 1).setNumberFormat('yyyy-mm-dd');
}

function bump_(map, key, field, n) { var o = map[key] || (map[key] = {}); o[field] = (o[field] || 0) + (n === undefined ? 1 : n); return o; }

// Pure function: raw rows in, tables + insights out. (Kept free of Sheets calls so it can be tested.)
function compute_(events, sessions, nowDate) {
  var cutoff = day_(nowDate.getTime() - CFG.KEEP_DAYS * 864e5);
  var S = {};   // sid -> session facts

  sessions.forEach(function (r) {
    var date = fmtDate_(r[3]);
    if (!r[0] || date < cutoff) return;
    S[r[0]] = newSession_(r[0], r[1], date, Number(r[4]) || 1, r[5], r[6], r[7], r[8], r[12]);
  });

  events.forEach(function (r) {
    var sid = r[3], date = fmtDate_(r[1]);
    if (!sid || date < cutoff) return;
    var s = S[sid] || (S[sid] = newSession_(sid, r[4], date, 1, 'New', '', '', 'Direct', 'Desktop'));
    var pg = r[5], type = r[6], sec = r[7], label = r[8], detail = r[9], val = r[10];
    s.events++;
    if (type === 'pageview') { s.pageviews++; s.pages[pg] = true; if (pg === 'contact') s.contact = true; if (pg === 'pricing') s.decisionHit = true; }
    else if (type === 'section') {
      var ms = Number(val) || 0; s.dwell += ms;
      var k = pg + '|' + sec; s.sec[k] = (s.sec[k] || 0) + ms;
      s.pageDwell[pg] = (s.pageDwell[pg] || 0) + ms; s.pages[pg] = true;
    }
    else if (type === 'scroll') { var d = Number(val) || 0; if (d > (s.depth[pg] || 0)) s.depth[pg] = d; s.pages[pg] = true; }
    else if (type === 'click') { s.clicks.push({ pg: pg, sec: sec, label: label, href: detail }); }
    else if (type === 'widget') widget_(s, label, detail, val);
    else if (type === 'change') {
      if (label === 'fWhat') s.inter.push(['Wants to automate (contact form)', detail]);
      else if (label === 'fStaff') s.inter.push(['Staff size (contact form)', detail]);
    }
    else if (type === 'form_start') { if (label === 'demoForm' || label === 'ldForm') s.formStart = true; }
    else if (type === 'card') { s.cards.push([label, detail]); }
    else if (type === 'lead') s.lead = true;
  });

  var list = Object.keys(S).map(function (k) { return S[k]; });
  list.forEach(function (s) {
    s.activeSec = Math.round(s.dwell / 1000);
    s.engaged = s.dwell >= 15000 || Object.keys(s.pages).length >= 2 || s.widgets > 0;
    s.decision = s.decisionHit || s.leakMax >= 3;
  });

  var T = {}, tabs = {};
  var daily = {}, pages = {}, sections = {}, inter = {}, clicks = {}, funnel = {}, sources = {}, cards = {}, devices = {};
  var visitorsByDay = {}, newByDay = {};

  list.forEach(function (s) {
    var D = s.date;
    // Daily
    bump_(daily, D, 'sessions'); bump_(daily, D, 'pageviews', s.pageviews); bump_(daily, D, 'active', s.activeSec);
    if (s.engaged) bump_(daily, D, 'engaged'); if (s.lead) bump_(daily, D, 'leads');
    (visitorsByDay[D] = visitorsByDay[D] || {})[s.vid] = true;
    if (s.type === 'New') (newByDay[D] = newByDay[D] || {})[s.vid] = true;
    // Pages
    Object.keys(s.pages).forEach(function (pg) {
      var key = D + '|' + pg;
      bump_(pages, key, 'sessions'); bump_(pages, key, 'active', Math.round((s.pageDwell[pg] || 0) / 1000));
      var dp = s.depth[pg] || 0; if (dp >= 50) bump_(pages, key, 'd50'); if (dp >= 75) bump_(pages, key, 'd75'); if (dp >= 100) bump_(pages, key, 'd100');
      bump_(sections, '__ps|' + D + '|' + pg, 'n');
    });
    // Sections
    Object.keys(s.sec).forEach(function (k) {
      var parts = k.split('|'), ms = s.sec[k], key = D + '|' + parts[0] + '|' + parts[1];
      if (ms >= 1000) bump_(sections, key, 'saw'); if (ms >= 5000) bump_(sections, key, 'read'); bump_(sections, key, 'dwell', Math.round(ms / 1000));
    });
    // Interactions
    s.inter.forEach(function (it) { addInter_(inter, D, it[0], it[1], s.sid); });
    if (s.leakMax) addInter_(inter, D, 'Register leaks caught (best per visit)', s.leakMax + ' of 5', s.sid);
    if (s.calcStaff !== '') addInter_(inter, D, 'Calculator: staff size', bucket_(s.calcStaff), s.sid);
    if (s.estStaff !== '') addInter_(inter, D, 'Price estimator: staff size', bucket_(s.estStaff), s.sid);
    if (s.auditMax) addInter_(inter, D, 'Owner audit (best per visit)', s.auditMax + ' of 3', s.sid);
    // Clicks
    s.clicks.forEach(function (c) {
      if (!c.label && !c.href) return;
      var key = [D, c.pg, c.sec, k_(c.label || c.href), clickType_(c)].join('|'); var o = bump_(clicks, key, 'count'); o.sids = o.sids || {}; o.sids[s.sid] = true;
    });
    // Funnel
    var steps = [true, s.engaged, s.decision, s.contact, s.formStart, s.lead];
    steps.forEach(function (ok, i) { if (ok) bump_(funnel, D + '|' + i, 'n'); });
    // Sources / Devices
    var sk = D + '|' + s.channel + '|' + s.ref; bump_(sources, sk, 'sessions'); if (s.engaged) bump_(sources, sk, 'engaged'); if (s.lead) bump_(sources, sk, 'leads');
    var dk = D + '|' + s.device; bump_(devices, dk, 'sessions'); if (s.engaged) bump_(devices, dk, 'engaged'); if (s.lead) bump_(devices, dk, 'leads');
    // Cards
    s.cards.forEach(function (c) {
      var key = D + '|' + c[0], f = { show: 'shown', close: 'closed', later: 'later', wa: 'whatsapp', done: 'submitted', min: 'minimised' }[c[1]];
      if (f) bump_(cards, key, f);
    });
  });

  var dayKeys = Object.keys(daily).sort();
  tabs.Daily = { cols: ['Date', 'Sessions', 'Visitors', 'New visitors', 'Returning visitors', 'Pageviews', 'Engaged sessions', 'Engagement rate', 'Active seconds', 'Avg active seconds', 'Leads', 'Lead rate'],
    rows: dayKeys.map(function (D) { var o = daily[D], vis = Object.keys(visitorsByDay[D] || {}).length, nw = Object.keys(newByDay[D] || {}).length;
      return [D, o.sessions, vis, nw, Math.max(vis - nw, 0), o.pageviews || 0, o.engaged || 0, round_((o.engaged || 0) / o.sessions, 3), o.active || 0, round_((o.active || 0) / o.sessions, 1), o.leads || 0, round_((o.leads || 0) / o.sessions, 4)]; }) };

  tabs.Pages = { cols: ['Date', 'Page', 'Sessions', 'Active seconds', 'Reached 50% scroll', 'Reached 75% scroll', 'Reached 100% scroll'],
    rows: sortedRows_(pages, function (k, o) { var p = k.split('|'); return [p[0], PAGE_LABEL[p[1]] || p[1], o.sessions || 0, o.active || 0, o.d50 || 0, o.d75 || 0, o.d100 || 0]; }) };

  tabs.Sections = { cols: ['Date', 'Page', 'Section', 'Section label', 'Order', 'Sessions that saw it (1s+)', 'Sessions that read it (5s+)', 'Total seconds', 'Page sessions'],
    rows: sortedRows_(sections, function (k, o) {
      if (k.indexOf('__ps|') === 0) return null; var p = k.split('|'), ord = (ORDER[p[1]] || []).indexOf(p[2]);
      return [p[0], PAGE_LABEL[p[1]] || p[1], p[2], SECTION_LABEL[p[2]] || p[2], ord >= 0 ? ord + 1 : '', o.saw || 0, o.read || 0, o.dwell || 0, (sections['__ps|' + p[0] + '|' + p[1]] || {}).n || 0]; }) };

  tabs.Interactions = { cols: ['Date', 'Kind', 'Item', 'Count', 'Sessions'],
    rows: sortedRows_(inter, function (k, o) { var p = k.split('|'); return [p[0], p[1], p[2], o.count || 0, Object.keys(o.sids || {}).length]; }) };

  tabs.Clicks = { cols: ['Date', 'Page', 'Section', 'Label', 'Kind', 'Clicks', 'Sessions'],
    rows: sortedRows_(clicks, function (k, o) { var p = k.split('|'); return [p[0], PAGE_LABEL[p[1]] || p[1], p[2], p[3], p[4], o.count || 0, Object.keys(o.sids || {}).length]; }) };

  var STEP = ['Visited', 'Engaged (15s+, 2 pages or used a widget)', 'Showed buying interest', 'Opened Contact page', 'Started a form', 'Became a lead'];
  tabs.Funnel = { cols: ['Date', 'Step #', 'Step', 'Sessions'],
    rows: sortedRows_(funnel, function (k, o) { var p = k.split('|'); return [p[0], Number(p[1]) + 1, STEP[Number(p[1])], o.n || 0]; }) };

  tabs.Sources = { cols: ['Date', 'Channel', 'Referrer', 'Sessions', 'Engaged sessions', 'Leads'],
    rows: sortedRows_(sources, function (k, o) { var p = k.split('|'); return [p[0], p[1], p[2], o.sessions || 0, o.engaged || 0, o.leads || 0]; }) };

  tabs.Cards = { cols: ['Date', 'Card', 'Shown', 'Closed', 'Not now', 'WhatsApp', 'Minimised', 'Submitted'],
    rows: sortedRows_(cards, function (k, o) { var p = k.split('|'); return [p[0], p[1], o.shown || 0, o.closed || 0, o.later || 0, o.whatsapp || 0, o.minimised || 0, o.submitted || 0]; }) };

  tabs.Devices = { cols: ['Date', 'Device', 'Sessions', 'Engaged sessions', 'Leads'],
    rows: sortedRows_(devices, function (k, o) { var p = k.split('|'); return [p[0], p[1], o.sessions || 0, o.engaged || 0, o.leads || 0]; }) };

  return { tabs: tabs, sessions: list, insights: insights_(list, nowDate, 30), dash: dashData_(list, nowDate, 30), snapshot: snapshots_(list, nowDate) };
}

function newSession_(sid, vid, date, visit, type, lp, ref, channel, device) {
  return { sid: sid, vid: vid, date: date, visit: visit, type: type || 'New', lp: lp, ref: ref || '', channel: channel || 'Direct', device: device || 'Desktop',
    events: 0, pageviews: 0, pages: {}, dwell: 0, activeSec: 0, sec: {}, pageDwell: {}, depth: {}, clicks: [], inter: [], cards: [], widgets: 0,
    decisionHit: false, leakMax: 0, auditMax: 0, calcStaff: '', estStaff: '', contact: false, formStart: false, lead: false, engaged: false, decision: false };
}

function widget_(s, kind, detail, val) {
  s.widgets++;
  if (kind === 'industry') { s.inter.push(['Industry picked', detail]); s.decisionHit = true; }
  else if (kind === 'faq') { s.inter.push(['FAQ question opened', detail]); if (/cost|price/i.test(detail)) s.decisionHit = true; }
  else if (kind === 'rec') s.inter.push(['Automation example viewed', detail]);
  else if (kind === 'cap') s.inter.push(['Product part viewed', detail]);
  else if (kind === 'scn') { s.inter.push(['Day scenario run', detail]); s.decisionHit = true; }
  else if (kind === 'leak') { if (Number(val) > s.leakMax) s.leakMax = Number(val); }
  else if (kind === 'audit') { if (Number(val) > s.auditMax) s.auditMax = Number(val); if (Number(val) >= 3) s.decisionHit = true; }
  else if (kind === 'calc') { s.calcStaff = Number(val) || s.calcStaff; s.decisionHit = true; }
  else if (kind === 'est') { s.estStaff = Number(val) || s.estStaff; s.decisionHit = true; }
}

function k_(t) { return String(t).replace(/\|/g, '/'); }

function addInter_(map, D, kind, item, sid) { var o = bump_(map, D + '|' + kind + '|' + k_(item), 'count'); o.sids = o.sids || {}; o.sids[sid] = true; }

function bucket_(n) { n = Number(n); return n < 10 ? '1-9 staff' : n < 20 ? '10-19 staff' : n < 50 ? '20-49 staff' : n < 100 ? '50-99 staff' : '100+ staff'; }

function clickType_(c) {
  var h = String(c.href || ''), l = String(c.label || '');
  if (/wa\.me|^tel:|^mailto:/i.test(h)) return 'Contact link';
  if (/\/contact\//.test(h) || /demo|call back|book/i.test(l)) return 'CTA';
  if (/^[\/#]/.test(h)) return 'Navigation';
  return 'Interaction';
}

function sortedRows_(map, fn) {
  return Object.keys(map).sort().map(function (k) { return fn(k, map[k]); }).filter(function (r) { return r; });
}

function round_(v, d) { var m = Math.pow(10, d); return Math.round((v || 0) * m) / m; }

function fmtDate_(v) { return v instanceof Date ? day_(v.getTime()) : String(v).slice(0, 10); }

/* ---------------------------------------------------------------- insights */

// Plain-English headlines for the last 30 days against the 30 before, each with a "so what".
function insights_(list, nowDate, days) {
  days = days || 30;
  var end = day_(nowDate.getTime()), start = day_(nowDate.getTime() - (days - 1) * 864e5), pStart = day_(nowDate.getTime() - (2 * days - 1) * 864e5), pEnd = day_(nowDate.getTime() - days * 864e5);
  var minSessions = Math.max(8, Math.round(CFG.MIN_SESSIONS_FOR_INSIGHTS * days / 30));
  var cur = list.filter(function (s) { return s.date >= start && s.date <= end; });
  var prev = list.filter(function (s) { return s.date >= pStart && s.date <= pEnd; });
  var out = { updated: Utilities.formatDate(nowDate, CFG.TZ, 'dd MMM yyyy, HH:mm') + ' IST', headlines: [], numbers: [], days: days, min: minSessions, enough: cur.length >= minSessions, sessions: cur.length };

  function agg(arr) {
    var vis = {}, o = { sessions: arr.length, visitors: 0, engaged: 0, leads: 0, active: 0, mobile: 0, returning: 0 };
    arr.forEach(function (s) { vis[s.vid] = 1; if (s.engaged) o.engaged++; if (s.lead) o.leads++; o.active += s.activeSec; if (s.device === 'Mobile') o.mobile++; if (s.type === 'Returning') o.returning++; });
    o.visitors = Object.keys(vis).length; return o;
  }
  var a = agg(cur), b = agg(prev);
  function pct(x, y) { return y ? Math.round(x / y * 100) : 0; }
  function chg(x, y) { return y ? (x >= y ? '+' : '') + Math.round((x - y) / y * 100) + '%' : 'n/a'; }
  out.numbers = [
    ['Sessions', a.sessions, b.sessions, chg(a.sessions, b.sessions)],
    ['Visitors', a.visitors, b.visitors, chg(a.visitors, b.visitors)],
    ['Engaged sessions', a.engaged, b.engaged, chg(a.engaged, b.engaged)],
    ['Engagement rate', pct(a.engaged, a.sessions) + '%', pct(b.engaged, b.sessions) + '%', ''],
    ['Avg active seconds per session', a.sessions ? Math.round(a.active / a.sessions) : 0, b.sessions ? Math.round(b.active / b.sessions) : 0, ''],
    ['Leads', a.leads, b.leads, chg(a.leads, b.leads)],
    ['Lead rate (leads / sessions)', (a.sessions ? round_(a.leads / a.sessions * 100, 1) : 0) + '%', (b.sessions ? round_(b.leads / b.sessions * 100, 1) : 0) + '%', ''],
    ['Mobile share', pct(a.mobile, a.sessions) + '%', pct(b.mobile, b.sessions) + '%', ''],
    ['Returning visitors (sessions)', a.returning, b.returning, chg(a.returning, b.returning)]
  ];
  if (!out.enough) { out.headlines.push(['Not enough data yet', 'Insights appear once there are at least ' + minSessions + ' sessions in the last ' + days + ' days (now ' + cur.length + ').']); return out; }

  function H(t, why) { out.headlines.push([t, why]); }

  H('Traffic: ' + a.sessions + ' sessions, ' + a.visitors + ' visitors (' + chg(a.sessions, b.sessions) + ' vs the previous ' + days + ' days). ' + pct(a.engaged, a.sessions) + '% were engaged.',
    'Engaged = 15+ seconds reading, 2+ pages, or used a widget. Below ~35% usually means the first screen or the traffic source is off.');

  // pages
  var pv = {}; cur.forEach(function (s) { Object.keys(s.pages).forEach(function (p) { pv[p] = (pv[p] || 0) + 1; }); });
  var pageRank = Object.keys(pv).sort(function (x, y) { return pv[y] - pv[x]; });
  if (pageRank.length) H('Most-visited page: ' + PAGE_LABEL[pageRank[0]] + ' (' + pct(pv[pageRank[0]], a.sessions) + '% of sessions)' + (pageRank[1] ? ', then ' + PAGE_LABEL[pageRank[1]] + ' (' + pct(pv[pageRank[1]], a.sessions) + '%)' : '') + '.',
    'Shows where interest actually is. A page almost nobody opens is either badly linked or not wanted.');

  // sections: most read and biggest drop-off
  var secStat = {};   // pg|sec -> {saw, read, dwell}
  cur.forEach(function (s) { Object.keys(s.sec).forEach(function (k) { var o = secStat[k] || (secStat[k] = { saw: 0, read: 0, dwell: 0 }); var ms = s.sec[k]; if (ms >= 1000) o.saw++; if (ms >= 5000) o.read++; o.dwell += ms; }); });
  var pageSessions = {}; cur.forEach(function (s) { Object.keys(s.pages).forEach(function (p) { pageSessions[p] = (pageSessions[p] || 0) + 1; }); });
  var keys = Object.keys(secStat).filter(function (k) { return secStat[k].saw >= 5 && k.split('|')[1] !== 'hero'; });
  keys.sort(function (x, y) { return secStat[y].dwell / secStat[y].saw - secStat[x].dwell / secStat[x].saw; });
  if (keys.length) {
    var top = keys[0], t = top.split('|'), ts = secStat[top];
    H('Most-read section: "' + (SECTION_LABEL[t[1]] || t[1]) + '" on ' + PAGE_LABEL[t[0]] + ' (avg ' + Math.round(ts.dwell / ts.saw / 1000) + 's, seen by ' + pct(ts.saw, pageSessions[t[0]] || 1) + '% of that page\'s sessions).',
      'This is what visitors care about. Lead with it higher up the page and give it a clear call to action.');
    var low = keys.filter(function (k) { return pct(secStat[k].saw, pageSessions[k.split('|')[0]] || 1) >= 5; }).sort(function (x, y) { return secStat[x].dwell / secStat[x].saw - secStat[y].dwell / secStat[y].saw; })[0];
    if (low && low !== top) { var l = low.split('|'), ls = secStat[low]; H('Least-read section: "' + (SECTION_LABEL[l[1]] || l[1]) + '" on ' + PAGE_LABEL[l[0]] + ' (avg ' + Math.round(ls.dwell / ls.saw / 1000) + 's).', 'People skim past it. Shorten it, move it lower, or cut it.'); }
  }
  var drop = null;
  Object.keys(ORDER).forEach(function (pg) {
    var seq = ORDER[pg], prevReach = null;
    seq.forEach(function (sec) {
      var o = secStat[pg + '|' + sec], reach = pageSessions[pg] ? (o ? o.saw : 0) / pageSessions[pg] : 0;
      if (prevReach !== null && prevReach >= 0.2 && (prevReach - reach) > (drop ? drop.gap : 0.15)) drop = { pg: pg, from: seq[seq.indexOf(sec) - 1], to: sec, gap: prevReach - reach, a: prevReach, b: reach };
      prevReach = reach;
    });
  });
  if (drop) H('Biggest drop-off: on ' + PAGE_LABEL[drop.pg] + ', ' + Math.round(drop.a * 100) + '% reach "' + (SECTION_LABEL[drop.from] || drop.from) + '" but only ' + Math.round(drop.b * 100) + '% reach "' + (SECTION_LABEL[drop.to] || drop.to) + '".',
    'Visitors leave between these two. Put a call to action before the drop, or make the next block pull harder.');

  // choices
  function topOf(kind) {
    var c = {}, tot = 0;
    cur.forEach(function (s) { var seen = {}; s.inter.forEach(function (it) { if (it[0] === kind && !seen[it[1]]) { seen[it[1]] = 1; c[it[1]] = (c[it[1]] || 0) + 1; tot++; } }); });
    var ks = Object.keys(c).sort(function (x, y) { return c[y] - c[x]; });
    return ks.length ? { name: ks[0], n: c[ks[0]], share: pct(c[ks[0]], tot), second: ks[1] } : null;
  }
  var ind = topOf('Industry picked'); if (ind) H('Most popular industry: ' + ind.name + ' (' + ind.share + '% of picks)' + (ind.second ? ', then ' + ind.second : '') + '.', 'Your strongest market by interest. Use its wording and examples in ads and the hero.');
  var faq = topOf('FAQ question opened'); if (faq) H('Most-opened FAQ: "' + faq.name + '" (' + faq.n + ' visits).', 'The question on owners\' minds. Answer it earlier on the page, not only in the FAQ.');
  var rec = topOf('Automation example viewed'); if (rec) H('Most-viewed automation example: "' + rec.name + '".', 'Tells you which automation to productise first.');
  var cs = {}; var csN = 0; cur.forEach(function (s) { if (s.calcStaff !== '') { var bk = bucket_(s.calcStaff); cs[bk] = (cs[bk] || 0) + 1; csN++; } });
  var csK = Object.keys(cs).sort(function (x, y) { return cs[y] - cs[x]; });
  if (csN >= 5) H('Loss calculator: most visitors try ' + csK[0] + ' (' + pct(cs[csK[0]], csN) + '% of ' + csN + ' who used it).', 'Roughly the size of business that is looking at you. Price and message for it.');

  var es = {}, esN = 0; cur.forEach(function (s) { if (s.estStaff !== '') { var eb = bucket_(s.estStaff); es[eb] = (es[eb] || 0) + 1; esN++; } });
  var esK = Object.keys(es).sort(function (x, y) { return es[y] - es[x]; });
  if (esN >= 5) H('Price estimator: most visitors try ' + esK[0] + ' (' + pct(es[esK[0]], esN) + '% of ' + esN + ' who used it).', 'The size of business that is checking your price. Make sure your quote and your device options fit it.');

  // CTAs
  var ctas = {}; cur.forEach(function (s) { s.clicks.forEach(function (c) { if (clickType_(c) === 'CTA' || clickType_(c) === 'Contact link') { var k = (c.label || c.href) + ' | ' + PAGE_LABEL[c.pg || 'home'] + ' / ' + (SECTION_LABEL[c.sec] || c.sec || 'header'); ctas[k] = (ctas[k] || 0) + 1; } }); });
  var ck = Object.keys(ctas).sort(function (x, y) { return ctas[y] - ctas[x]; });
  if (ck.length) H('Most-clicked call to action: "' + ck[0] + '" (' + ctas[ck[0]] + ' clicks).', 'Where people are ready to act. Copy that placement everywhere it fits.');

  // funnel
  var fs = [a.sessions, a.engaged, cur.filter(function (s) { return s.decision; }).length, cur.filter(function (s) { return s.contact; }).length, cur.filter(function (s) { return s.formStart; }).length, a.leads];
  var names = ['visited', 'engaged', 'showed buying interest', 'opened Contact', 'started a form', 'became a lead'];
  var worst = null; for (var i = 1; i < fs.length; i++) { var r = fs[i - 1] ? fs[i] / fs[i - 1] : 1; if (fs[i - 1] >= 10 && (!worst || r < worst.r)) worst = { r: r, i: i }; }
  H('Funnel: ' + fs[0] + ' visited > ' + fs[1] + ' engaged > ' + fs[2] + ' showed interest > ' + fs[3] + ' opened Contact > ' + fs[4] + ' started a form > ' + fs[5] + ' leads.',
    worst ? 'Weakest step: ' + names[worst.i - 1] + ' to ' + names[worst.i] + ' (' + Math.round(worst.r * 100) + '% continue). Fix that step first.' : 'Not enough volume to name a weak step yet.');

  // sources
  var src = {}; cur.forEach(function (s) { var o = src[s.channel] || (src[s.channel] = { n: 0, leads: 0, eng: 0 }); o.n++; if (s.lead) o.leads++; if (s.engaged) o.eng++; });
  var sk = Object.keys(src).sort(function (x, y) { return src[y].n - src[x].n; });
  if (sk.length) {
    H('Biggest traffic source: ' + sk[0] + ' (' + pct(src[sk[0]].n, a.sessions) + '% of sessions, ' + pct(src[sk[0]].eng, src[sk[0]].n) + '% engaged).', 'Check it against where your leads come from below.');
    var lk = sk.filter(function (k) { return src[k].leads > 0; }).sort(function (x, y) { return src[y].leads - src[x].leads; });
    if (lk.length) H('Most leads come from: ' + lk[0] + ' (' + src[lk[0]].leads + ' of ' + a.leads + ' leads, ' + round_(src[lk[0]].leads / src[lk[0]].n * 100, 1) + '% of its sessions).', 'Spend your effort where visitors turn into leads, not just visits.');
  }

  // devices and cards
  H('Mobile visitors: ' + pct(a.mobile, a.sessions) + '% of sessions.', 'If this is high, check the phone experience first; most owners will see the site on a phone.');
  var cardN = {}; cur.forEach(function (s) { s.cards.forEach(function (c) { var o = cardN[c[0]] || (cardN[c[0]] = { show: 0, done: 0 }); if (c[1] === 'show') o.show++; if (c[1] === 'done') o.done++; }); });
  var ckeys = Object.keys(cardN).filter(function (k) { return cardN[k].show >= 5; }).sort(function (x, y) { return cardN[y].done / cardN[y].show - cardN[x].done / cardN[x].show; });
  if (ckeys.length) H('Best-converting lead card: "' + ckeys[0] + '" (' + Math.round(cardN[ckeys[0]].done / cardN[ckeys[0]].show * 100) + '% of ' + cardN[ckeys[0]].show + ' shown leave their number).', 'Cards that convert show the right moment. Cards shown often and never answered should be reworded or retired.');
  return out;
}

function writeInsights_(ss, ins) {
  var sh = sheet_(ss, 'Insights');
  sh.clear();
  var rows = [['Rozka insights', ''], ['Updated ' + ins.updated + ' | last 30 days vs the 30 before', ''], ['', ''], ['HEADLINES', 'What it means / what to do']];
  ins.headlines.forEach(function (h) { rows.push(h); });
  rows.push(['', ''], ['KEY NUMBERS', 'Last 30 days']);
  var numStart = rows.length;
  ins.numbers.forEach(function (n) { rows.push([n[0], n[1], n[2], n[3]]); });
  var w = 4; rows = rows.map(function (r) { while (r.length < w) r.push(''); return r; });
  rows[numStart - 1] = ['KEY NUMBERS', 'Last 30 days', 'Previous 30 days', 'Change'];
  sh.getRange(1, 1, rows.length, w).setValues(rows);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sh.getRange(4, 1, 1, 2).setFontWeight('bold').setBackground('#0B4EA2').setFontColor('#FFFFFF');
  sh.getRange(numStart, 1, 1, w).setFontWeight('bold').setBackground('#0B4EA2').setFontColor('#FFFFFF');
  sh.setColumnWidth(1, 560); sh.setColumnWidth(2, 520); sh.setColumnWidth(3, 130); sh.setColumnWidth(4, 90);
  sh.getRange(5, 1, Math.max(ins.headlines.length, 1), 2).setWrap(true).setVerticalAlignment('top');
}

/* --------------------------------------------------------------- dashboard */

// Small tables for the last 30 days, shaped for charts. Pure function (no Sheets calls) so it can be tested.
function dashData_(list, nowDate, days) {
  days = days || 30;
  var end = day_(nowDate.getTime()), start = day_(nowDate.getTime() - (days - 1) * 864e5);
  var cur = list.filter(function (s) { return s.date >= start && s.date <= end; });
  var d = {};

  var byDay = {}; cur.forEach(function (s) { var o = byDay[s.date] || (byDay[s.date] = { n: 0, l: 0 }); o.n++; if (s.lead) o.l++; });
  d.trend = []; for (var i = days - 1; i >= 0; i--) { var D = day_(nowDate.getTime() - i * 864e5), o = byDay[D] || { n: 0, l: 0 }; d.trend.push([D, o.n, o.l]); }
  if (!cur.length) d.trend = [];

  var pv = {}; cur.forEach(function (s) { Object.keys(s.pages).forEach(function (p) { pv[p] = (pv[p] || 0) + 1; }); });
  d.pages = PAGES.filter(function (p) { return pv[p]; }).map(function (p) { return [PAGE_LABEL[p], pv[p]]; });

  var homeSessions = pv.home || 0, stat = {};
  cur.forEach(function (s) { Object.keys(s.sec).forEach(function (k) { if (k.indexOf('home|') !== 0) return; var o = stat[k] || (stat[k] = { saw: 0, dwell: 0 }); if (s.sec[k] >= 1000) { o.saw++; o.dwell += s.sec[k]; } }); });
  d.sections = homeSessions ? ORDER.home.map(function (sec) { var o = stat['home|' + sec] || { saw: 0, dwell: 0 };
    return [SECTION_LABEL[sec] || sec, round_(o.saw / homeSessions * 100, 1), o.saw ? round_(o.dwell / o.saw / 1000, 1) : 0]; }) : [];

  function top(kind, n) {
    var c = {}; cur.forEach(function (s) { var seen = {}; s.inter.forEach(function (it) { if (it[0] === kind && !seen[it[1]]) { seen[it[1]] = 1; c[it[1]] = (c[it[1]] || 0) + 1; } }); });
    return Object.keys(c).sort(function (x, y) { return c[y] - c[x]; }).slice(0, n).map(function (k) { return [k, c[k]]; });
  }
  d.industries = top('Industry picked', 8);
  d.faq = top('FAQ question opened', 8);

  var STEPS = ['Visited', 'Engaged', 'Showed interest', 'Opened Contact', 'Started a form', 'Became a lead'];
  var counts = [cur.length, cur.filter(function (s) { return s.engaged; }).length, cur.filter(function (s) { return s.decision; }).length,
    cur.filter(function (s) { return s.contact; }).length, cur.filter(function (s) { return s.formStart; }).length, cur.filter(function (s) { return s.lead; }).length];
  d.funnel = cur.length ? STEPS.map(function (n, i) { return [n, counts[i]]; }) : [];

  var src = {}; cur.forEach(function (s) { var o = src[s.channel] || (src[s.channel] = { n: 0, l: 0 }); o.n++; if (s.lead) o.l++; });
  d.sources = Object.keys(src).sort(function (x, y) { return src[y].n - src[x].n; }).slice(0, 8).map(function (k) { return [k, src[k].n, src[k].l]; });

  var dev = {}; cur.forEach(function (s) { dev[s.device] = (dev[s.device] || 0) + 1; });
  d.devices = Object.keys(dev).sort(function (x, y) { return dev[y] - dev[x]; }).map(function (k) { return [k, dev[k]]; });

  var cards = {}; cur.forEach(function (s) { s.cards.forEach(function (c) { var o = cards[c[0]] || (cards[c[0]] = { show: 0, done: 0 }); if (c[1] === 'show') o.show++; if (c[1] === 'done') o.done++; }); });
  d.cards = Object.keys(cards).filter(function (k) { return cards[k].show; }).sort(function (x, y) { return cards[y].show - cards[x].show; }).map(function (k) { return [k, cards[k].show, cards[k].done]; });

  var BK = ['1-9 staff', '10-19 staff', '20-49 staff', '50-99 staff', '100+ staff'], bc = {};
  cur.forEach(function (s) { if (s.calcStaff !== '') { var b = bucket_(s.calcStaff); bc[b] = (bc[b] || 0) + 1; } });
  d.calc = Object.keys(bc).length ? BK.map(function (b) { return [b, bc[b] || 0]; }) : [];
  return d;
}

// Writes the chart tables to DashData and draws the charts on the Dashboard tab. Rebuilt on every aggregate().
function buildDashboard_(ss, ins, d) {
  var dd = sheet_(ss, 'DashData'), db = sheet_(ss, 'Dashboard');
  dd.clearContents(); db.clear();
  db.getCharts().forEach(function (c) { db.removeChart(c); });

  var T = [
    { k: 'trend', head: ['Date', 'Sessions', 'Leads'], title: 'Sessions and leads per day (last 30 days)', type: Charts.ChartType.LINE },
    { k: 'pages', head: ['Page', 'Sessions'], title: 'Which pages are used (sessions)', type: Charts.ChartType.COLUMN },
    { k: 'sections', head: ['Home section', 'Reach %', 'Avg seconds'], title: 'Home: how many reach each section (%), in reading order', type: Charts.ChartType.COLUMN, cols: 2 },
    { k: 'sections', head: ['Home section', 'Reach %', 'Avg seconds'], title: 'Home: average seconds spent in each section', type: Charts.ChartType.COLUMN, cols: 'secs' },
    { k: 'industries', head: ['Industry', 'Visitors who picked it'], title: 'Which industry visitors pick', type: Charts.ChartType.BAR },
    { k: 'faq', head: ['FAQ question', 'Visitors who opened it'], title: 'Which FAQ questions get opened', type: Charts.ChartType.BAR },
    { k: 'funnel', head: ['Step', 'Sessions'], title: 'Funnel: from visit to lead', type: Charts.ChartType.COLUMN },
    { k: 'sources', head: ['Channel', 'Sessions', 'Leads'], title: 'Where visitors come from, and which channel gives leads', type: Charts.ChartType.COLUMN },
    { k: 'devices', head: ['Device', 'Sessions'], title: 'Phone, tablet or desktop', type: Charts.ChartType.PIE },
    { k: 'cards', head: ['Lead card', 'Shown', 'Left a number'], title: 'Lead cards: shown vs answered', type: Charts.ChartType.COLUMN },
    { k: 'calc', head: ['Staff size', 'Visitors'], title: 'Loss calculator: staff size visitors try', type: Charts.ChartType.COLUMN }
  ];

  // data tables, one block of columns each (the Sections table is shared by two charts)
  var placed = {}, col = 1;
  T.forEach(function (t) {
    if (placed[t.k]) { t.col = placed[t.k].col; t.n = placed[t.k].n; return; }
    var rows = d[t.k] || [];
    dd.getRange(1, col, 1, t.head.length).setValues([t.head]).setFontWeight('bold');
    if (rows.length) dd.getRange(2, col, rows.length, t.head.length).setValues(rows);
    t.col = col; t.n = rows.length; placed[t.k] = { col: col, n: rows.length }; col += t.head.length + 1;
  });

  // heading and key numbers
  db.getRange(1, 1).setValue('Rozka dashboard').setFontSize(18).setFontWeight('bold');
  db.getRange(2, 1).setValue('Updated ' + ins.updated + ' | last 30 days | headlines are in the Insights tab').setFontColor('#5B6067');
  var nums = ins.numbers, labels = [], values = [];
  [0, 1, 3, 5, 6].forEach(function (i) { if (nums[i]) { labels.push(nums[i][0]); values.push(nums[i][1]); } });
  db.getRange(4, 1, 1, labels.length).setValues([labels]).setFontWeight('bold').setBackground('#0B4EA2').setFontColor('#FFFFFF');
  db.getRange(5, 1, 1, values.length).setValues([values]).setFontSize(20).setFontWeight('bold').setHorizontalAlignment('left');
  for (var c = 1; c <= 14; c++) db.setColumnWidth(c, 80);
  if (!ins.enough) db.getRange(6, 1).setValue('Not enough data yet: charts fill in as visits arrive (' + ins.sessions + ' sessions in the last 30 days).').setFontColor('#5B6067');

  // charts: two per row
  var slot = 0;
  T.forEach(function (t) {
    if (!t.n) return;
    var row = 8 + Math.floor(slot / 2) * 17, anchorCol = slot % 2 ? 8 : 1;
    var ncols = t.cols === 2 ? 2 : t.cols === 'secs' ? 2 : t.head.length;
    var rng = t.cols === 'secs'
      ? dd.getRange(1, t.col, t.n + 1, 1)
      : dd.getRange(1, t.col, t.n + 1, ncols);
    var b = db.newChart().setChartType(t.type).addRange(rng);
    if (t.cols === 'secs') b.addRange(dd.getRange(1, t.col + 2, t.n + 1, 1));
    b.setNumHeaders(1).setPosition(row, anchorCol, 0, 0).setOption('title', t.title).setOption('width', 560).setOption('height', 300)
      .setOption('legend', { position: ncols > 2 || t.type === Charts.ChartType.PIE ? 'bottom' : 'none' });
    db.insertChart(b.build());
    slot++;
  });
}

/* ---------------------------------------------------- html dashboard data */

// One snapshot per range, computed hourly so the page opens instantly.
function snapshots_(list, nowDate) {
  var snap = { updated: Utilities.formatDate(nowDate, CFG.TZ, 'dd MMM yyyy, HH:mm') + ' IST', ranges: {} };
  CFG.RANGES.forEach(function (days) { snap.ranges[days] = { days: days, insights: insights_(list, nowDate, days), dash: dashData_(list, nowDate, days) }; });
  return snap;
}

function writeSnapshot_(ss, snap) {
  var sh = sheet_(ss, 'DashJson');
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([['Part', 'Parts', 'Dashboard JSON (read by the HTML dashboard)']]).setFontWeight('bold');
  var json = JSON.stringify(snap), n = Math.max(1, Math.ceil(json.length / CFG.SNAP_CHUNK)), rows = [];
  for (var i = 0; i < n; i++) rows.push([i + 1, n, json.slice(i * CFG.SNAP_CHUNK, (i + 1) * CFG.SNAP_CHUNK)]);
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}
