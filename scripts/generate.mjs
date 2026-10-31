// Prints the day's edition of Noah's Daily Dispatch.
//
// Asks Claude (with web search) to report the last day's biggest stories,
// keeps only stories whose links actually came back from a search, and writes
// site/editions/<date>.json plus the site/editions/index.json listing.
//
// Env: ANTHROPIC_API_KEY (required), FORCE=true to reprint today's edition.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EDITIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "editions");
const INDEX_PATH = path.join(EDITIONS_DIR, "index.json");
const TIME_ZONE = "America/New_York";
const EARLIEST_HOUR = 6; // don't print before 6 a.m. Eastern
const MODEL = "claude-sonnet-5-5";
const EFFORT = "medium";
const MAX_SEARCHES = 30;
// Sonnet 5.5 list prices, for the cost estimate in the log (USD).
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 2.5 / 1e6, search: 10 / 1000 };
const MAX_CONTINUATIONS = 8;
const SECTION_KEYS = ["tech", "business", "world", "opinion", "sports"];

const FORCE = process.env.FORCE === "true";

function easternNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|mod$|ref$|rref$|smid$|smtyp$)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.protocol}//${url.host.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

function buildPrompt(today, previous) {
  const avoid = previous
    ? `\nYesterday's edition (${previous.date}) ran these headlines. Don't repeat them unless there is a major new development:\n${[
        previous.lead?.headline,
        ...SECTION_KEYS.flatMap((k) => (previous.sections?.[k] || []).map((s) => s.headline)),
      ].filter(Boolean).map((h) => `- ${h}`).join("\n")}\n`
    : "";

  return `Today is ${today} (U.S. Eastern time). You are the editor of "Noah's Daily Dispatch", a personal morning newspaper. Use web search to report the biggest news of roughly the last 24 hours.

Sections:
- tech: technology and A.I.
- business: business, companies and markets
- world: world affairs and geopolitics
- opinion: 3-4 notable opinion pieces from the last 1-2 days, from respected opinion sections. Use at most one piece per outlet and one per author. Every piece needs the author's real name (or "The Editorial Board" for an unsigned editorial). If you can't find the name, pick a different piece; placeholders like "contributor" are removed. Columns are often republished under different headlines, so make sure the pieces are by different people and make different arguments. Prefer pieces about the day's big stories. Search these opinion sections: Bloomberg Opinion, Washington Post Opinions, The Free Press, Foreign Affairs, Foreign Policy, The Hill (Opinion), Fortune, Time, CNN Opinion, and Fox News Opinion. Run separate searches such as "Bloomberg Opinion" plus a topic of the day, or "op-ed" plus a topic, until you have 3-4 pieces with real links. The opinion section must not be empty.
- sports: the biggest results and stories in U.S. and global sports

Your searches only return pages from these approved sites, and stories linking anywhere else are removed before printing: ${Object.keys(ALLOWED_SOURCES).filter((d) => !UNSEARCHABLE.has(d)).join(", ")}.
Link to the outlet's own page. A local station or portal republishing a Reuters or AP story doesn't count; find the story on reuters.com or apnews.com instead. Never cite company press releases or company blogs; cite a news outlet's report of the announcement.
Use only articles published in the last 2 days (opinion: last 3 days). Older links are removed.

Search plan: you have about 30 searches. Do the opinion section FIRST: spend your first 6-8 searches finding 3-4 opinion pieces, before any news searches, so it can't be crowded out. Then spend roughly 4-5 searches on each news section. Before you write the edition, count the stories in every section. If any section has fewer than 3 stories, search again for that section.

Rules:
- Every url must be a specific article page that appeared in your search results. Never guess or construct a URL. Links without a matching search result are removed before printing.
- For game results, give only final scores you confirmed in a search result. If a game was still in progress, say so rather than guessing.
- The lead is the single biggest news story of the day, from any section, and must not also appear in a section.
- Every news section (tech, business, world, sports) must have exactly 3 stories. Every news story in the whole edition, including the lead, must be about a different event. Two outlets covering the same deal, earnings report, market move, announcement or game count as one story, even if one is in Tech and the other in Business: keep it in the one section where it fits best and find a different story for the other. Use 3-4 opinion pieces.
- Before you write the edition, read through all the news headlines together and replace any story that repeats an event already covered.
- Write headlines in newspaper title case.
- News summaries are 2-3 plain, neutral, factual sentences. The lead summary is 4-6 sentences. The lead deck is a one-sentence subheading.
- Opinion summaries describe the author's argument neutrally ("Smith argues that..."). Base them only on what you actually read. Never invent claims, quotes or authors.
${avoid}
When you are done researching, reply with only the edition as JSON inside <edition></edition> tags, in exactly this shape:
<edition>
{"lead": {"kicker": "Section name", "headline": "...", "deck": "...", "summary": "...", "source": "Outlet", "url": "https://..."},
 "sections": {
   "tech": [{"headline": "...", "summary": "...", "source": "Outlet", "url": "https://..."}],
   "business": [...], "world": [...],
   "opinion": [{"headline": "...", "author": "Name or The Editorial Board", "summary": "...", "source": "Outlet", "url": "https://..."}],
   "sports": [...]
 }}
</edition>`;
}

