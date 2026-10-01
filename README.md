# Ad Astra

A static website to follow upcoming rocket launches and spaceflight news. No build step or dependencies.

## Features

- **Next launch** hero with a live T-minus countdown
- **Upcoming launches** grid (next 40), with search, provider filter and "confirmed only" toggle
- **Launch details**: mission, orbit, pad, weather probability, map link, related news articles
- **Live streams**: "Watch the stream" button on the next launch, a `▶ Stream` / `● Live` badge on cards, and the full list of webcasts (official first) in each launch's details
- **Shareable links**: `#launch=<id>` opens a launch's details directly
- **Add to calendar**: downloads an `.ics` file for any launch with a precise time
- **Spaceflight news** feed with "Load more"
- **Auto-refresh**: launches, streams and news update every 5 minutes without reloading the page
- Times shown in the visitor's local time zone; coarse dates (NET month / quarter) shown as such

## Run locally

Double-click **`start.bat`** (Windows). It builds the launch-data snapshot with Node (if installed),
starts a local server with Python and opens http://localhost:8000.

Manually:

```sh
node scripts/fetch-data.mjs   # optional: writes data/launches.json
python -m http.server 8000
```

## Publish on GitHub Pages

1. Create a **public** GitHub repository and push this folder to its `main` branch.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow `.github/workflows/deploy.yml` deploys the site on every push, and **every 10 minutes**
   re-fetches the launch data and redeploys, so visitors always get fresh data from a static file.
   (Actions → "Deploy to GitHub Pages" → *Run workflow* triggers it by hand.)

The site will be at `https://<user>.github.io/<repo>/`.

Notes:
- `data/` is generated, never committed (see `.gitignore`).
- GitHub may delay scheduled runs by a few minutes at busy times, and **disables scheduled workflows after
  60 days without repository activity**; re-enable it from the Actions tab if that happens.
- If a run can't reach the API, it fails without deploying and the previous version stays online.

## How the data flows

```
GitHub Actions (every 10 min) ── 1 request ──▶ Launch Library 2 (detailed, incl. streams)
        │ trims 1.4 MB → ~65 KB
        ▼
data/launches.json (published with the site)
        ▲
Browser ── reads snapshot, re-checks every 5 min (auto-refresh, no reload)
   │
   ├─ snapshot missing or > 2 h old → falls back to calling Launch Library 2 directly
   └─ news → Spaceflight News API directly (no rate-limit issue)
```

## Data sources

| Data | API | Notes |
|---|---|---|
| Launches & live streams | [Launch Library 2](https://thespacedevs.com/llapi) `2.3.0` | Free tier: **15 requests/hour per IP**. Fetched by GitHub Actions; the browser only calls it as a fallback (cached 10 min in `localStorage`) |
| News | [Spaceflight News API](https://spaceflightnewsapi.net) `v4` | No key needed, cached 5 min |

## Structure

```
index.html                    page layout
css/styles.css                theme (dark, starfield)
js/app.js                     data loading, auto-refresh, rendering, countdowns, .ics export
scripts/fetch-data.mjs        builds data/launches.json (Node 18+, no dependencies)
.github/workflows/deploy.yml  scheduled build + GitHub Pages deployment
start.bat                     local start (Windows)
```
