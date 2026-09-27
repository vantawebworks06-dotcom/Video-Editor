/**
 * A prior on how much weight a source deserves in ranking — not a verdict on any claim. Wire
 * services, public broadcasters and newspapers of record rank above aggregators, tabloids and
 * anonymous uploads. Deliberately worldwide and generic.
 */
import { hostOf } from "./http";

const WIRE_AND_RECORD = [
  "reuters.com", "apnews.com", "afp.com", "bbc.co.uk", "bbc.com", "npr.org", "pbs.org", "nytimes.com", "washingtonpost.com", "wsj.com",
  "theguardian.com", "ft.com", "economist.com", "bloomberg.com", "latimes.com", "cbc.ca", "abc.net.au", "aljazeera.com", "dw.com",
  "france24.com", "lemonde.fr", "spiegel.de", "elpais.com", "nhk.or.jp", "scmp.com", "thehindu.com", "irishtimes.com", "independent.co.uk",
  "telegraph.co.uk", "time.com", "theatlantic.com", "newyorker.com", "politico.com", "axios.com", "cnn.com", "nbcnews.com", "cbsnews.com",
  "abcnews.go.com", "usatoday.com", "jamaica-gleaner.com", "jamaicaobserver.com", "nature.com", "science.org", "sciencedaily.com",
];
const REFERENCE = ["wikipedia.org", "britannica.com", "loc.gov", "archives.gov", "nationalarchives.gov.uk", "europeana.eu", "archive.org", "wikimedia.org"];
const ENTERTAINMENT_NEWS = ["tmz.com", "billboard.com", "rollingstone.com", "variety.com", "hollywoodreporter.com", "vibe.com", "complex.com", "pitchfork.com", "people.com", "eonline.com", "xxlmag.com", "espn.com", "skysports.com", "theverge.com", "techcrunch.com", "wired.com", "arstechnica.com"];
const LOW = ["dailymail.co.uk", "thesun.co.uk", "nypost.com", "mirror.co.uk", "express.co.uk", "buzzfeed.com", "medium.com", "blogspot.com", "wordpress.com", "substack.com", "quora.com", "pinterest.com"];

export function domainCredibility(url: string | null): { score: number; label: string } {
  const host = url ? hostOf(url) : null;
  if (!host) return { score: 0.4, label: "unknown source" };
  const is = (list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));
  if (/\.(gov|mil)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|\.gouv\.fr$/.test(host)) return { score: 0.9, label: "government source" };
  if (/\.(edu|ac\.[a-z]{2})$/.test(host)) return { score: 0.85, label: "academic source" };
  if (is(WIRE_AND_RECORD)) return { score: 0.85, label: `established news outlet (${host})` };
  if (is(REFERENCE)) return { score: 0.7, label: `reference/archive (${host})` };
  if (is(ENTERTAINMENT_NEWS)) return { score: 0.6, label: `specialist/entertainment outlet (${host})` };
  if (is(LOW)) return { score: 0.35, label: `tabloid/self-published platform (${host})` };
  return { score: 0.5, label: host };
}

/** YouTube/X accounts: official or news accounts rank above re-uploads. Heuristic, from the name only. */
export function accountCredibility(account: string | null, entities: string[]): { score: number; label: string } {
  if (!account) return { score: 0.4, label: "unknown account" };
  const a = account.toLowerCase();
  if (entities.some((e) => e.length > 3 && a.includes(e.toLowerCase()))) return { score: 0.8, label: `account named after ${entities.find((e) => a.includes(e.toLowerCase()))}` };
  if (/\b(news|tv|television|broadcast|network|times|post|herald|gleaner|observer|bbc|cnn|nbc|abc|cbs|fox|sky|reuters|associated press|ap|pbs|npr|official|vevo|records|recordings)\b/.test(a)) return { score: 0.7, label: `news/official-looking account (${account})` };
  if (/\b(clips?|compilations?|reacts?|reaction|fan|fans|tribute|lyrics|edits?|shorts|4k|hd|remix)\b/.test(a)) return { score: 0.35, label: `re-upload/fan account (${account})` };
  return { score: 0.5, label: account };
}