async function research(client, prompt) {
  const messages = [{ role: "user", content: prompt }];
  const seenUrls = new Set();
  let response;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
  // Search only approved outlets, so no search is spent on results that would be dropped.
  const searchTool = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: MAX_SEARCHES,
    allowed_domains: Object.keys(ALLOWED_SOURCES).filter((d) => !UNSEARCHABLE.has(d)),
  };

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    try {
      response = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: EFFORT },
          tools: [searchTool],
          messages,
        })
        .finalMessage();
    } catch (err) {
      // If the search filter itself is rejected, print the paper with unrestricted search
      // rather than skip the day; the approved-outlet check below still applies.
      if (turn === 0 && searchTool.allowed_domains && err instanceof Anthropic.BadRequestError) {
        console.warn(`Search filter rejected (${err.message}); retrying without it.`);
        delete searchTool.allowed_domains;
        turn--;
        continue;
      }
      throw err;
    }

    for (const block of response.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const result of block.content) {
          const n = result.url && normalizeUrl(result.url);
          if (n) seenUrls.add(n);
        }
      }
    }
    const u = response.usage ?? {};
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.searches += u.server_tool_use?.web_search_requests ?? 0;
    console.log(`turn ${turn + 1}: stop_reason=${response.stop_reason}, model=${response.model}, searched URLs so far=${seenUrls.size}`);

    if (response.stop_reason === "refusal") {
      throw new Error(`Request was declined: ${JSON.stringify(response.stop_details)}`);
    }
    if (response.stop_reason !== "pause_turn") break;
    // Resume the paused server-side search loop: send the partial turn back as-is.
    messages.push({ role: "assistant", content: response.content });
  }

  if (response.stop_reason === "pause_turn") throw new Error("Research did not finish within the continuation limit.");
  if (response.stop_reason === "max_tokens") throw new Error("Response hit max_tokens before the edition was finished.");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/<edition>([\s\S]*?)<\/edition>/);
  if (!match) throw new Error(`No <edition> block in the response:\n${text.slice(-2000)}`);
  const cost = usage.input * PRICE.input + usage.output * PRICE.output + usage.cacheRead * PRICE.cacheRead
    + usage.cacheWrite * PRICE.cacheWrite + usage.searches * PRICE.search;
  console.log(`usage: ${usage.input} input, ${usage.cacheRead} cache-read, ${usage.cacheWrite} cache-write, ${usage.output} output tokens, ${usage.searches} searches; estimated cost $${cost.toFixed(2)}`);
  return { draft: JSON.parse(match[1]), seenUrls };
}

