// Prints the day's edition of Noah's Daily Dispatch.
//
// Researches each section in its own Claude call (with web search), keeps only
// stories whose links came back from a search and pass the source, date and
// byline checks, re-researches any section that comes up short, drops stories
// that repeat an event, and picks the biggest story as the lead. Writes
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
// Sonnet 5.5 list prices, for the cost estimate in the log (USD).
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 2.5 / 1e6, search: 10 / 1000 };
const MAX_CONTINUATIONS = 8;

// News is researched in one call with a large search budget, opinion in a
// second, so neither can use up the other's searches. (One call per section, tried
// on 2026-11-02, gave each call too few searches: the tool also counts its own
// result processing against the limit, so sections ran dry after a search or two.)
const SECTIONS = {
  world: { name: "World Affairs", brief: "world affairs and geopolitics: wars, diplomacy, elections and major events outside business and tech", keep: 3 },
  business: { name: "Business & Markets", brief: "business, companies, the economy and markets", keep: 3 },
  tech: { name: "Technology & A.I.", brief: "technology and A.I.: companies, products, research and policy", keep: 3 },
  sports: { name: "Sports", brief: "sports, focused on Boston teams (Celtics, Red Sox, Patriots, Bruins). Favor analysis over box scores: power rankings, trade and free-agency analysis, injury news and columns about where the teams stand. Include a final score only for a big game, such as a Boston win or loss that matters, a rivalry game or the playoffs. Fill any spot Boston can't with the biggest national sports story", keep: 3 },
  opinion: { name: "Opinion", keep: 4 },
};
const SEARCHES = { news: 40, opinion: 20, retry: 15 };
const SECTION_KEYS = ["tech", "business", "world", "opinion", "sports"]; // print order
const NEWS_KEYS = ["world", "business", "tech", "sports"];
const MIN_SECTION = 2;     // re-research sections that end up with fewer stories than this
const MIN_TO_PRINT = 4;    // section stories needed (besides the lead) to print at all

const FORCE = process.env.FORCE === "true";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };

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

function addUsage(u = {}) {
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.cacheRead += u.cache_read_input_tokens ?? 0;
  usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  usage.searches += u.server_tool_use?.web_search_requests ?? 0;
}

const COMMON_RULES = () => `Only stories from these approved sites are printed; links anywhere else are removed: ${Object.keys(ALLOWED_SOURCES).filter((d) => !UNSEARCHABLE.has(d)).join(", ")}. Search the open web as usual, but when a result is from another site (including Reuters, AP or the BBC, whose pages can't be printed), find the same news on one of the approved sites and link to that.
Every url must be a specific article page that appeared in your search results, never a section front page, index or live-updates hub, and never a press release or company blog. Never guess or construct a URL.
The newspaper's own checks verify each story's site, date and link and quietly remove any that fail, so don't hold back a story because you're unsure about one of them, and never return an empty list.`;

// `keys` is the news sections to research (all of them, or just the short ones on a retry).
function buildNewsPrompt(today, keys, avoid, searches, { retry = false } = {}) {
  const avoidList = avoid.length
    ? `\nThese stories are already covered (yesterday's paper or earlier in today's). Don't repeat their events unless there is a major new development:\n${avoid.map((h) => `- ${h}`).join("\n")}\n`
    : "";
  return `Today is ${today} (U.S. Eastern time). You are the news editor of "Noah's Daily Dispatch", a personal morning newspaper. You have about ${searches} web searches.${retry ? " An earlier pass came up short on these sections, so search more widely." : ""}

Find the biggest news of roughly the last 24 hours for these sections, 5 stories each:
${keys.map((k) => `- ${k}: ${SECTIONS[k].brief}`).join("\n")}

Split your searches across all ${keys.length} section${keys.length > 1 ? "s" : ""} so none comes up empty. Every story in the edition must be about a different event: two articles about the same deal, earnings report, day's market move, announcement or game count as one story, even across sections.
${COMMON_RULES()}
Use only articles published in the last 3 days. When you give a game's final score, it must be one you confirmed in a search result.
${avoidList}
Write headlines in newspaper title case. Summaries are 2-3 plain, neutral, factual sentences.

When you are done, reply with only a JSON object inside <stories></stories> tags, with one list per section:
<stories>
{${keys.map((k) => `"${k}": [{"headline": "...", "summary": "...", "source": "Outlet", "url": "https://...", "importance": 7}]`).join(", ")}}
</stories>
"importance" is 1-10: how big the story is for a general reader today (10 = the day's top story anywhere). The biggest one becomes the front-page lead.`;
}

