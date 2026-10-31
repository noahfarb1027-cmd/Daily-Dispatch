# Noah's Daily Dispatch

A personal morning newspaper. Every day at about 6:47 a.m. New York time, a Cloudflare cron trigger starts a GitHub Action that asks Claude Sonnet 5.5 (with web search) for the biggest stories in tech, business, world affairs, opinion and sports. It keeps only stories whose links actually came back from a search, then commits the edition to this repo. Cloudflare Pages redeploys the site on every commit.

```
site/                    ← the website (Cloudflare serves this folder)
  index.html             ← the newspaper page (today's edition + past editions)
  editions/index.json    ← list of every edition, newest first
  editions/YYYY-MM-DD.json
scripts/generate.mjs     ← prints one edition
.github/workflows/daily-edition.yml  ← runs the script
worker/index.js          ← Cloudflare Worker: serves site/ and starts the workflow each morning
wrangler.jsonc           ← Worker config, including the morning cron times (UTC)
```

## One-time setup

### 1. Add your Anthropic API key to GitHub

1. Create a key at https://platform.claude.com/settings/keys (Settings → API keys → Create key). Add a few dollars of credit under Billing.
2. In this repo on GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it `ANTHROPIC_API_KEY`, paste the key, and save.

Never commit the key to the repo.

### 2. Let the Action push commits

**Settings → Actions → General → Workflow permissions** → choose **Read and write permissions** → Save.

### 3. Put the site on Cloudflare Pages

1. Sign in at https://dash.cloudflare.com (a free account is fine).
2. Go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Authorize GitHub and pick this repository.
4. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`site`**
5. Click **Save and Deploy**. Your site is live at `https://<project-name>.pages.dev`.
6. Optional: to use your own domain, open the project, go to **Custom domains → Set up a custom domain**, and follow the prompts.

### 4. Let Cloudflare start the morning run

GitHub's own scheduler skips runs too often, so the Worker starts the workflow instead. It needs a GitHub token:

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories** → `Daily-Dispatch`. Permissions: **Actions → Read and write**. Pick an expiration and generate it.
3. In Cloudflare, open **Workers & Pages → daily-dispatch → Settings → Variables and Secrets → Add**, choose type **Secret**, name it `GITHUB_TOKEN`, paste the token and deploy.

When the token expires, generate a new one and replace the secret.

### 5. Test it

In GitHub, go to **Actions → Print daily edition → Run workflow**, tick **force**, and run it. In about 5–15 minutes a new commit appears, and Cloudflare redeploys within a minute.

## Running locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... FORCE=true npm run generate   # print today's edition
npm run preview                                            # view the site at http://localhost:3000
```

## Notes

- **Cost.** Each edition is one Claude Sonnet 5.5 run at medium effort with up to 30 web searches. The Action log prints each run's token usage and estimated cost on a line starting with `usage:`.
- **Source rules.** Searches are limited to the approved outlets in `ALLOWED_SOURCES` (`scripts/generate.mjs`); edit that list to add or remove sites. Before printing, a story is dropped if its link isn't on an approved outlet, never appeared in Claude's search results, is older than 2 days (opinion: 3), repeats a link already in the edition, reports the same event as an earlier news story anywhere in the edition (checked by a short second Claude call), or is an opinion piece with no real author or a second piece by the same author. If the lead story fails, or fewer than 6 stories pass, the run fails and nothing is published.