// The only sites the paper prints from, with the name to credit. Subdomains
// count (edition.cnn.com matches "cnn.com"). Anything else is dropped, which
// also keeps out press releases, investing blogs and sites that merely
// republish wire copy.
const ALLOWED_SOURCES = {
  // Wires and national news
  "reuters.com": "Reuters", "apnews.com": "AP", "bloomberg.com": "Bloomberg", "wsj.com": "The Wall Street Journal",
  "nytimes.com": "The New York Times", "washingtonpost.com": "The Washington Post", "ft.com": "Financial Times",
  "economist.com": "The Economist", "bbc.com": "BBC", "bbc.co.uk": "BBC", "npr.org": "NPR", "pbs.org": "PBS",
  "cnbc.com": "CNBC", "axios.com": "Axios", "politico.com": "Politico", "politico.eu": "Politico Europe",
  "semafor.com": "Semafor", "cnn.com": "CNN", "cbsnews.com": "CBS News", "nbcnews.com": "NBC News",
  "abcnews.go.com": "ABC News", "abcnews.com": "ABC News", "foxnews.com": "Fox News", "foxbusiness.com": "Fox Business",
  "usatoday.com": "USA Today", "latimes.com": "Los Angeles Times", "time.com": "Time", "theguardian.com": "The Guardian",
  "aljazeera.com": "Al Jazeera", "dw.com": "DW", "france24.com": "France 24", "asia.nikkei.com": "Nikkei Asia",
  "scmp.com": "South China Morning Post", "marketwatch.com": "MarketWatch", "barrons.com": "Barron's",
  "fortune.com": "Fortune", "businessinsider.com": "Business Insider", "finance.yahoo.com": "Yahoo Finance",
  // Tech
  "theverge.com": "The Verge", "techcrunch.com": "TechCrunch", "wired.com": "Wired", "arstechnica.com": "Ars Technica",
  "theinformation.com": "The Information", "technologyreview.com": "MIT Technology Review", "statnews.com": "STAT",
  // Opinion and analysis
  "theatlantic.com": "The Atlantic", "newyorker.com": "The New Yorker", "foreignaffairs.com": "Foreign Affairs",
  "foreignpolicy.com": "Foreign Policy", "thefp.com": "The Free Press", "thehill.com": "The Hill",
  // Sports
  "espn.com": "ESPN", "theathletic.com": "The Athletic", "cbssports.com": "CBS Sports", "nbcsports.com": "NBC Sports",
  "si.com": "Sports Illustrated", "sports.yahoo.com": "Yahoo Sports", "mlb.com": "MLB.com", "nba.com": "NBA.com",
  "nfl.com": "NFL.com", "nhl.com": "NHL.com", "wnba.com": "WNBA.com",
};

// Sites that block Anthropic's search crawler. Naming them in the search filter
// makes the request fail, and searches can't return their pages anyway.
const UNSEARCHABLE = new Set([
  "nytimes.com", "wsj.com", "theatlantic.com", "ft.com", "economist.com", "theguardian.com",
  // Reported by the API on 2026-10-31.
  "apnews.com", "arstechnica.com", "barrons.com", "bbc.co.uk", "bbc.com", "businessinsider.com", "dw.com",
  "latimes.com", "marketwatch.com", "newyorker.com", "politico.com", "politico.eu", "reuters.com",
  "theathletic.com", "theverge.com", "usatoday.com", "wired.com",
]);

// Links older than this many days (going by the date in the link) are dropped.
const MAX_AGE_DAYS = { news: 2, opinion: 3 };

function allowedSourceName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const match = Object.keys(ALLOWED_SOURCES).find((d) => host === d || host.endsWith(`.${d}`));
    return match ? ALLOWED_SOURCES[match] : null;
  } catch {
    return null;
  }
}

// Most news links carry their publication date, as /2026/10/30/ or 2026-10-30.
function daysOld(url, today) {
  const m = url.match(/(20\d{2})[\/-](\d{2})[\/-](\d{2})(?:\D|$)/);
  if (!m) return null;
  const published = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const [y, mo, d] = today.split("-").map(Number);
  return Math.round((Date.UTC(y, mo - 1, d) - published) / 86400000);
}

