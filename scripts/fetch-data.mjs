// Fetches upcoming launches (including live-stream links) from Launch Library 2 and writes
// data/launches.json, which the site reads instead of calling the API from every browser.
// Run by the GitHub Actions workflow every 10 minutes, and by start.bat locally.
// Needs Node 18+ (global fetch). No dependencies.

import { mkdir, writeFile } from "node:fs/promises";

const URL = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=40&mode=detailed&hide_recent_previous=true";
const OUT = new globalThis.URL("../data/launches.json", import.meta.url);

async function fetchWithRetry(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "ad-astra (GitHub Pages site)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`Attempt ${i} failed (${err.message}), retrying in ${i * 20}s…`);
      await new Promise((r) => setTimeout(r, i * 20000));
    }
  }
}

/** Repair text that was UTF-8 decoded as Latin-1 upstream (e.g. a garbled right quote in "NASA's"). */
function fixMojibake(s) {
  if (typeof s !== "string" || !/[\u00c2-\u00f4][\u0080-\u00bf]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("\ufffd") ? s : fixed;
}

const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]])) : null);

/** Keep only what the site renders — the detailed response is ~1.4 MB. */
const trim = (l) => ({
  ...pick(l, ["id", "name", "slug", "net", "window_end", "probability", "weather_concerns", "webcast_live"]),
  status: pick(l.status, ["name", "abbrev", "description"]),
  net_precision: pick(l.net_precision, ["name", "abbrev"]),
  image: pick(l.image, ["image_url", "thumbnail_url"]),
  launch_service_provider: pick(l.launch_service_provider, ["name"]),
  rocket: { configuration: pick(l.rocket?.configuration, ["name", "full_name"]) },
  mission: l.mission && {
    ...pick(l.mission, ["name", "type", "description"]),
    orbit: pick(l.mission.orbit, ["name"]),
  },
  pad: l.pad && {
    ...pick(l.pad, ["name", "map_url", "wiki_url"]),
    location: pick(l.pad.location, ["name"]),
  },
  vid_urls: (l.vid_urls || []).map((v) => ({
    ...pick(v, ["url", "source", "start_time", "live", "feature_image", "priority"]),
    title: fixMojibake(v.title),
    publisher: fixMojibake(v.publisher),
    type: pick(v.type, ["id", "name"]),
    language: pick(v.language, ["code"]),
  })),
});

const data = await fetchWithRetry(URL);
const launches = (data.results || []).map(trim);
if (!launches.length) throw new Error("API returned no launches; keeping the previous deployment.");

await mkdir(new globalThis.URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), launches }));

const streams = launches.filter((l) => l.vid_urls.length).length;
console.log(`Wrote ${launches.length} launches (${streams} with streams) to data/launches.json`);
