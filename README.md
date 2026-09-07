# ₹1,000 Stock Finder — GitHub Pages

A static Indian-stock research dashboard designed around a ₹1,000 portfolio budget.

## Repository structure

```text
rupee1000-stock-finder/
├── index.html
├── styles.css
├── app.js
├── README.md
├── data/
│   └── stocks.json
├── scripts/
│   └── update_data.py
└── .github/
    └── workflows/
        └── pages.yml
```

## 1. Create the GitHub repository

1. Sign in to GitHub.
2. Click **New repository**.
3. Suggested repository name: `rupee1000-stock-finder`.
4. For a free GitHub Pages setup, make the repository **Public**.
5. Do not initialize it with a README if you are uploading this complete folder.
6. Create the repository.

GitHub Pages is available for public repositories on GitHub Free. See the official documentation:
https://docs.github.com/en/pages/getting-started-with-github-pages

## 2. Upload this exact structure

Upload the contents of this folder—not the ZIP file itself—so that `index.html` is at the repository root.

The `.github/workflows/pages.yml` file is important. GitHub Actions workflows must live under `.github/workflows/`.

## 3. Enable GitHub Pages

In your repository:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

Do not choose "Deploy from a branch" for this version. The included workflow uses the official Pages Actions deployment flow.

## 4. First deployment

After uploading/committing the files:

1. Open the **Actions** tab.
2. Select **Deploy Stock Finder to GitHub Pages**.
3. Open the latest run.
4. Wait for the build/deployment to finish.
5. Go back to **Settings → Pages**.
6. Click **Visit site**.

Your project URL will normally be:

`https://YOUR-USERNAME.github.io/rupee1000-stock-finder/`

GitHub notes that publication can take several minutes.

## 5. Automatic refresh

The workflow runs:

- whenever you push to `main`
- manually from Actions → Run workflow
- weekdays at approximately 10:00 AM IST

The scheduled run executes:

`python scripts/update_data.py`

Then it deploys the resulting static site.

### IMPORTANT

The included `scripts/update_data.py` is intentionally a safe placeholder. It does not fabricate current stock data and does not scrape a website.

Before using this as a live investment-research service, connect it to a legitimate, authorized market-data provider and implement:

1. current price retrieval
2. financial-statement retrieval
3. valuation calculations
4. promoter/shareholding data
5. corporate actions
6. news/catalyst data
7. validation/fallback logic
8. score calculation

Then have the script write the validated results to:

`data/stocks.json`

## 6. Add an API key only if your provider requires one

If your chosen data provider supplies an API key:

**Repository → Settings → Secrets and variables → Actions → New repository secret**

Use:

`MARKET_DATA_API_KEY`

Never hard-code the key inside `app.js`, `index.html`, or `data/stocks.json`.

## 7. Current data warning

The included stock rows are DEMO DATA. They are not current recommendations.

The site should not be presented as a live investment product until its data source has been connected, validated, and checked for licensing/usage restrictions.

## 8. GitHub Pages deployment architecture

```text
GitHub repository
       │
       ├── index.html
       ├── styles.css
       ├── app.js
       └── data/stocks.json
                │
                ▼
       GitHub Actions
                │
       ┌────────┴────────┐
       │                 │
   Refresh data      Configure Pages
       │                 │
       └────────┬────────┘
                ▼
       Pages artifact
                │
                ▼
        GitHub Pages site
```

## 9. Troubleshooting

### Site shows 404
Check:
- Settings → Pages → Source is **GitHub Actions**
- the workflow completed successfully
- `index.html` is at the repository root

### Site loads but cards are empty
Check that:
- `data/stocks.json` exists
- the browser can access `data/stocks.json`
- the JSON is valid

### Workflow fails
Open:
**Actions → Deploy Stock Finder to GitHub Pages → failed run**

Read the failed step first.

### Scheduled update doesn't run at exactly 10:00 AM
GitHub Actions scheduled workflows can be delayed during periods of high load. Treat the cron time as approximate.

## Disclaimer

This website is an educational research tool, not financial advice. Scores, fair values, forecasts and portfolio allocations are model outputs and may be wrong. Verify exchange data, company filings, corporate announcements and valuation assumptions before making investment decisions.


## Live market-data connection: Twelve Data

This repository is wired to **Twelve Data** for NSE data.

Twelve Data documents NSE coverage (MIC `XNSE`) and provides price/time-series data and a `/statistics` endpoint with valuation, financial and cash-flow metrics. The `/statistics` endpoint is a paid endpoint (currently documented as Pro/Venture and above), so the live scoring workflow requires a plan that includes it. Do not assume a free API key will provide the full dataset.

Official references:
- https://twelvedata.com/exchanges/xnse
- https://twelvedata.com/fundamentals
- https://twelvedata.com/docs/volume-indicators

### Connect the API key

1. Create a Twelve Data account and obtain an API key.
2. In GitHub open **Settings → Secrets and variables → Actions**.
3. Click **New repository secret**.
4. Name it exactly:
   `TWELVE_DATA_API_KEY`
5. Paste the key as the value.
6. Save.

The key is used only by the GitHub Actions runner. It is never placed in browser JavaScript.

### What the updater does

`scripts/update_data.py` calls:

- `/price` for the current/latest provider price.
- `/statistics` for the provider's current financial/valuation snapshot.

It then computes only transparent derived fields such as:

`EPS proxy = price / trailing P/E`

and:

`screening fair value = EPS proxy × 20`

This is deliberately labeled as a **screening model**, not intrinsic value.

The script does **not** invent missing ROCE, debt/equity, growth or promoter data. When Twelve Data does not provide a metric, the value remains `null`.

The refresh is atomic:
- If every configured symbol succeeds, `stocks.json` is replaced.
- If any symbol fails, the workflow fails and the previous `stocks.json` remains unchanged.

### Important scoring limitation

The current Twelve Data `/statistics` snapshot documents ROE but does not document every metric used by the original score (for example ROCE and debt/equity). Therefore those fields are intentionally `null` until a second authorized source/endpoint is added.

This is preferable to filling them with estimates or stale values.

### Scheduled workflow

`.github/workflows/pages.yml` runs:
- on pushes to `main`
- manually via **Actions → Run workflow**
- weekdays at approximately 10:00 AM IST

The scheduled job refreshes `stocks.json`, commits the verified result, and deploys the site.

### API usage / cost

Twelve Data charges API credits by endpoint; its documentation lists `/price` at 1 credit per symbol and `/statistics` at 50 credits per symbol. Check your current plan/limits before scheduling a large universe.

For this reason the repository uses a small configurable universe in `data/universe.json` rather than requesting every NSE listing on every run.

### Data licensing

Twelve Data is the chosen provider for this repository, but you are responsible for checking the provider's current terms, redistribution/display rights and your intended use before publishing market data publicly. NSE also has its own market-data usage and redistribution policy.

This repository does not scrape NSE pages and does not bypass exchange access controls.

### Expanding the system

For the full original 100-point research score, add an additional authorized source for:
- ROCE
- debt/equity
- 3Y/5Y revenue and profit CAGR
- promoter holding/pledging
- historical valuation
- peer valuation

Then update `scripts/update_data.py` to combine those sources with strict source attribution and null-safe validation.
