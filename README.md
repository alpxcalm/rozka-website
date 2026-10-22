# rozka-website

Static site for https://rozka.work, served by GitHub Pages.

`index.html` is the one file to edit. After changing it, run:

```
node scripts/build.mjs
```

That regenerates `automation/`, `about/`, `pricing/` and `contact/`, the Hindi (`hi/`) and Marathi (`mr/`) copies of every page, the SEO head tags, `sitemap.xml`, `robots.txt`, `llms.txt` and `404.html`. Titles, descriptions, the domain and the keys below are in the config at the top of `scripts/build.mjs`.

Preview real URLs locally with `python3 -m http.server`.

## Languages (English, Hindi, Marathi)

English text is the source and the key. Anything a visitor reads is either marked in `index.html` or wrapped in `_('English text')` in the scripts; `i18n/hi.json` and `i18n/mr.json` map each English string to its translation, and the build writes `/hi/...` and `/mr/...` pages (html lang `hi-IN` / `mr-IN`, hreflang, per-language title and description, sitemap alternates) plus the EN / हिं / मरा switcher in the header and footer.

- Marking: `data-i` on an element translates its inner HTML, `data-ia="aria-label,placeholder"` translates attributes, `_('... {name} ...', {name: v})` is for script text. Tags and `{placeholders}` must stay identical in the translation.
- `node scripts/i18n.mjs mark` marks any new unmarked text in `index.html`; `node scripts/i18n.mjs check` lists missing translations, broken tags and placeholders. Page titles and descriptions live in `scripts/pages.mjs`. `node scripts/build.mjs --strict` fails on any missing translation.
- The mock product screens (the hero window and the five panels under "What Rozka does") are English on every page by design.
- Analytics and the Sheet stay language-neutral: section names, click labels and widget details are always the English ones. The language of the page is a separate field (Sheet column "Site language" on Leads and Sessions, a Languages tab and a dashboard card).
- Adding a language: add it to `LANG` / `LANGS` in `scripts/build.mjs` and `LANGS` in `scripts/i18n.mjs`, add `i18n/<code>.json`, add the code to `SITE_LANGS` in both Apps Script files, rebuild.

## Leads, tracking and replay

Every form (contact page, automation idea, the lead card) saves to a Google Sheet through Apps Script and keeps WhatsApp as the alternative.
The site records what a visitor does (pages, sections, clicks, scroll, widget use, never typed text) as timed JSON in localStorage, and sends it with a lead.

1. Deploy `apps-script/Code.gs` (steps are in its header), then set `LEAD_ENDPOINT` in `scripts/build.mjs`.
2. Bot protection: create an Invisible Turnstile widget for rozka.work, set `TURNSTILE_SITEKEY` in `scripts/build.mjs` and `TURNSTILE_SECRET` in the Apps Script properties.
3. Replay a lead, locally and without a password: in the Sheet click any cell in the lead's row on the Leads tab, then Rozka menu > Show replay JSON for the selected lead, and copy it.
   Run the site locally (`python3 -m http.server`, then http://localhost:8000/?rzr=paste, or open `index.html?rzr=paste` from disk) and paste it.
   The viewer is `tools/replay.js`: git-ignored, never deployed, and ignored by the live site (`?rzr` does nothing on rozka.work).
   In replay mode Google Analytics, tracking, lead cards and form sends are all off.

Only the live site counts: Google Analytics is switched off everywhere except rozka.work (localhost, file:// and previews send nothing),
and a lead sent from any other host goes to the Quarantine tab instead of Leads.

## Site analytics (which page and section people use)

An anonymous trimmed copy of the trail goes to a second Apps Script project (`apps-script/Analytics.gs`) and its own Sheet, which rebuilds Looker-ready tabs and an Insights tab every hour.
No names, phones, typed text or IPs. Live site only, off for bots, Do-Not-Track and Global Privacy Control, and off in any browser that visited `?an=off`.
Set `ANALYTICS_ENDPOINT` in `scripts/build.mjs`. The project serves a private HTML dashboard (`apps-script/Dashboard.html`, owner-only link with a 7/30/90 day switch) and the Sheet draws its own Dashboard and Insights tabs every hour; `apps-script/Looker-Studio-guide.md` is the optional Looker Studio version.

Until `LEAD_ENDPOINT` is set, forms fall back to WhatsApp only.