function buildOpinionPrompt(today, avoid, searches, { retry = false } = {}) {
  const avoidList = avoid.length ? `\nAlready chosen, so pick different pieces and authors:\n${avoid.map((h) => `- ${h}`).join("\n")}\n` : "";
  return `Today is ${today} (U.S. Eastern time). You are the opinion editor of "Noah's Daily Dispatch", a personal morning newspaper. You have about ${searches} web searches.${retry ? " An earlier pass came up short, so search more widely." : ""}

Find 4 notable opinion pieces published in the last 1-3 days, from respected opinion sections such as Bloomberg Opinion, Washington Post Opinions, The Free Press, Foreign Affairs, Foreign Policy, The Hill (Opinion), Fortune, Time, CNN Opinion and Fox News Opinion. Use at most one piece per outlet and one per author, and prefer pieces about the day's big stories. Every piece needs the author's real name (or "The Editorial Board" for an unsigned editorial); if you can't find the name, pick a different piece. Columns are often republished under different headlines, so make sure the pieces are by different people and make different arguments.
${COMMON_RULES()}
${avoidList}
Write headlines in newspaper title case. Summaries describe the author's argument neutrally in 2-3 sentences ("Smith argues that..."), based only on what you actually read. Never invent claims, quotes or authors.

When you are done, reply with only a JSON object inside <stories></stories> tags:
<stories>
{"opinion": [{"headline": "...", "author": "Name", "summary": "...", "source": "Outlet", "url": "https://..."}]}
</stories>`;
}

// One Claude call with web search. Returns the parsed {section: stories} object
// and every URL its searches returned.
//
// `basic` uses the plain search tool, which returns results directly. The newer
// one (web_search_20260209) hands results over as data for Claude to process in
// code, and that processing counts against the search limit: on 2026-11-05 the
// opinion call ran out of searches before reading a single piece.
async function research(client, prompt, maxSearches, { basic = false } = {}) {
  const messages = [{ role: "user", content: prompt }];
  const seenUrls = new Set();
  // Search is left unrestricted: limiting it to approved sites (allowed_domains)
  // was tried on 2026-11-01 and found almost no recent news, because the big wires
  // block Anthropic's search crawler. cleanStory drops anything off the list instead.
  const searchTool = { type: basic ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: maxSearches };
  let response;

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    try {
      response = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: EFFORT },
          tools: [searchTool],
          messages,
        })
        .finalMessage();
    } catch (err) {
      // If the plain search tool is refused for this model, use the newer one rather than lose the section.
      if (turn === 0 && searchTool.type === "web_search_20250305" && err instanceof Anthropic.BadRequestError) {
        console.warn(`Plain search tool refused (${err.message}); using web_search_20260209.`);
        searchTool.type = "web_search_20260209";
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
    addUsage(response.usage);
    if (response.stop_reason === "refusal") throw new Error(`declined: ${JSON.stringify(response.stop_details)}`);
    if (response.stop_reason !== "pause_turn") break;
    // Resume the paused server-side search loop: send the partial turn back as-is.
    messages.push({ role: "assistant", content: response.content });
  }
  if (response.stop_reason === "pause_turn") throw new Error("research did not finish within the continuation limit");
  if (response.stop_reason === "max_tokens") throw new Error("hit max_tokens before finishing");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/<stories>([\s\S]*?)<\/stories>/);
  if (!match) throw new Error(`no <stories> block: ${text.slice(-500)}`);
  const stories = JSON.parse(match[1]);
  if (!stories || typeof stories !== "object" || Array.isArray(stories)) throw new Error("<stories> is not an object of sections");
  // Whatever Claude wrote outside the tags; logged when a section comes back empty.
  const note = text.replace(match[0], "").trim();
  return { stories, seenUrls, note };
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
  // Boston sports
  "bostonglobe.com": "The Boston Globe", "boston.com": "Boston.com", "nbcsportsboston.com": "NBC Sports Boston",
  "masslive.com": "MassLive",
};

// Sites that block Anthropic's search crawler: their pages never come back from
// a search, so their links can never pass the search-result check.
const UNSEARCHABLE = new Set([
  "nytimes.com", "wsj.com", "theatlantic.com", "ft.com", "economist.com", "theguardian.com",
  // Reported by the API on 2026-10-31.
  "apnews.com", "arstechnica.com", "barrons.com", "bbc.co.uk", "bbc.com", "businessinsider.com", "dw.com",
  "latimes.com", "marketwatch.com", "newyorker.com", "politico.com", "politico.eu", "reuters.com",
  "theathletic.com", "theverge.com", "usatoday.com", "wired.com",
]);