// A placeholder like "Fox News contributor (name not confirmed)" isn't a byline.
function isRealAuthor(name) {
  return Boolean(name) && !/not confirmed|unknown|contributor|staff|n\/a|unnamed|anonymous/i.test(name);
}

function cleanStory(story, seenUrls, { withAuthor = false, label, today, maxAgeDays }) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const out = { headline: str(story?.headline), summary: str(story?.summary), source: str(story?.source), url: str(story?.url) };
  if (withAuthor) out.author = str(story?.author);
  if (!out.headline || !out.summary || !/^https:\/\//.test(out.url)) {
    console.warn(`dropped ${label}: missing fields`);
    return null;
  }
  const outlet = allowedSourceName(out.url);
  if (!outlet) {
    console.warn(`dropped ${label}: not an approved outlet (${out.url})`);
    return null;
  }
  // Credit the site the link actually goes to, keeping a more specific label like "Bloomberg Opinion".
  if (!out.source.toLowerCase().includes(outlet.toLowerCase().replace(/^the /, ""))) out.source = outlet;
  if (withAuthor && !isRealAuthor(out.author)) {
    console.warn(`dropped ${label}: no real author name ("${out.author}")`);
    return null;
  }
  const age = daysOld(out.url, today);
  if (age !== null && age > maxAgeDays) {
    console.warn(`dropped ${label}: ${age} days old (${out.url})`);
    return null;
  }
  if (!seenUrls.has(normalizeUrl(out.url))) {
    console.warn(`dropped ${label}: link never appeared in a search result (${out.url})`);
    return null;
  }
  return out;
}

function assemble(draft, seenUrls, today, number) {
  const lead = cleanStory(draft.lead, seenUrls, { label: "lead", today, maxAgeDays: MAX_AGE_DAYS.news });
  if (!lead) throw new Error("The lead story failed validation; not printing a front page without a lead.");
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const edition = {
    date: today,
    number,
    lead: { kicker: str(draft.lead.kicker) || "Top Story", ...lead, ...(str(draft.lead.deck) ? { deck: str(draft.lead.deck) } : {}) },
    sections: {},
  };
  const usedUrls = new Set([normalizeUrl(lead.url)]);
  const usedAuthors = new Set();
  for (const key of SECTION_KEYS) {
    const stories = (Array.isArray(draft.sections?.[key]) ? draft.sections[key] : [])
      .map((s, i) => cleanStory(s, seenUrls, {
        withAuthor: key === "opinion", label: `${key}[${i}]`, today,
        maxAgeDays: key === "opinion" ? MAX_AGE_DAYS.opinion : MAX_AGE_DAYS.news,
      }))
      .filter((s, i) => {
        if (!s) return false;
        const url = normalizeUrl(s.url);
        if (usedUrls.has(url)) {
          console.warn(`dropped ${key}[${i}]: same link already in this edition`);
          return false;
        }
        const author = key === "opinion" && s.author ? s.author.toLowerCase() : null;
        if (author && author !== "the editorial board" && usedAuthors.has(author)) {
          console.warn(`dropped ${key}[${i}]: second piece by ${s.author}`);
          return false;
        }
        usedUrls.add(url);
        if (author) usedAuthors.add(author);
        return true;
      })
      .slice(0, 4);
    const drafted = Array.isArray(draft.sections?.[key]) ? draft.sections[key].length : 0;
    console.log(`section "${key}": ${stories.length} of ${drafted} drafted stories kept`);
    if (stories.length) edition.sections[key] = stories;
  }
  return edition;
}

