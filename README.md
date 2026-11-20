# @mrfentmen npm download tracker

A static GitHub Pages dashboard that tracks downloads across every npm package
maintained by `@mrfentmen` (5,600+ and counting), with a 52-week history per
package and an embeddable weekly badge for each package's npm README.

No server, no database, no API keys, no Cloudflare account. A GitHub Action
pulls npm's public download API once a week and publishes the generated site.

## What's here

| File | Purpose |
|------|---------|
| `collect.mjs` | Pulls package inventory + download stats, writes `public/data.json` and ~5,600 SVG badges. Resumable via local `state.json`. |
| `public/index.html` | The dashboard: headline totals, site-wide weekly chart, top-20, searchable/sortable table, per-package detail with weekly chart, badge generator. |
| `public/data.json` | Generated data (published by the Action, not committed). |
| `public/badges/*.svg` | Generated weekly-download badges, one per package. |
| `.github/workflows/refresh.yml` | Runs the collector every Monday 06:17 UTC and deploys to Pages. |

## Setup (one-time)

1. Create a **public** GitHub repo (e.g. `npm-tracker`) and push these files to `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab → **Weekly npm tracker refresh** → **Run workflow** for the first publish.
4. Your site will be at `https://<your-username>.github.io/<repo>/`.
5. After that it republishes itself automatically every Monday. You can also trigger it manually anytime with **Run workflow**.

The Action uses GitHub's built-in `GITHUB_TOKEN` (already provisioned with the
Permissions block in the workflow) — no secrets to configure.

## Dashboard

- **Live feed**: while the collector runs it publishes `data.json` + `status.json` every 100 packages; the page auto-refreshes every 10 seconds with a progress banner, so you can watch the totals grow.
- **Overview**: total packages, last-7-day / last-31-day / all-time downloads, MCP split, 52-week history chart, top-20 leaderboard.
- **Table**: search by name/description, sort by any metric, toggle MCP-only, sparkline per package.
- **Package detail**: click any row → 7/31/all-time stats, a 52-week bar chart, npm link, and a copy-ready markdown badge snippet.
- **Badges**: the snippet points at `badges/<package>.svg` on your Pages site. Paste it into any package's `README.md` and it renders the current weekly download count.

## How the data is collected

npm's public download API (`api.npmjs.org`) has two quirks that the collector handles:

- Bulk lookups (128 packages/request) work with explicit date ranges but **cap at 365 days** → all-time is assembled from ~12 yearly windows.
- Bulk lookups **reject scoped names** (`@mrfentmen/...`) → those use paced single-package requests with checkpoints (`state.json`), so an interrupted run resumes instead of restarting.

Each pull asks for 365 days of daily data and rolls it into 52 weekly buckets, so the weekly charts are complete even if a pull is skipped. The collection takes roughly 30–45 minutes on a fresh run.

## Local development

```bash
node collect.mjs                       # generate public/data.json + badges
python3 -m http.server 8000 -d public  # preview at http://localhost:8000
```

Re-running `node collect.mjs` resumes from `state.json` if it was interrupted. Delete `state.json` to force a full refresh (or change the npm data window).

## Data notes

- npm counts registry downloads; installs via git URLs or other bypass routes are not counted.
- Very recently published packages may be absent from npm's download index for a day or two; they show as zero until indexed.
- "MCP servers" are detected by `mcp` appearing in the package name; everything else is grouped as "other".