// Links older than this many days (going by the date in the link) are dropped.
const MAX_AGE_DAYS = { news: 3, opinion: 3 };

function allowedSourceName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const match = Object.keys(ALLOWED_SOURCES).find((d) => host === d || host.endsWith(`.${d}`));
    return match ? ALLOWED_SOURCES[match] : null;
  } catch {
    return null;
  }
}

// Most news links carry their publication date, as /2026/10/30/, 2026-10-30 or,
// at France 24 and others, run together as 20261030.
function daysOld(url, today) {
  const [y, mo, d] = today.split("-").map(Number);
  const candidates = [
    url.match(/(20\d{2})[\/-](\d{2})[\/-](\d{2})(?:\D|$)/),
    url.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/),
  ];
  for (const m of candidates) {
    if (!m) continue;
    const [year, month, day] = [+m[1], +m[2], +m[3]];
    // Skip digit runs that only look like dates (ids, version numbers).
    if (Math.abs(year - y) > 1 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(year, month - 1, day)) / 86400000);
  }
  return null;
}

// A placeholder like "Fox News contributor (name not confirmed)" isn't a byline.
function isRealAuthor(name) {
  return Boolean(name) && !/not confirmed|unknown|contributor|staff|n\/a|unnamed|anonymous/i.test(name);
}

// Article links carry a slug or an id (/2026/11/03/..., /fed-holds-rates, /gameId/4019...).
// A path with neither, like cnbc.com/mergers/ or washingtonpost.com/opinions/columns/,
// is a section front page.
// Checks a headline against the words in its link. Most article links carry a
// slug written from the publisher's own headline, so a headline that moves the
// opposite way from its slug (oil "falls" vs. "oil-prices-climb-after...") was
// written from a different article or version than the one linked. Only a clear
// contradiction counts: publishers often word slugs differently from headlines,
// and live blogs and roundups have generic slugs, so missing words prove nothing.
const UP = /^(climb|climbs|climbed|rise|rises|rose|risen|rising|jump|jumps|jumped|surge|surges|surged|soar|soars|soared|gain|gains|gained|rally|rallies|rallied|rebound|rebounds|rebounded|higher)$/;
const DOWN = /^(fall|falls|fell|fallen|falling|drop|drops|dropped|slide|slides|slid|sink|sinks|sank|tumble|tumbles|tumbled|plunge|plunges|plunged|decline|declines|declined|slump|slumps|slumped|lower|dip|dips|dipped)$/;

const words = (text) => text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

// The slug is the path segment with the most real words; ids, dates and hashes
// (like 30f401a6-d321-11f1-..._story) have none.
function slugWords(url) {
  try {
    const realWords = (seg) => words(seg.replace(/\.[a-z]+$/, "")).filter((w) => /^[a-z]{2,}$/.test(w));
    return new URL(url).pathname.split("/").map(realWords).sort((a, b) => b.length - a.length)[0] || [];
  } catch {
    return [];
  }
}

// Returns why the headline contradicts its link, or null.
function headlineMismatch(headline, url) {
  const slug = slugWords(url);
  if (slug.length < 3) return null;
  const head = words(headline);
  const dir = (ws) => ({ up: ws.some((w) => UP.test(w)), down: ws.some((w) => DOWN.test(w)) });
  const h = dir(head), s = dir(slug);
  if ((h.down && !h.up && s.up && !s.down) || (h.up && !h.down && s.down && !s.up)) {
    return `headline says ${h.up ? "up" : "down"} but its link says ${s.up ? "up" : "down"}`;
  }
  return null;
}

function isFrontPage(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return !segments.some((seg) => /[-_\d]/.test(seg));
  } catch {
    return true;
  }
}

