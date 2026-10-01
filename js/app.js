/* Ad Astra — upcoming rocket launches & spaceflight news.
 * Data: Launch Library 2 (The Space Devs) and Spaceflight News API.
 * Launches normally come from data/launches.json, a snapshot that GitHub Actions rebuilds
 * every 10 minutes (scripts/fetch-data.mjs). If it's missing or too old, the page calls LL2
 * directly; the free tier allows ~15 requests/hour per IP, so those responses are cached
 * in localStorage and stale data is reused when the API rate-limits us.
 */
(() => {
  "use strict";

  const LL2 = "https://ll.thespacedevs.com/2.3.0";
  const SNAPI = "https://api.spaceflightnewsapi.net/v4";
  const LAUNCH_TTL = 10 * 60 * 1000;
  const NEWS_TTL = 5 * 60 * 1000;
  const NEWS_PAGE = 12;
  const SNAPSHOT = "data/launches.json";
  const SNAPSHOT_MAX_AGE = 2 * 60 * 60 * 1000;
  const REFRESH_EVERY = 5 * 60 * 1000;
  // Without the snapshot, stream links (vid_urls) need LL2's heavy "detailed" mode, so they're
  // fetched for the nearest launches only — further ones rarely have a stream announced yet.
  const STREAM_LAUNCHES = 10;
  const STREAM_TTL = 10 * 60 * 1000;

  const $ = (sel) => document.querySelector(sel);
  const state = { launches: [], streams: {}, updated: null, shown: 0, newsNext: null, newsPaged: false };

  // ---------- Utilities ----------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Only allow http(s) URLs into href/src/style attributes.
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");

  function cacheGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function cacheSet(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch { /* quota / private mode */ }
  }

  /** Fetch JSON with a localStorage cache. Falls back to stale cache on failure.
   *  `transform` trims the response before it is cached. */
  async function cachedFetch(url, ttl, transform = (d) => d) {
    const key = "adastra:" + url;
    const hit = cacheGet(key);
    if (hit && Date.now() - hit.t < ttl) return { data: hit.data, stale: false, age: Date.now() - hit.t };
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status === 429 ? "rate-limited" : "HTTP " + res.status);
      const data = transform(await res.json());
      cacheSet(key, data);
      return { data, stale: false, age: 0 };
    } catch (err) {
      if (hit) return { data: hit.data, stale: true, error: err, age: Date.now() - hit.t };
      throw err;
    }
  }

  const fmtDate = (d, opts) =>
    new Intl.DateTimeFormat(undefined, opts).format(d);

  /** Human launch time that respects LL2's NET precision (second → year). */
  function fmtNet(launch) {
    const d = new Date(launch.net);
    const p = launch.net_precision?.abbrev || "SEC";
    switch (p) {
      case "SEC": case "MIN":
        return fmtDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      case "HR":
        return fmtDate(d, { weekday: "short", day: "numeric", month: "short", hour: "2-digit" }) + " (approx.)";
      // Coarse precisions are anchored in UTC so the day/month doesn't shift with the viewer's time zone.
      case "DAY":
        return "NET " + fmtDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      case "M":
        return "NET " + fmtDate(d, { month: "long", year: "numeric", timeZone: "UTC" });
      case "Y":
        return "NET " + d.getUTCFullYear();
      default: // Q1–Q4, H1–H2, …
        return `NET ${p} ${d.getUTCFullYear()}`;
    }
  }
  const isPrecise = (l) => ["SEC", "MIN", "HR"].includes(l.net_precision?.abbrev || "SEC");

  function splitDuration(ms) {
    const s = Math.floor(Math.abs(ms) / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }
  const pad2 = (n) => String(n).padStart(2, "0");

  function shortCountdown(launch) {
    const diff = new Date(launch.net) - Date.now();
    if (!isPrecise(launch)) return "TBD";
    const { d, h, m } = splitDuration(diff);
    const sign = diff < 0 ? "T+" : "T-";
    return d > 0 ? `${sign}${d}d ${pad2(h)}h` : `${sign}${pad2(h)}:${pad2(m)}`;
  }

  const statusClass = (l) => (l.status?.abbrev || "").toLowerCase().replace(/\s+/g, "");
  const img = (l) => safeUrl(l.image?.thumbnail_url || l.image?.image_url || l.image || "");
  const bigImg = (l) => safeUrl(l.image?.image_url || l.image || "");
  const provider = (l) => l.launch_service_provider?.name || "Unknown provider";
  const rocket = (l) => l.rocket?.configuration?.full_name || l.rocket?.configuration?.name || "";
  const where = (l) => [l.pad?.name, l.pad?.location?.name].filter(Boolean).join(" · ");

  // ---------- Live streams ----------

  /** Keep only the stream fields we display, best stream first (official, then LL2 priority). */
  function pickStreams(launch) {
    return {
      live: !!launch.webcast_live,
      vids: (launch.vid_urls || [])
        .filter((v) => safeUrl(v.url))
        .map((v) => ({
          url: v.url,
          title: v.title,
          publisher: v.publisher || v.source,
          type: v.type?.name,
          official: v.type?.id === 1,
          lang: v.language?.code,
          start: v.start_time,
          live: !!v.live,
          img: v.feature_image,
          priority: v.priority ?? 99,
        }))
        .sort((a, b) => b.live - a.live || b.official - a.official || a.priority - b.priority),
    };
  }

  const streamsOf = (l) => state.streams[l.id];
  const isLive = (l) => !!(streamsOf(l)?.live || streamsOf(l)?.vids.some((v) => v.live));

  async function loadStreams() {
    try {
      const res = await cachedFetch(
        `${LL2}/launches/upcoming/?limit=${STREAM_LAUNCHES}&mode=detailed&hide_recent_previous=true`,
        STREAM_TTL,
        (d) => Object.fromEntries((d.results || []).map((l) => [l.id, pickStreams(l)]))
      );
      Object.assign(state.streams, res.data);
      renderHero(state.launches[0]);
      renderGrid();
    } catch { /* streams are optional; the site works without them */ }
  }

  /** On-demand stream lookup for a launch outside the prefetched set. */
  async function loadStreamsFor(id) {
    if (state.streams[id]) return state.streams[id];
    const res = await cachedFetch(`${LL2}/launches/${encodeURIComponent(id)}/?mode=detailed`, STREAM_TTL * 3, pickStreams);
    return (state.streams[id] = res.data);
  }

  function streamList(s) {
    if (!s?.vids.length) return `<p class="muted">No live stream announced yet. Streams are usually published a few days before launch.</p>`;
    return s.vids.map((v) => {
      const start = v.start ? fmtDate(new Date(v.start), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      const img = safeUrl(v.img);
      return `
        <a class="news-item stream" href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="stream-ph">▶</div>`}
          <div>
            ${v.live ? `<span class="badge hold">● Live</span> ` : ""}${v.official ? `<span class="badge go">Official</span>` : ""}
            <h4>${esc(v.title || v.publisher || "Live stream")}</h4>
            <span class="src">${esc([v.publisher, v.type, v.lang?.toUpperCase()].filter(Boolean).join(" · "))}</span>
            ${start ? `<p>Stream starts ${esc(start)}</p>` : ""}
          </div>
        </a>`;
    }).join("");
  }

  // ---------- Hero / next launch ----------

  function renderHero(launch) {
    if (!launch) {
      $("#hero-name").textContent = "No upcoming launches found";
      return;
    }
    const bg = bigImg(launch);
    if (bg) $("#hero-bg").style.backgroundImage = `url("${bg}")`;
    $("#hero-name").textContent = launch.name;
    $("#hero-meta").innerHTML =
      `${esc(provider(launch))} · ${esc(where(launch))}<br>${esc(fmtNet(launch))} ` +
      `<span class="badge ${statusClass(launch)}">${esc(launch.status?.name || "")}</span>`;

    const actions = [];
    const best = streamsOf(launch)?.vids[0];
    if (best) {
      actions.push(isLive(launch)
        ? `<a class="btn live" href="${esc(best.url)}" target="_blank" rel="noopener">● Watch live now</a>`
        : `<a class="btn" href="${esc(best.url)}" target="_blank" rel="noopener">▶ Watch the stream</a>`);
    }
    actions.push(`<button class="btn ${best ? "ghost" : ""}" data-id="${esc(launch.id)}">Mission details</button>`);
    if (isPrecise(launch)) actions.push(`<button class="btn ghost" data-ics="${esc(launch.id)}">Add to calendar</button>`);
    $("#hero-actions").innerHTML = actions.join("");
    clearInterval(state.heroTimer);

    const box = $("#hero-countdown");
    const tick = () => {
      if (!isPrecise(launch)) {
        box.innerHTML = `<div class="unit"><span class="num">TBD</span><span class="lbl">exact time not set</span></div>`;
        return;
      }
      const diff = new Date(launch.net) - Date.now();
      const { d, h, m, s } = splitDuration(diff);
      box.innerHTML =
        `<span class="prefix">${diff < 0 ? "T+" : "T-"}</span>` +
        [[d, "days"], [h, "hours"], [m, "min"], [s, "sec"]]
          .map(([n, l]) => `<div class="unit"><span class="num">${pad2(n)}</span><span class="lbl">${l}</span></div>`)
          .join("");
    };
    tick();
    state.heroTimer = setInterval(tick, 1000);
  }

  // ---------- Launch grid ----------

  function launchCard(l) {
    const im = img(l);
    return `
      <button class="card" data-id="${esc(l.id)}" aria-label="${esc(l.name)}">
        <div class="card-img" style="${im ? `background-image:url('${esc(im)}')` : ""}">
          <span class="badge ${statusClass(l)}">${esc(l.status?.abbrev || "")}</span>
          ${isLive(l) ? `<span class="badge hold stream-badge">● Live</span>`
            : streamsOf(l)?.vids.length ? `<span class="badge stream-badge">▶ Stream</span>` : ""}
        </div>
        <div class="card-body">
          <span class="card-provider">${esc(provider(l))}</span>
          <h3>${esc(l.mission?.name || l.name)}</h3>
          <span class="card-line">🚀 ${esc(rocket(l))}</span>
          <span class="card-line">📍 ${esc(where(l))}</span>
          <div class="card-foot">
            <span>${esc(fmtNet(l))}</span>
            <span class="t" data-countdown="${esc(l.id)}">${esc(shortCountdown(l))}</span>
          </div>
        </div>
      </button>`;
  }

  function filteredLaunches() {
    const q = $("#f-search").value.trim().toLowerCase();
    const prov = $("#f-provider").value;
    const goOnly = $("#f-go").checked;
    return state.launches.filter((l) => {
      if (prov && provider(l) !== prov) return false;
      if (goOnly && l.status?.abbrev !== "Go") return false;
      if (!q) return true;
      const hay = [l.name, l.mission?.name, rocket(l), where(l), provider(l), l.mission?.orbit?.name]
        .join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderCount() {
    let text = `${state.shown} of ${state.launches.length} launches`;
    if (state.updated) {
      const mins = Math.round((Date.now() - state.updated) / 60000);
      text += ` · updated ${mins < 1 ? "just now" : mins + " min ago"}`;
    }
    $("#launch-count").textContent = text;
  }

  function renderGrid() {
    const list = filteredLaunches();
    state.shown = list.length;
    renderCount();
    $("#launch-grid").innerHTML = list.length
      ? list.map(launchCard).join("")
      : `<p class="muted">No launches match your filters.</p>`;
  }

  function populateProviders() {
    const names = [...new Set(state.launches.map(provider))].sort((a, b) => a.localeCompare(b));
    const sel = $("#f-provider");
    const current = sel.value;
    sel.innerHTML = `<option value="">All providers</option>` +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = names.includes(current) ? current : "";
  }

  function showNotice(el, res, what) {
    if (!res.stale) { el.hidden = true; return; }
    const mins = Math.round(res.age / 60000);
    el.hidden = false;
    el.textContent = res.error?.message === "rate-limited"
      ? `The ${what} API rate limit was reached. Showing data cached ${mins} min ago.`
      : `Couldn't reach the ${what} API. Showing data cached ${mins} min ago.`;
  }

  /** Snapshot first (built by GitHub Actions, includes streams); live API as a fallback. */
  async function fetchLaunchData() {
    try {
      const res = await fetch(SNAPSHOT, { cache: "no-cache" });
      if (res.ok) {
        const d = await res.json();
        const updated = new Date(d.updated);
        if (d.launches?.length && Date.now() - updated < SNAPSHOT_MAX_AGE) {
          $("#launch-notice").hidden = true;
          return { launches: d.launches, updated, snapshot: true };
        }
      }
    } catch { /* no snapshot (e.g. local run without Node) — use the API */ }

    const res = await cachedFetch(`${LL2}/launches/upcoming/?limit=40&mode=normal&hide_recent_previous=true`, LAUNCH_TTL);
    showNotice($("#launch-notice"), res, "launch");
    return { launches: res.data.results || [], updated: new Date(Date.now() - res.age), snapshot: false };
  }

  async function loadLaunches(initial = false) {
    if (initial) $("#launch-grid").innerHTML = Array(6).fill('<div class="skeleton"></div>').join("");
    try {
      const d = await fetchLaunchData();
      state.launches = d.launches;
      state.updated = d.updated;
      if (d.snapshot) state.streams = Object.fromEntries(d.launches.map((l) => [l.id, pickStreams(l)]));
      populateProviders();
      renderHero(state.launches[0]);
      renderGrid();
      if (!d.snapshot) loadStreams();
      if (initial && hashLaunch()) openDetail(hashLaunch());
    } catch (err) {
      if (!initial) return; // a failed background refresh keeps the data already on screen
      $("#launch-grid").innerHTML = "";
      const n = $("#launch-notice");
      n.hidden = false;
      n.textContent = err.message === "rate-limited"
        ? "The launch API rate limit (15 requests/hour) was reached. Please try again in a few minutes."
        : "Couldn't load launches: " + err.message;
      $("#hero-name").textContent = "Launch data unavailable";
    }
  }

  // ---------- News ----------

  function newsItem(a) {
    const im = safeUrl(a.image_url);
    const date = fmtDate(new Date(a.published_at), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return `
      <a class="news-item" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener">
        <img src="${esc(im)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div>
          <h4>${esc(a.title)}</h4>
          <span class="src">${esc(a.news_site)} · ${esc(date)}</span>
          <p>${esc(a.summary)}</p>
        </div>
      </a>`;
  }

  async function loadNews(url = `${SNAPI}/articles/?limit=${NEWS_PAGE}`, replace = false) {
    const btn = $("#news-more");
    btn.disabled = true;
    try {
      const res = await cachedFetch(url, NEWS_TTL);
      showNotice($("#news-notice"), res, "news");
      const html = res.data.results.map(newsItem).join("");
      if (replace) $("#news-list").innerHTML = html;
      else $("#news-list").insertAdjacentHTML("beforeend", html);
      state.newsNext = res.data.next;
      btn.hidden = !state.newsNext;
    } catch (err) {
      const n = $("#news-notice");
      n.hidden = false;
      n.textContent = "Couldn't load news: " + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Detail dialog ----------

  async function openDetail(id) {
    const l = state.launches.find((x) => x.id === id);
    if (!l) return;
    if (location.hash !== "#launch=" + id) history.replaceState(null, "", "#launch=" + encodeURIComponent(id));
    const big = bigImg(l);
    const facts = [
      ["Status", l.status?.name],
      ["Launch time", fmtNet(l)],
      ["Provider", provider(l)],
      ["Rocket", rocket(l)],
      ["Mission type", l.mission?.type],
      ["Orbit", l.mission?.orbit?.name],
      ["Pad", l.pad?.name],
      ["Location", l.pad?.location?.name],
      ["Weather (go %)", l.probability != null && l.probability >= 0 ? l.probability + " %" : null],
    ].filter(([, v]) => v);

    const map = safeUrl(l.pad?.map_url);
    const wiki = safeUrl(l.pad?.wiki_url);

    $("#detail-body").innerHTML = `
      ${big ? `<div class="detail-img" style="background-image:url('${esc(big)}')"></div>` : ""}
      <div class="detail-body">
        <span class="badge ${statusClass(l)}">${esc(l.status?.name || "")}</span>
        <h2>${esc(l.name)}</h2>
        <p class="muted">${esc(l.status?.description || "")}</p>
        <div class="facts">
          ${facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}
        </div>
        ${l.mission?.description ? `<h3>Mission</h3><p>${esc(l.mission.description)}</p>` : ""}
        ${l.weather_concerns ? `<p class="muted"><strong>Weather concerns:</strong> ${esc(l.weather_concerns)}</p>` : ""}
        <div class="hero-actions">
          ${isPrecise(l) ? `<button class="btn" data-ics="${esc(l.id)}">Add to calendar</button>` : ""}
          ${map ? `<a class="btn ghost" href="${esc(map)}" target="_blank" rel="noopener">Pad on map</a>` : ""}
          ${wiki ? `<a class="btn ghost" href="${esc(wiki)}" target="_blank" rel="noopener">Pad on Wikipedia</a>` : ""}
        </div>
        <h3>Live streams</h3>
        <div class="news-list" id="streams">${streamsOf(l) ? streamList(streamsOf(l)) : `<p class="muted">Loading…</p>`}</div>
        <h3>Related news</h3>
        <div class="news-list" id="related"><p class="muted">Loading…</p></div>
      </div>`;
    if (!$("#detail").open) $("#detail").showModal();

    if (!streamsOf(l)) {
      loadStreamsFor(id)
        .then((s) => { const box = $("#streams"); if (box) box.innerHTML = streamList(s); })
        .catch(() => { const box = $("#streams"); if (box) box.innerHTML = `<p class="muted">Couldn't load stream links right now.</p>`; });
    }

    try {
      const res = await cachedFetch(`${SNAPI}/articles/?launch=${encodeURIComponent(id)}&limit=6`, NEWS_TTL);
      const box = $("#related");
      if (!box) return;
      box.innerHTML = res.data.results.length
        ? res.data.results.map(newsItem).join("")
        : `<p class="muted">No articles linked to this launch yet.</p>`;
    } catch {
      const box = $("#related");
      if (box) box.innerHTML = `<p class="muted">Couldn't load related news.</p>`;
    }
  }

  // ---------- Calendar export ----------

  function downloadIcs(id) {
    const l = state.launches.find((x) => x.id === id);
    if (!l) return;
    const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const start = new Date(l.net);
    let end = new Date(l.window_end || l.net);
    if (end - start < 30 * 60000) end = new Date(start.getTime() + 60 * 60000);
    const icsEsc = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ad Astra//Launches//EN",
      "BEGIN:VEVENT",
      `UID:${l.id}@ad-astra`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:🚀 ${icsEsc(l.name)}`,
      `LOCATION:${icsEsc(where(l))}`,
      `DESCRIPTION:${icsEsc((l.mission?.description || "") + "\n\nLaunch times can change. Check Ad Astra for updates.")}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    a.download = (l.slug || "launch") + ".ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Wiring ----------

  document.addEventListener("click", (e) => {
    const ics = e.target.closest("[data-ics]");
    if (ics) { downloadIcs(ics.dataset.ics); return; }
    const card = e.target.closest("[data-id]");
    if (card) openDetail(card.dataset.id);
  });

  const dlg = $("#detail");
  $("#detail-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  // Shareable deep link: #launch=<id> opens that launch's details.
  dlg.addEventListener("close", () => {
    if (location.hash.startsWith("#launch=")) history.replaceState(null, "", location.pathname + location.search);
  });
  const hashLaunch = () => decodeURIComponent((location.hash.match(/^#launch=(.+)$/) || [])[1] || "");
  window.addEventListener("hashchange", () => { const id = hashLaunch(); if (id) openDetail(id); });

  ["#f-search", "#f-provider", "#f-go"].forEach((s) => $(s).addEventListener("input", renderGrid));
  $("#news-more").addEventListener("click", () => {
    if (!state.newsNext) return;
    state.newsPaged = true;
    loadNews(state.newsNext);
  });

  $("#tz").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;

  loadLaunches(true);
  loadNews();

  // Card countdowns and the "updated … ago" label tick every 30 s.
  setInterval(() => {
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      const l = state.launches.find((x) => x.id === el.dataset.countdown);
      if (l) el.textContent = shortCountdown(l);
    });
    renderCount();
  }, 30000);

  // Auto-refresh data while the tab is visible (and right away when it becomes visible again).
  // The snapshot is a static file, and the API fallback is throttled by cachedFetch's TTL.
  const refresh = () => {
    if (document.hidden) return;
    loadLaunches();
    if (!state.newsPaged) loadNews(undefined, true);
  };
  setInterval(refresh, REFRESH_EVERY);
  document.addEventListener("visibilitychange", refresh);
})();