// Drops news stories that cover the same event as an earlier story anywhere in
// the edition (say, one sell-off in both Tech and Business). Word matching
// can't tell "the same event" from "the same country", so a short Claude call
// reads the headlines and summaries and names the repeats. Opinion is left out:
// commenting on the day's news is its job. If the check itself fails, the
// edition prints without it.
async function dropRepeatedEvents(client, edition) {
  const items = [{ id: "lead", section: "lead", story: edition.lead }];
  for (const key of SECTION_KEYS) {
    if (key === "opinion") continue;
    (edition.sections[key] || []).forEach((story, i) => items.push({ id: `${key}-${i}`, section: key, story }));
  }
  const list = items.map((it) => `[${it.id}] ${it.story.headline}\n${it.story.summary}`).join("\n\n");

  let repeats;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              repeats: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, same_event_as: { type: "string" } },
                  required: ["id", "same_event_as"],
                  additionalProperties: false,
                },
              },
            },
            required: ["repeats"],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: "user",
        content: `These are the news stories in today's edition of a newspaper, in order. Find every story that reports the same event as an EARLIER story in the list: the same earnings report, deal, announcement, market move, incident or game, even if the headlines are worded differently or one story also mentions other companies. Stories that merely involve the same country, person or industry but report different events are not repeats.\n\nFor each repeat, give its id and the id of the earlier story it repeats. Return an empty list if there are none.\n\n${list}`,
      }],
    });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    repeats = JSON.parse(text).repeats;
  } catch (err) {
    console.warn(`Repeat check skipped: ${err.message}`);
    return;
  }

  const ids = new Set(items.map((it) => it.id));
  const drop = new Set(repeats.filter((r) => r.id !== "lead" && ids.has(r.id)).map((r) => r.id));
  for (const it of items) {
    if (!drop.has(it.id)) continue;
    const earlier = repeats.find((r) => r.id === it.id).same_event_as;
    console.warn(`dropped ${it.id}: same event as ${earlier} ("${it.story.headline}")`);
  }
  for (const key of SECTION_KEYS) {
    if (!edition.sections[key] || key === "opinion") continue;
    edition.sections[key] = edition.sections[key].filter((_, i) => !drop.has(`${key}-${i}`));
    if (!edition.sections[key].length) delete edition.sections[key];
  }
}

async function main() {
  const { date: today, hour } = easternNow();
  const index = await readJSON(INDEX_PATH, []);
  const existing = index.find((e) => e.date === today);

  if (!FORCE && hour < EARLIEST_HOUR) {
    console.log(`It's ${hour}:00 in New York; the paper prints at ${EARLIEST_HOUR} a.m. Skipping.`);
    return;
  }
  if (!FORCE && existing) {
    console.log(`Edition for ${today} already printed. Skipping (run with FORCE=true to reprint).`);
    return;
  }

  const previousEntry = index.filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const previous = previousEntry ? await readJSON(path.join(EDITIONS_DIR, `${previousEntry.date}.json`), null) : null;
  const number = existing?.number ?? (previousEntry ? previousEntry.number + 1 : 1);

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it under the repo's Settings → Secrets and variables → Actions.");
  }
  const client = new Anthropic();
  const { draft, seenUrls } = await research(client, buildPrompt(today, previous));
  const edition = assemble(draft, seenUrls, today, number);
  await dropRepeatedEvents(client, edition);
  const total = Object.values(edition.sections).reduce((a, s) => a + s.length, 0);
  if (total < 6) throw new Error(`Only ${total} section stories survived validation; not printing.`);

  await fs.mkdir(EDITIONS_DIR, { recursive: true });
  await fs.writeFile(path.join(EDITIONS_DIR, `${today}.json`), JSON.stringify(edition, null, 2) + "\n");

  const entry = {
    date: today,
    number,
    headline: edition.lead.headline,
    stories: 1 + Object.values(edition.sections).reduce((a, s) => a + s.length, 0),
  };
  const nextIndex = [entry, ...index.filter((e) => e.date !== today)].sort((a, b) => b.date.localeCompare(a.date));
  await fs.writeFile(INDEX_PATH, JSON.stringify(nextIndex, null, 2) + "\n");

  console.log(`Printed No. ${number} for ${today}: ${edition.lead.headline}`);
}

main().catch((err) => {
  // API errors carry the status code and server message; print them plainly so the Actions log shows the cause.
  if (err instanceof Anthropic.APIError) console.error(`Claude API error ${err.status}: ${err.message}`);
  else console.error(err);
  process.exit(1);
});