function cleanStory(story, seenUrls, { withAuthor = false, label, today, maxAgeDays }) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const out = { headline: str(story?.headline), summary: str(story?.summary), source: str(story?.source), url: str(story?.url) };
  if (withAuthor) out.author = str(story?.author);
  if (!out.headline || !out.summary || !/^https:\/\//.test(out.url)) {
    console.warn(`dropped ${label}: missing fields`);
    return null;
  }
  const mismatch = headlineMismatch(out.headline, out.url);
  if (mismatch) {
    console.warn(`dropped ${label}: ${mismatch} ("${out.headline}", ${out.url})`);
    return null;
  }
  if (isFrontPage(out.url)) {
    console.warn(`dropped ${label}: a section front page, not an article (${out.url})`);
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


// Validates one section's drafted stories against the shared state of the
// edition (links and opinion authors already used).
function cleanSection(key, drafted, seenUrls, today, used) {
  const opinion = key === "opinion";
  const kept = [];
  drafted.forEach((s, i) => {
    const story = cleanStory(s, seenUrls, {
      withAuthor: opinion, label: `${key}[${i}]`, today,
      maxAgeDays: opinion ? MAX_AGE_DAYS.opinion : MAX_AGE_DAYS.news,
    });
    if (!story) return;
    const url = normalizeUrl(story.url);
    if (used.printed.has(url)) {
      console.warn(`dropped ${key}[${i}]: already ran in a recent edition (${story.url})`);
      return;
    }
    if (used.urls.has(url)) {
      console.warn(`dropped ${key}[${i}]: same link already in this edition`);
      return;
    }
    const author = opinion ? story.author.toLowerCase() : null;
    if (author && author !== "the editorial board" && used.authors.has(author)) {
      console.warn(`dropped ${key}[${i}]: second piece by ${story.author}`);
      return;
    }
    if (!opinion) story.importance = Number(s.importance) || 0;
    used.urls.add(url);
    if (author) used.authors.add(author);
    kept.push(story);
  });
  return kept;
}

// Runs one research call and validates what comes back, section by section. A
// failed call (an API error, a missing or malformed reply) leaves its sections
// empty instead of stopping the paper.
async function researchAndClean(client, label, keys, prompt, maxSearches, today, used, { basic = false } = {}) {
  const result = Object.fromEntries(keys.map((k) => [k, []]));
  try {
    const { stories, seenUrls, note } = await research(client, prompt, maxSearches, { basic });
    for (const key of keys) {
      const drafted = Array.isArray(stories[key]) ? stories[key] : [];
      result[key] = cleanSection(key, drafted, seenUrls, today, used);
      console.log(`section "${key}"${label}: ${result[key].length} of ${drafted.length} drafted stories kept`);
    }
    console.log(`  (${seenUrls.size} links in search results)`);
    if (keys.some((k) => !(stories[k] || []).length)) console.warn(`  Claude's note: ${note.slice(-600) || "(none)"}`);
  } catch (err) {
    const msg = err instanceof Anthropic.APIError ? `Claude API error ${err.status}: ${err.message}` : err.message;
    console.warn(`research for ${keys.join(", ")}${label} failed: ${msg}`);
  }
  return result;
}

// Drops news stories that cover the same event as an earlier story anywhere in
// the edition (say, one sell-off in both Tech and Business). Word matching
// can't tell "the same event" from "the same country", so a short Claude call
// reads the headlines and summaries and names the repeats. Opinion is left out:
// commenting on the day's news is its job. If the check itself fails, the
// edition prints without it.
//
// When `onlyThese` is given (stories added by a retry), only those stories can be
// dropped, so a second check never removes a story the first one already kept.
async function dropRepeatedEvents(client, sections, onlyThese = null) {
  const items = [];
  for (const key of NEWS_KEYS) (sections[key] || []).forEach((story, i) => items.push({ id: `${key}-${i}`, story }));
  if (items.length < 2) return;
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
        content: `These are the news stories in today's edition of a newspaper, in order. Find every story that reports the same event as an EARLIER story in the list: the same earnings report, deal, announcement, incident or game, or the same day's market move seen from a different angle (for example, one sell-off covered as an index drop and again as a company's share losses). Stories that merely involve the same country, person or industry but report different events are not repeats.\n\nFor each repeat, give its id and the id of the earlier story it repeats. Return an empty list if there are none.\n\n${list}`,
      }],
    });
    addUsage(response.usage);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    repeats = JSON.parse(text).repeats;
  } catch (err) {
    console.warn(`Repeat check skipped: ${err.message}`);
    return;
  }

  const ids = new Set(items.map((it) => it.id));
  const droppable = (id) => ids.has(id) && (!onlyThese || onlyThese.has(items.find((it) => it.id === id).story));
  const drop = new Set(repeats.filter((r) => droppable(r.id)).map((r) => r.id));
  for (const it of items) {
    if (!drop.has(it.id)) continue;
    const earlier = repeats.find((r) => r.id === it.id).same_event_as;
    console.warn(`dropped ${it.id}: same event as ${earlier} ("${it.story.headline}")`);
  }
  for (const key of NEWS_KEYS) {
    if (sections[key]) sections[key] = sections[key].filter((_, i) => !drop.has(`${key}-${i}`));
  }
}

