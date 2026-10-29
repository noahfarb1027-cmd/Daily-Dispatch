// Cloudflare Worker for Noah's Daily Dispatch.
//
// Serves the newspaper from ./site, and each morning starts the GitHub
// workflow that prints the day's edition. GitHub's own scheduler skips runs
// too often to rely on; Cloudflare's cron triggers are dependable.
//
// Secret: GITHUB_TOKEN, a fine-grained token with Actions read & write
// access to noahfarb1027-cmd/Daily-Dispatch.

const REPO = "noahfarb1027-cmd/Daily-Dispatch";
const WORKFLOW = "daily-edition.yml";

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    if (!env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN secret is not set on this Worker.");
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "daily-dispatch-worker",
      },
      body: JSON.stringify({ ref: "main", inputs: { force: false } }),
    });
    if (res.status !== 204) {
      throw new Error(`GitHub refused to start the workflow (${res.status}): ${await res.text()}`);
    }
    console.log(`Started ${WORKFLOW} for cron "${controller.cron}"`);
  },
};
