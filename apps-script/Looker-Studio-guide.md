# Looker Studio dashboard for Rozka (optional, about 20 minutes)

**You may not need this.** The Analytics project already gives you a private **HTML dashboard** (a link only you can open, with a 7 / 30 / 90 day switch), a **Dashboard** tab of
11 charts in the Sheet, and an **Insights** tab of plain-English headlines, all rebuilt every hour by the script. Use Looker Studio only if you want a prettier, shareable report with date filters.

Looker Studio cannot be built by a script: Google offers no API to create a report's charts. The nearest thing is the Linking API, a one-click
"copy this template onto my data" link, and it still needs a template report built once by hand. If you build this report once and set it to
"Anyone with the link can view", send me its report ID and I can generate that one-click copy link for you.

Looker Studio (the new name for Google Data Studio) reads the tabs of the **Rozka Analytics** Sheet. The Sheet rebuilds those tabs every hour,
so the report stays current by itself. Each tab is a flat table (one row per date and dimension), which is exactly what Looker Studio likes.

## 1. Connect the data (once)
1. Go to lookerstudio.google.com, click **Create > Report**.
2. **Add data > Google Sheets > Rozka Analytics >** pick the worksheet **Daily**, keep "Use first row as headers" ticked, click **Add**.
3. Repeat **Add data** for: **Pages, Sections, Interactions, Clicks, Funnel, Sources, Cards, Devices** (nine data sources in total).
4. Open **Resource > Manage added data sources**, and for each one set **Data freshness** to 1 hour.

## 2. Calculated fields (Resource > Manage added data sources > Edit > Add a field)
Always divide sums, never average the rate columns, so busy days weigh more than quiet ones.

| Data source | Field name | Formula |
|---|---|---|
| Daily | Engagement rate % | `SUM(Engaged sessions) / SUM(Sessions)` |
| Daily | Lead rate % | `SUM(Leads) / SUM(Sessions)` |
| Daily | Avg active seconds | `SUM(Active seconds) / SUM(Sessions)` |
| Pages | Avg seconds per session | `SUM(Active seconds) / SUM(Sessions)` |
| Pages | Reached 75% scroll % | `SUM(Reached 75% scroll) / SUM(Sessions)` |
| Sections | Reach % | `SUM(Sessions that saw it (1s+)) / SUM(Page sessions)` |
| Sections | Read % | `SUM(Sessions that read it (5s+)) / SUM(Page sessions)` |
| Sections | Avg seconds when seen | `SUM(Total seconds) / SUM(Sessions that saw it (1s+))` |
| Sources, Devices | Lead rate % | `SUM(Leads) / SUM(Sessions)` |
| Cards | Conversion % | `SUM(Submitted) / SUM(Shown)` |

Set each of the % fields to type **Percent**.

## 3. The pages of the report
Add a **Date range control** and (on pages 2 and 3) a **Drop-down list** on `Page` or `Kind`.

**Page 1: Overview**
- Scorecards (Daily): Sessions, Visitors, Engagement rate %, Avg active seconds, Leads, Lead rate %.
- Time series (Daily): Date vs Sessions and Leads.
- Bar chart (Pages): Page vs Sessions. Pie (Devices): Device vs Sessions.

**Page 2: Which page and which section**
- Table (Pages): Page, Sessions, Avg seconds per session, Reached 75% scroll %. Sort by Sessions.
- Bar chart (Sections): Dimension `Section label`, metrics Reach % and Avg seconds when seen. Sort by `Order` ascending, filter `Page` = Home.
  The bars fall left to right as people leave: that drop is your biggest-leak map.
- Table (Sections): Page, Section label, Reach %, Read %, Avg seconds when seen, with a heat-map style on Avg seconds.
  High reach + high seconds = what people prefer. High reach + low seconds = they see it but skim it.

**Page 3: What visitors want** (all from Interactions, one chart per `Kind`, metric `Sessions`)
- `Industry picked` (bar), `FAQ question opened` (top 10 table), `Automation example viewed`, `Product part viewed`, `Day scenario run`,
  `Calculator: staff size`, `Wants to automate (contact form)`, `Staff size (contact form)`.
- Table (Clicks): Label, Page, Section, Kind, Clicks, Sessions. Filter `Kind` = CTA to see which "Book a demo" placement works best.

**Page 4: Funnel and sources**
- Bar chart (Funnel): Dimension `Step`, metric `Sessions`, sort by `Step #` ascending. Six bars: Visited > Engaged > Showed buying interest > Opened Contact > Started a form > Became a lead.
- Table (Sources): Channel, Referrer, Sessions, Engaged sessions, Leads, Lead rate %.

**Page 5: Lead cards** (Cards)
- Table: Card, Shown, Closed, Not now, WhatsApp, Submitted, Conversion %.
  Cards shown often and never answered should be reworded or retired.

## 4. Share
Click **Share** and add the people who should see it as **Viewer**. They do not need access to the Sheet itself.

## Words used
- **Engaged session**: 15+ seconds of reading, or 2+ pages, or any widget used (calculator, industry tab, FAQ, etc.).
- **Showed buying interest**: opened the Pricing page, used the price estimator or the calculator, opened the price FAQ, picked an industry, ran a day scenario, finished the owner's audit, or caught 3+ leaks.
- **Saw / read a section**: 1+ / 5+ seconds with that section in the middle of the screen.