const sectionTotal = (sections) => Object.values(sections).reduce((a, s) => a + s.length, 0);

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
  const yesterday = previous
    ? [previous.lead?.headline, ...Object.values(previous.sections || {}).flat().map((s) => s.headline)].filter(Boolean)
    : [];
  // Links printed in the last week, so a story can't run again under a new headline.
  const recent = index.filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const printed = new Set();
  for (const e of recent) {
    const ed = await readJSON(path.join(EDITIONS_DIR, `${e.date}.json`), null);
    if (ed) [ed.lead, ...Object.values(ed.sections || {}).flat()].forEach((s) => s?.url && printed.add(normalizeUrl(s.url)));
  }
  const used = { urls: new Set(), authors: new Set(), printed };
  const sections = {};
  const covered = () => NEWS_KEYS.flatMap((k) => (sections[k] || []).map((s) => s.headline));

  // 1. One call for all the news, one for opinion.
  Object.assign(sections, await researchAndClean(client, "", NEWS_KEYS,
    buildNewsPrompt(today, NEWS_KEYS, yesterday, SEARCHES.news), SEARCHES.news, today, used));
  Object.assign(sections, await researchAndClean(client, "", ["opinion"],
    buildOpinionPrompt(today, [], SEARCHES.opinion), SEARCHES.opinion, today, used, { basic: true }));
  await dropRepeatedEvents(client, sections);

  // 2. One more pass for any short sections.
  const added = new Set();
  const shortNews = NEWS_KEYS.filter((k) => sections[k].length < MIN_SECTION);
  if (shortNews.length) {
    const more = await researchAndClean(client, " (retry)", shortNews,
      buildNewsPrompt(today, shortNews, [...yesterday, ...covered()], SEARCHES.retry, { retry: true }), SEARCHES.retry, today, used);
    for (const key of shortNews) {
      more[key].forEach((s) => added.add(s));
      sections[key].push(...more[key]);
    }
    if (added.size) await dropRepeatedEvents(client, sections, added);
  }
  if (sections.opinion.length < MIN_SECTION) {
    const more = await researchAndClean(client, " (retry)", ["opinion"],
      buildOpinionPrompt(today, sections.opinion.map((s) => `${s.headline} (${s.author})`), SEARCHES.retry, { retry: true }), SEARCHES.retry, today, used, { basic: true });
    sections.opinion.push(...more.opinion);
  }

  // 3. The biggest news story becomes the lead; trim sections to size.
  const leadKey = NEWS_KEYS.filter((k) => sections[k].length)
    .sort((a, b) => Math.max(...sections[b].map((s) => s.importance)) - Math.max(...sections[a].map((s) => s.importance)))[0];
  if (!leadKey) throw new Error("No news story survived the checks; not printing.");
  sections[leadKey].sort((a, b) => b.importance - a.importance);
  const { importance: _, ...lead } = sections[leadKey].shift();
  const edition = { date: today, number, lead: { kicker: SECTIONS[leadKey].name, ...lead }, sections: {} };
  for (const key of SECTION_KEYS) {
    const stories = sections[key].slice(0, SECTIONS[key].keep).map(({ importance, ...s }) => s);
    if (stories.length) edition.sections[key] = stories;
  }

  const cost = usage.input * PRICE.input + usage.output * PRICE.output + usage.cacheRead * PRICE.cacheRead
    + usage.cacheWrite * PRICE.cacheWrite + usage.searches * PRICE.search;
  console.log(`usage: ${usage.input} input, ${usage.cacheRead} cache-read, ${usage.cacheWrite} cache-write, ${usage.output} output tokens, ${usage.searches} searches; estimated cost $${cost.toFixed(2)}`);
  console.log(`final: lead from ${leadKey}; ${SECTION_KEYS.map((k) => `${k} ${edition.sections[k]?.length ?? 0}`).join(", ")}`);

  const total = sectionTotal(edition.sections);
  if (total < MIN_TO_PRINT) throw new Error(`Only ${total} section stories besides the lead survived; not printing.`);

  await fs.mkdir(EDITIONS_DIR, { recursive: true });
  await fs.writeFile(path.join(EDITIONS_DIR, `${today}.json`), JSON.stringify(edition, null, 2) + "\n");
  const entry = { date: today, number, headline: edition.lead.headline, stories: 1 + total };
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
