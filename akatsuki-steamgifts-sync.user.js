// ==UserScript==
// @name         Akatsuki SteamGifts Sync
// @namespace    akatsuki-monitor
// @version      1.13.2
// @author       Koalala
// @description  Collect Akatsuki members, giveaways, entries and winners from the logged-in SteamGifts session and publish them straight to GitHub.
// @match        https://www.steamgifts.com/group/7Ypot/akatsukigamessteamgifts
// @match        https://www.steamgifts.com/group/7Ypot/akatsukigamessteamgifts/*
// @grant        GM_info
// @downloadURL  https://raw.githubusercontent.com/jpdefo/akatsuki-group/main/akatsuki-steamgifts-sync.user.js
// @updateURL    https://raw.githubusercontent.com/jpdefo/akatsuki-group/main/akatsuki-steamgifts-sync.user.js
// ==/UserScript==

(function () {
  "use strict";

  const groupMatch = window.location.pathname.match(/(\/group\/[^/]+\/[^/]+)/);
  if (!groupMatch) {
    return;
  }

  const groupBase = `${window.location.origin}${groupMatch[1]}`;
  const GITHUB_REPO = { owner: "jpdefo", name: "akatsuki-group", branch: "main" };
  const GITHUB_TOKEN_HELP_URL = "https://github.com/settings/personal-access-tokens/new";
  const GITHUB_SYNC_PATH = "data/steamgifts-sync.json";
  const GITHUB_TOKEN_KEY = "akatsuki-github-token";
  const PANEL_MINIMIZED_KEY = "akatsuki-panel-minimized";
  // Rate limiting (SteamGifts allows ~120 requests/min). We run at FULL SPEED by
  // default so small/typical syncs stay fast; only when we actually hit a 429 do
  // we start pacing every request and backing off. Very large scrapes are
  // pre-paced so they skip the one-time backoff penalty.
  const PREPACE_GIVEAWAY_THRESHOLD = 150;
  const PACED_REQUEST_GAP_MS = 550; // ~109 req/min once pacing is on
  const RATE_LIMIT_BACKOFF_MS = 30000;
  const RATE_LIMIT_MAX_RETRIES = 15;
  let requestGapMs = 0; // 0 = full speed; set to PACED_REQUEST_GAP_MS when throttling
  let lastRequestAt = 0;
  const PUBLISHED_SYNC_URL = `https://raw.githubusercontent.com/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/${GITHUB_REPO.branch}/${GITHUB_SYNC_PATH}`;
  const PUBLISHED_OVERRIDES_URL = `https://raw.githubusercontent.com/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/${GITHUB_REPO.branch}/data/overrides.json`;
  const SCRIPT_SOURCE_PATH = "akatsuki-steamgifts-sync.user.js";
  const SCRIPT_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/${GITHUB_REPO.branch}/${SCRIPT_SOURCE_PATH}`;
  const SCRIPT_INSTALL_URL = SCRIPT_RAW_URL;
  // Version of the running script, read straight from this file's @version header
  // via GM_info (no duplicate constant to keep in sync).
  const RUNNING_VERSION =
    (typeof GM_info !== "undefined" && GM_info && GM_info.script && GM_info.script.version) || "";
  const state = {
    running: false,
    panel: null,
    log: null,
  };

  function getStoredToken() {
    try {
      return localStorage.getItem(GITHUB_TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function setStoredToken(token) {
    try {
      if (token) {
        localStorage.setItem(GITHUB_TOKEN_KEY, token);
      } else {
        localStorage.removeItem(GITHUB_TOKEN_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  function isPanelMinimized() {
    try {
      return localStorage.getItem(PANEL_MINIMIZED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setPanelMinimized(minimized) {
    try {
      if (minimized) {
        localStorage.setItem(PANEL_MINIMIZED_KEY, "1");
      } else {
        localStorage.removeItem(PANEL_MINIMIZED_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  function applyPanelMinimized(minimized) {
    const panel = state.panel;
    if (!panel) {
      return;
    }
    const body = panel.querySelector("#akatsuki-body");
    const toggle = panel.querySelector("#akatsuki-minimize");
    if (body) {
      body.style.display = minimized ? "none" : "grid";
    }
    // Shrink to a compact header pill when minimized so it stays out of the way.
    panel.style.width = minimized ? "auto" : "320px";
    if (toggle) {
      toggle.textContent = minimized ? "+" : "–";
      toggle.title = minimized ? "Maximize" : "Minimize";
      toggle.setAttribute("aria-label", minimized ? "Maximize" : "Minimize");
    }
  }

  addPanel();

  function addPanel() {
    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "18px";
    panel.style.bottom = "18px";
    panel.style.zIndex = "99999";
    panel.style.width = "320px";
    panel.style.padding = "14px";
    panel.style.borderRadius = "16px";
    panel.style.background = "rgba(15, 17, 21, 0.96)";
    panel.style.border = "1px solid rgba(110, 168, 254, 0.35)";
    panel.style.boxShadow = "0 18px 45px rgba(0,0,0,.35)";
    panel.style.color = "#f4f7fb";
    panel.innerHTML = `
      <div style="display:grid;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <strong>Akatsuki Sync</strong>
          <button id="akatsuki-minimize" type="button" title="Minimize" aria-label="Minimize" style="border:1px solid rgba(110,168,254,.35);border-radius:8px;width:24px;height:24px;line-height:1;padding:0;background:#0f1115;color:#f4f7fb;font:inherit;font-size:16px;font-weight:700;cursor:pointer;flex:0 0 auto;">–</button>
        </div>
        <div id="akatsuki-body" style="display:grid;gap:8px;">
          <div id="akatsuki-version" style="font-size:11px;line-height:1.4;color:#8b97a8;"></div>
          <div id="akatsuki-token-locked" style="display:none;align-items:center;justify-content:space-between;gap:8px;border:1px solid rgba(110,168,254,.35);border-radius:8px;padding:8px;background:#0f1115;font-size:12px;color:#c7d2e2;">
            <span>🔒 GitHub token saved</span>
            <button id="akatsuki-token-edit" type="button" style="border:1px solid rgba(110,168,254,.35);border-radius:8px;padding:4px 10px;background:#0f1115;color:#6ea8fe;font:inherit;font-size:12px;font-weight:600;cursor:pointer;flex:0 0 auto;">Edit</button>
          </div>
          <div id="akatsuki-token-editor" style="display:grid;gap:6px;">
            <input id="akatsuki-token" type="password" placeholder="GitHub token (for direct publish)" style="border:1px solid rgba(110,168,254,.35);border-radius:8px;padding:8px;background:#0f1115;color:#f4f7fb;font:inherit;font-size:12px;" />
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <a id="akatsuki-token-help" href="${GITHUB_TOKEN_HELP_URL}" target="_blank" rel="noopener" style="font-size:11px;color:#6ea8fe;text-decoration:underline;">Get a token (needs Contents: Read and write)</a>
              <button id="akatsuki-token-save" type="button" style="border:1px solid rgba(46,195,107,.5);border-radius:8px;padding:4px 10px;background:#0f1115;color:#2ec36b;font:inherit;font-size:12px;font-weight:600;cursor:pointer;flex:0 0 auto;">Save</button>
            </div>
          </div>
          <label style="font-size:12px;color:#c7d2e2;display:flex;align-items:center;gap:6px;">Recent pages to scrape
            <input id="akatsuki-pages" type="number" min="1" value="10" style="width:64px;border:1px solid rgba(110,168,254,.35);border-radius:8px;padding:6px;background:#0f1115;color:#f4f7fb;font:inherit;font-size:12px;" />
          </label>
          <button id="akatsuki-publish-button" style="border:0;border-radius:10px;padding:10px 12px;background:#2ec36b;color:#06210f;font:inherit;font-weight:700;cursor:pointer;">Sync &amp; Publish to GitHub</button>
          <div id="akatsuki-sync-log" style="font-size:12px;line-height:1.5;color:#c7d2e2;max-height:180px;overflow:auto;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    state.panel = panel;
    state.log = panel.querySelector("#akatsuki-sync-log");
    const tokenInput = panel.querySelector("#akatsuki-token");
    const tokenLockedView = panel.querySelector("#akatsuki-token-locked");
    const tokenEditor = panel.querySelector("#akatsuki-token-editor");

    // Once a token is saved we hide it behind a "saved" chip with an Edit
    // button. The real token is NEVER written into the input, so it can't be
    // read from the DOM (inspect) or shoulder-surfed, and can't be typed over
    // by accident. Editing always starts from an empty field: typing a new
    // value replaces the token; leaving it empty keeps the existing one.
    function showTokenLocked() {
      tokenInput.value = "";
      tokenLockedView.style.display = "flex";
      tokenEditor.style.display = "none";
    }
    function showTokenEditor(focus) {
      tokenInput.value = "";
      tokenLockedView.style.display = "none";
      tokenEditor.style.display = "grid";
      if (focus) {
        tokenInput.focus();
      }
    }
    function commitTokenInput() {
      // Only a non-empty value overwrites the stored token, so an empty editor
      // (or an accidental blur) never wipes an already-configured token.
      const value = tokenInput.value.trim();
      if (value) {
        setStoredToken(value);
      }
      tokenInput.value = "";
    }
    tokenInput.addEventListener("change", commitTokenInput);
    panel.querySelector("#akatsuki-token-edit").addEventListener("click", () => showTokenEditor(true));
    panel.querySelector("#akatsuki-token-save").addEventListener("click", () => {
      commitTokenInput();
      if (getStoredToken()) {
        showTokenLocked();
      }
    });
    if (getStoredToken()) {
      showTokenLocked();
    } else {
      showTokenEditor(false);
    }
    panel.querySelector("#akatsuki-publish-button").addEventListener("click", () => runSync());
    panel.querySelector("#akatsuki-minimize").addEventListener("click", () => {
      const next = !isPanelMinimized();
      setPanelMinimized(next);
      applyPanelMinimized(next);
    });
    applyPanelMinimized(isPanelMinimized());
    log("Ready. Paste a token and use 'Sync & Publish' to commit straight to GitHub.");
    renderVersionInfo();
  }

  function parseScriptVersion(text) {
    const match = String(text || "").match(/@version\s+([0-9][^\s]*)/);
    return match ? match[1] : "";
  }

  function compareVersions(left, right) {
    const partsLeft = String(left || "").split(".").map((part) => parseInt(part, 10) || 0);
    const partsRight = String(right || "").split(".").map((part) => parseInt(part, 10) || 0);
    const length = Math.max(partsLeft.length, partsRight.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (partsLeft[index] || 0) - (partsRight[index] || 0);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    }
    return 0;
  }

  function formatVersionDate(isoString) {
    if (!isoString) {
      return "";
    }
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  async function fetchLatestScriptMeta() {
    const meta = { version: "", updatedAt: "" };
    try {
      const response = await fetch(`${SCRIPT_RAW_URL}?_=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        meta.version = parseScriptVersion(await response.text());
      }
    } catch {
      /* ignore */
    }
    try {
      const api = `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/commits?path=${encodeURIComponent(SCRIPT_SOURCE_PATH)}&sha=${GITHUB_REPO.branch}&per_page=1`;
      const response = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
      if (response.ok) {
        const commits = await response.json();
        const commit = Array.isArray(commits) ? commits[0]?.commit : null;
        meta.updatedAt = commit?.committer?.date || commit?.author?.date || "";
      }
    } catch {
      /* ignore */
    }
    return meta;
  }

  async function renderVersionInfo() {
    const node = state.panel?.querySelector("#akatsuki-version");
    if (!node) {
      return;
    }
    const running = RUNNING_VERSION || "?";
    node.textContent = `v${running} • checking for updates…`;

    const { version: latest, updatedAt } = await fetchLatestScriptMeta();
    const updated = formatVersionDate(updatedAt);
    const isOutdated = Boolean(latest && RUNNING_VERSION && compareVersions(RUNNING_VERSION, latest) < 0);

    node.textContent = "";
    const status = document.createElement("div");
    if (isOutdated) {
      status.textContent = `v${running} installed`;
      node.appendChild(status);
      const warn = document.createElement("a");
      warn.href = SCRIPT_INSTALL_URL;
      warn.target = "_blank";
      warn.rel = "noopener";
      warn.textContent = `⚠ Update available: v${latest}${updated ? ` (${updated})` : ""} — click to install`;
      warn.style.color = "#f5b955";
      warn.style.fontWeight = "700";
      warn.style.textDecoration = "underline";
      warn.style.display = "block";
      node.appendChild(warn);
    } else {
      const suffix = updated ? ` • updated ${updated}` : "";
      const trailer = latest ? " • up to date" : "";
      status.textContent = `v${running}${suffix}${trailer}`;
      node.appendChild(status);
    }
  }

  async function runSync() {
    if (state.running) {
      log("A sync is already running.");
      return;
    }
    if (!getStoredToken()) {
      log("Paste a GitHub token first (Contents: Read and write) to publish.");
      return;
    }

    state.running = true;
    requestGapMs = 0; // start fast; the 429 handler turns pacing on if needed
    log("Reading existing data...");

    try {
      const existingSync = await loadExistingSync();
      const existingGiveaways = Array.isArray(existingSync?.giveaways) ? existingSync.giveaways : [];
      const existingMembers = Array.isArray(existingSync?.members) ? existingSync.members : [];
      log(`Existing data: ${existingGiveaways.length} giveaway(s).`);

      const maxPages = Math.max(1, Number(state.panel?.querySelector("#akatsuki-pages")?.value) || 10);
      if (maxPages < 500 && existingGiveaways.length === 0) {
        throw new Error(
          "Could not load existing data to merge a partial scrape, so publishing would wipe history. Aborted. Check the repo/token, or set pages to 999 for a full scrape.",
        );
      }

      const members = await collectMembers(existingSync);
      log(`Members found: ${members.length}`);

      log(`Reading the ${maxPages} most recent giveaway page(s)...`);
      const giveaways = await collectGiveaways(existingSync, maxPages);
      log(`Giveaways scraped: ${giveaways.length}`);

      let detailedGiveaways = giveaways;
      const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
      if (unresolvedGiveaways.length) {
        if (unresolvedGiveaways.length > PREPACE_GIVEAWAY_THRESHOLD) {
          requestGapMs = PACED_REQUEST_GAP_MS;
        }
        log(
          `Resolving ${unresolvedGiveaways.length} giveaway(s) missing app, winner, or label data...${requestGapMs ? " (paced to avoid rate limits)" : ""}`,
        );
        const resolvedGiveaways = new Map();
        for (const [index, giveaway] of unresolvedGiveaways.entries()) {
          log(`Resolving giveaway ${index + 1}/${unresolvedGiveaways.length}: ${giveaway.title}`);
          resolvedGiveaways.set(giveaway.code, await enrichGiveaway(giveaway));
        }
        detailedGiveaways = giveaways.map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway);
      }

      // Never drop history: keep existing giveaways/members not seen in this scrape.
      const finalGiveaways = unionByKey(detailedGiveaways, existingGiveaways, (item) => item.code);
      const mergedMembers = mergeMembersWithGiveawayUsers(members, detailedGiveaways);
      const finalMembers = unionByKey(mergedMembers, existingMembers, (item) => item.username);

      if (!finalGiveaways.length) {
        throw new Error("No giveaways collected; aborting so empty data is never published.");
      }

      // Giveaways manually promoted to summer_event (kind override) may never have
      // had their entrants collected, since the collector classifies from the
      // description. Fetch /entries for any promoted giveaway that lacks them,
      // even old ones, so their summer-event entry points can be computed.
      const summerOverrideCodes = await loadSummerEventOverrideCodes();
      const giveawaysNeedingEntries = finalGiveaways.filter(
        (giveaway) =>
          giveaway?.url &&
          summerOverrideCodes.has(String(giveaway.code)) &&
          !(Array.isArray(giveaway.entryUsers) && giveaway.entryUsers.length > 0) &&
          // A giveaway can legitimately have zero entrants; treat it as captured
          // once its entrants have actually been snapshotted from an ended
          // giveaway, otherwise an empty entryUsers list would refetch forever.
          !(giveaway.entriesFinalized && giveaway.entriesSnapshotAt),
      );
      if (giveawaysNeedingEntries.length) {
        log(`Fetching entrants for ${giveawaysNeedingEntries.length} promoted summer-event giveaway(s)...`);
        for (const [index, giveaway] of giveawaysNeedingEntries.entries()) {
          log(`  entrants ${index + 1}/${giveawaysNeedingEntries.length}: ${giveaway.title}`);
          const snapshot = await fetchGiveawayEntries(giveaway.url);
          if (snapshot && Array.isArray(snapshot.users)) {
            giveaway.entryUsers = snapshot.users;
            giveaway.entriesSnapshotAt = snapshot.capturedAt;
            giveaway.entriesFinalized = isGiveawayEnded(giveaway);
          }
        }
      }

      // Detect giveaways deleted on SteamGifts before they ended and drop them
      // for good. A still-open giveaway the group listing no longer shows is the
      // signal; we confirm by loading its detail page and only act on SteamGifts'
      // "Deleted <when> by <whom>" notice (the page stays HTTP 200, it does not
      // 404), so a transient miss or a 429 never drops a live giveaway. Ended
      // giveaways legitimately scroll off the listing, so they are never probed.
      // SteamGifts deletions are permanent (there is no un-delete), so a confirmed
      // deletion is excluded from the published payload outright rather than
      // tombstoned: it is absent from both the scrape and the next run's existing
      // data, so it never reappears or gets re-probed. Any tombstones left in
      // prior data are purged here too, without re-probing.
      const scrapedCodes = new Set(detailedGiveaways.map((giveaway) => String(giveaway.code)));
      const deletedCodes = new Set(
        finalGiveaways
          .filter((giveaway) => giveaway?.deleted && giveaway?.code)
          .map((giveaway) => String(giveaway.code)),
      );
      const deletionCandidates = finalGiveaways.filter(
        (giveaway) =>
          giveaway?.code &&
          giveaway?.url &&
          !giveaway.deleted &&
          !scrapedCodes.has(String(giveaway.code)) &&
          !isGiveawayEnded(giveaway),
      );
      if (deletionCandidates.length) {
        log(`Checking ${deletionCandidates.length} missing open giveaway(s) for deletion...`);
        for (const [index, giveaway] of deletionCandidates.entries()) {
          const status = await probeGiveawayDeleted(giveaway.url);
          if (status === "deleted") {
            deletedCodes.add(String(giveaway.code));
            log(`  deleted (${index + 1}/${deletionCandidates.length}): ${giveaway.title}`);
          }
        }
      }
      const publishableGiveaways = deletedCodes.size
        ? finalGiveaways.filter((giveaway) => !deletedCodes.has(String(giveaway.code)))
        : finalGiveaways;

      const payload = {
        source: "akatsuki-steamgifts-sync",
        collectorVersion: RUNNING_VERSION || "",
        syncedAt: new Date().toISOString(),
        group: {
          url: groupBase,
          name: document.title.replace(/\s*\|\s*SteamGifts.*/, "").trim(),
        },
        members: finalMembers,
        giveaways: publishableGiveaways,
      };
      payload.wins = publishableGiveaways.flatMap((giveaway) =>
        (giveaway.winners || []).map((winner) => ({
          giveawayCode: giveaway.code,
          title: giveaway.title,
          appId: giveaway.appId || null,
          winnerUsername: winner.username,
          creatorUsername: giveaway.creatorUsername,
          entriesCount: giveaway.entriesCount || 0,
          winDate: giveaway.endDate || payload.syncedAt,
        })),
      );

      log(`Publishing ${publishableGiveaways.length} giveaway(s) to GitHub...`);
      await publishSyncToGitHub(payload);
      log("Published to GitHub. Pages will rebuild in ~1-2 min.");
    } catch (error) {
      log(`Failed: ${error.message}`);
    } finally {
      state.running = false;
    }
  }

  function unionByKey(scraped, existing, keyFn) {
    const map = new Map();
    for (const item of existing || []) {
      const key = keyFn(item);
      if (key) {
        map.set(key, item);
      }
    }
    for (const item of scraped || []) {
      const key = keyFn(item);
      if (key) {
        map.set(key, item);
      }
    }
    return Array.from(map.values());
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function collectMembers(existingSync) {
    const results = [];
    const seen = new Set();
    const cachedProfiles = new Map(
      (existingSync?.members || [])
        .filter((member) => member?.username)
        .map((member) => [member.username, member.steamProfile || ""]),
    );

    for (let page = 1; page <= 200; page += 1) {
      const url = page === 1 ? `${groupBase}/users` : `${groupBase}/users/search?page=${page}`;
      const doc = await fetchDocument(url);
      const pageMembers = parseMemberRows(doc, cachedProfiles);
      if (!pageMembers.length) {
        break;
      }

      let added = 0;
      for (const member of pageMembers) {
        const username = member.username;
        if (!username || seen.has(username)) {
          continue;
        }
        results.push(member);
        seen.add(username);
        added += 1;
      }

      if (!added) {
        break;
      }
    }

    const missingProfiles = results.filter((member) => !member.steamProfile && member.profileUrl);
    if (missingProfiles.length) {
      log(`Resolving Steam profiles for ${missingProfiles.length} new member(s)...`);
      for (const [index, member] of missingProfiles.entries()) {
        log(`Checking member ${index + 1}/${missingProfiles.length}: ${member.username}`);
        member.steamProfile = (await fetchMemberSteamProfile(member.profileUrl)) || cachedProfiles.get(member.username) || "";
      }
    }

    return results;
  }

  async function collectGiveaways(existingSync, maxPages = 500) {
    const results = [];
    const seen = new Set();
    const existingGiveaways = new Map(
      (existingSync?.giveaways || []).filter((giveaway) => giveaway?.code).map((giveaway) => [giveaway.code, giveaway]),
    );

    const pageCap = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 500;
    for (let page = 1; page <= pageCap; page += 1) {
      const url = page === 1 ? groupBase : `${groupBase}/search?page=${page}`;
      const doc = await fetchDocument(url);
      const pageResults = parseGiveawayRows(doc, existingGiveaways);
      if (!pageResults.length) {
        break;
      }

      let added = 0;
      for (const giveaway of pageResults) {
        if (seen.has(giveaway.code)) {
          continue;
        }
        seen.add(giveaway.code);
        results.push(giveaway);
        added += 1;
      }

      if (!added) {
        break;
      }
    }

    return results;
  }

  function parseGiveawayRows(doc, existingGiveaways = new Map()) {
    const rows = Array.from(
      doc.querySelectorAll(".giveaway__row-inner-wrap, .table__row-inner-wrap"),
    );
    const results = [];

    for (const row of rows) {
      const giveawayLink = Array.from(row.querySelectorAll('a[href*="/giveaway/"]')).find((anchor) =>
        /\/giveaway\/[^/]+\/[^/]+/.test(anchor.getAttribute("href") || ""),
      );
      if (!giveawayLink) {
        continue;
      }

      const codeMatch = giveawayLink.href.match(/\/giveaway\/([^/]+)\//);
      if (!codeMatch) {
        continue;
      }

      const title = giveawayLink.textContent.trim();

      const primaryUser = getCreatorRecord(row);
      const secondaryUsers = getWinnerRecords(row, primaryUser);
      const rowText = normalizeText(row.textContent || "");
      const entryLink = Array.from(row.querySelectorAll('a[href$="/entries"]')).find(Boolean);
      const timestamps = Array.from(row.querySelectorAll("[data-timestamp]"));
      // A group-page row shows two times: the earlier is the creation date, the
      // later is the end date. Identify them by value, not DOM order.
      const tsValues = timestamps
        .map((el) => Number(el.getAttribute("data-timestamp")) * 1000)
        .filter((value) => Number.isFinite(value) && value > 0);
      const startTimestamp = tsValues.length ? Math.min(...tsValues) : null;
      const endTimestamp = tsValues.length >= 2 ? Math.max(...tsValues) : null;
      const { appId, steamAppUrl } = extractAppInfo(row);
      const media = extractSteamMedia(row, appId);
      const winnerInfo = extractWinnerInfo(rowText, primaryUser, secondaryUsers, endTimestamp);
      const creator = resolveCreatorRecord(primaryUser, secondaryUsers, winnerInfo.resultStatus);

      results.push(mergeGiveawayWithExisting({
        code: codeMatch[1],
        url: giveawayLink.href,
        title,
        creatorUsername: creator ? creator.username : "",
        creatorProfileUrl: creator ? creator.profileUrl : "",
        appId,
        steamAppUrl,
        points: extractPointCost(row, title),
        headerImageUrl: media.headerImageUrl,
        capsuleImageUrl: media.capsuleImageUrl,
        capsuleSmallUrl: media.capsuleSmallUrl,
        entriesCount: entryLink ? parseInt(entryLink.textContent.replace(/[^\d]/g, ""), 10) || 0 : 0,
        startDate: startTimestamp ? new Date(startTimestamp).toISOString() : null,
        endDate: endTimestamp ? new Date(endTimestamp).toISOString() : null,
        winners: winnerInfo.winners,
        resultStatus: winnerInfo.resultStatus,
        resultLabel: winnerInfo.resultLabel,
      }, existingGiveaways.get(codeMatch[1])));
    }

    return results;
  }

  function parseMemberRows(doc, cachedProfiles = new Map()) {
    const rowLinks = Array.from(doc.querySelectorAll('.table__row-inner-wrap a[href*="/user/"]'));
    const links = rowLinks.length ? rowLinks : Array.from(doc.querySelectorAll('a[href*="/user/"]'));
    const results = [];
    const seen = new Set();
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (!/\/user\/[^/]+/.test(href)) {
        continue;
      }
      const username = normalizeText(link.textContent || "");
      if (!username || seen.has(username)) {
        continue;
      }
      const container = link.closest(".table__row-inner-wrap, .giveaway__row-inner-wrap") || doc.body;
      const steamLink = container.querySelector('a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]');
      results.push({
        username,
        profileUrl: new URL(href, window.location.origin).href,
        steamProfile: steamLink ? steamLink.href : cachedProfiles.get(username) || "",
        isActiveMember: true,
      });
      seen.add(username);
    }
    return results;
  }

  async function fetchMemberSteamProfile(profileUrl) {
    const doc = await fetchDocument(profileUrl);
    const steamLink = doc.querySelector('a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]');
    return steamLink ? steamLink.href : "";
  }

  async function loadExistingSync() {
    // Read the published data from GitHub so a partial scrape still merges with
    // full history.
    try {
      log("Loading existing data from GitHub...");
      const response = await fetch(`${PUBLISHED_SYNC_URL}?_=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        return await response.json();
      }
      log(`Could not load published data (${response.status}).`);
    } catch (error) {
      log(`Could not load published data: ${error.message}`);
    }
    return {};
  }

  async function loadSummerEventOverrideCodes() {
    // Read the giveaway kind overrides from the published overrides.json and
    // return the set of giveaway codes promoted to summer_event, so the
    // collector can fetch their entrants.
    const extract = (payload) => {
      const giveaways = payload?.overrides?.giveaways || payload?.giveaways || {};
      return new Set(
        Object.entries(giveaways)
          .filter(([, entry]) => String(entry?.giveawayKindOverride || "").trim() === "summer_event")
          .map(([key]) => String(key).replace(/^sg-/, "")),
      );
    };

    try {
      const response = await fetch(`${PUBLISHED_OVERRIDES_URL}?_=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        return extract(await response.json());
      }
    } catch {
      /* ignore */
    }
    return new Set();
  }

  async function publishSyncToGitHub(payload) {
    const token = getStoredToken();
    if (!token) {
      throw new Error("No GitHub token set.");
    }
    const api = `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.name}`;
    const baseHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const gh = async (path, options = {}) => {
      const response = await fetch(`${api}${path}`, {
        ...options,
        headers: { ...baseHeaders, ...(options.headers || {}) },
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(`GitHub ${path} -> ${response.status}${detail?.message ? ` (${detail.message})` : ""}`);
      }
      return response.json();
    };

    const ref = await gh(`/git/ref/heads/${GITHUB_REPO.branch}`);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await gh(`/git/commits/${baseCommitSha}`);
    const blob = await gh(`/git/blobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(payload, null, 2), encoding: "utf-8" }),
    });
    const tree = await gh(`/git/trees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [{ path: GITHUB_SYNC_PATH, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    });
    const commit = await gh(`/git/commits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Publish giveaway sync from collector", tree: tree.sha, parents: [baseCommitSha] }),
    });
    await gh(`/git/refs/heads/${GITHUB_REPO.branch}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha }),
    });
  }

  function getUserRecords(container) {
    const results = [];
    const seen = new Set();
    for (const link of container.querySelectorAll('a[href*="/user/"]')) {
      const href = link.getAttribute("href") || "";
      if (!/\/user\/[^/]+/.test(href)) {
        continue;
      }
      const username = normalizeText(link.textContent || "");
      if (!username || seen.has(username)) {
        continue;
      }
      seen.add(username);
      results.push({
        username,
        profileUrl: new URL(href, window.location.origin).href,
      });
    }
    return results;
  }

  function getCreatorRecord(container) {
    const creatorLink = getCreatorLink(container);
    if (creatorLink) {
      return {
        username: normalizeText(creatorLink.textContent || ""),
        profileUrl: new URL(creatorLink.getAttribute("href") || "", window.location.origin).href,
      };
    }
    return getUserRecords(container)[0] || null;
  }

  function getWinnerRecords(container, creator) {
    const creatorLink = getCreatorLink(container);
    const winners = [];
    const seen = new Set();

    for (const link of container.querySelectorAll('a[href*="/user/"]')) {
      if (creatorLink && link === creatorLink) {
        continue;
      }
      const href = link.getAttribute("href") || "";
      if (!/\/user\/[^/]+/.test(href)) {
        continue;
      }
      const username = normalizeText(link.textContent || "");
      if (!username || username === creator?.username || seen.has(username)) {
        continue;
      }
      seen.add(username);
      winners.push({
        username,
        profileUrl: new URL(href, window.location.origin).href,
      });
    }

    return winners;
  }

  function getCreatorContainer(container) {
    return Array.from(container.querySelectorAll(".giveaway__heading__thin")).find((node) =>
      /\bby\b/i.test(normalizeText(node.textContent || "")),
    ) || null;
  }

  function getCreatorLink(container) {
    const creatorContainer = getCreatorContainer(container);
    if (!creatorContainer) {
      return null;
    }

    const creatorLinks = Array.from(creatorContainer.querySelectorAll('a[href*="/user/"]')).filter((link) =>
      /\/user\/[^/]+/.test(link.getAttribute("href") || ""),
    );
    if (!creatorLinks.length) {
      return null;
    }
    if (creatorLinks.length === 1) {
      return creatorLinks[0];
    }

    const html = creatorContainer.innerHTML;
    for (const link of creatorLinks) {
      const username = escapeRegex(normalizeText(link.textContent || ""));
      if (new RegExp(`\\bby\\b[\\s\\S]{0,80}>\\s*${username}\\s*<\\/a>`, "i").test(html)) {
        return link;
      }
    }

    return creatorLinks[creatorLinks.length - 1];
  }

  function extractAppInfo(container) {
    const storeLink = container.querySelector('a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]');
    if (storeLink) {
      const appMatch = storeLink.href.match(/\/(?:app|sub)\/(\d+)/);
      return {
        appId: appMatch ? Number(appMatch[1]) : null,
        steamAppUrl: storeLink.href,
      };
    }

    const html = container.outerHTML;
    const appMatch = html.match(/\/steam\/apps\/(\d+)\//i) || html.match(/\/apps\/(\d+)\//i);
    return {
      appId: appMatch ? Number(appMatch[1]) : null,
      steamAppUrl: appMatch ? `https://store.steampowered.com/app/${appMatch[1]}/` : "",
    };
  }

  function buildSteamMediaUrls(appId) {
    if (!appId) {
      return {
        headerImageUrl: "",
        capsuleImageUrl: "",
        capsuleSmallUrl: "",
      };
    }

    return {
      headerImageUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
      capsuleImageUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
      capsuleSmallUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_184x69.jpg`,
    };
  }

  function buildSteamStoreUrl(appId, packageId) {
    if (appId) {
      return `https://store.steampowered.com/app/${appId}?utm_source=SteamGifts`;
    }
    if (packageId) {
      return `https://store.steampowered.com/sub/${packageId}?utm_source=SteamGifts`;
    }
    return "";
  }

  function mergeGiveawayWithExisting(giveaway, existingGiveaway) {
    if (!existingGiveaway) {
      return giveaway;
    }

    // The server resolves /sub/ (package) giveaways to their base game app id
    // (data/steam-package-cache.json); the collector only ever sees the sub id
    // on the SteamGifts page, so keep the resolved appId or every publish would
    // revert it (wrong image, no HLTB/achievements until the next daily run).
    const resolvedPackageFields = existingGiveaway.packageId
      ? {
          appId: existingGiveaway.appId,
          ...(existingGiveaway.packageAppIds ? { packageAppIds: existingGiveaway.packageAppIds } : {}),
        }
      : {};

    return {
      ...existingGiveaway,
      ...giveaway,
      ...resolvedPackageFields,
      giveawayKind:
        typeof giveaway.giveawayKind === "string" && giveaway.giveawayKind
          ? giveaway.giveawayKind
          : existingGiveaway.giveawayKind || "",
      giveawayKindChecked:
        giveaway.giveawayKindChecked !== undefined
          ? giveaway.giveawayKindChecked
          : Boolean(existingGiveaway.giveawayKindChecked),
      entryUsers: Array.isArray(giveaway.entryUsers)
        ? giveaway.entryUsers
        : Array.isArray(existingGiveaway.entryUsers)
          ? existingGiveaway.entryUsers
          : undefined,
      entriesFinalized:
        giveaway.entriesFinalized !== undefined
          ? Boolean(giveaway.entriesFinalized)
          : Boolean(existingGiveaway.entriesFinalized),
      entriesSnapshotAt: giveaway.entriesSnapshotAt || existingGiveaway.entriesSnapshotAt || "",
      startDate: giveaway.startDate || existingGiveaway.startDate || null,
    };
  }

  function getGiveawayDescriptionText(doc) {
    const description =
      doc.querySelector(".page__description .markdown") ||
      doc.querySelector(".page__description") ||
      doc.querySelector(".markdown");
    return normalizeText(description?.textContent || "");
  }

  function detectGiveawayKindFromDescription(descriptionText) {
    const text = normalizeText(descriptionText || "");
    if (/\bsummer event\b/i.test(text)) {
      return "summer_event";
    }
    const matches = [
      { kind: "pop_free", index: text.search(/\bpop free\b/i) },
      { kind: "penalty", index: text.search(/\bpenalty\b/i) },
      { kind: "extra", index: text.search(/\bextra\b/i) },
      { kind: "cycle", index: text.search(/\bmonthly\b/i) },
    ].filter((match) => match.index >= 0);

    if (!matches.length) {
      return "";
    }

    matches.sort((left, right) => left.index - right.index);
    return matches[0].kind;
  }

  function detectPenaltyForCode(descriptionText) {
    // Penalty giveaways read "Penalty GA - <link>" where the link is the won
    // giveaway being paid for; capture its 5-char code.
    const match = String(descriptionText || "").match(/\/giveaway\/([A-Za-z0-9]{5})(?:[/?#]|\b)/);
    return match ? match[1] : "";
  }

  const MONTH_NAME_TO_NUMBER = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sept: 9,
    sep: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };

  function detectGiveawayMonthOverride(descriptionText, referenceDate, giveawayKind) {
    // Untagged giveaways default to cycle, so still read a month from their
    // description (e.g. "April giveaway"). Only skip explicit non-cycle kinds.
    const normalizedKind = String(giveawayKind || "").trim().toLowerCase();
    if (normalizedKind && normalizedKind !== "cycle") {
      return "";
    }

    const text = normalizeText(descriptionText || "");
    if (!text) {
      return "";
    }

    const months = Array.from(
      new Set(
        Array.from(
          text.matchAll(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/gi),
        )
          .map((match) => MONTH_NAME_TO_NUMBER[String(match[1] || "").toLowerCase()])
          .filter((monthNumber) => Number.isInteger(monthNumber)),
      ),
    );
    if (months.length !== 1) {
      return "";
    }

    const reference = referenceDate ? new Date(referenceDate) : new Date();
    if (Number.isNaN(reference.getTime())) {
      return "";
    }

    const targetMonth = months[0];
    const referenceMonth = reference.getUTCMonth() + 1;
    let targetYear = reference.getUTCFullYear();
    if (targetMonth - referenceMonth >= 6) {
      targetYear -= 1;
    } else if (targetMonth - referenceMonth <= -6) {
      targetYear += 1;
    }

    return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  }

  function isSummerEventKind(kind) {
    const value = String(kind || "").trim().toLowerCase();
    return value === "summer_event" || value === "summer-event" || value === "summer event";
  }

  function isGiveawayEnded(giveaway) {
    return Boolean(giveaway?.endDate && new Date(giveaway.endDate).getTime() <= Date.now());
  }

  function shouldRefreshSummerEventEntries(giveaway) {
    return Boolean(giveaway?.url) && isSummerEventKind(giveaway?.giveawayKind) && !hasCompletedSummerEventEntryTracking(giveaway);
  }

  function hasCompletedSummerEventEntryTracking(giveaway) {
    const resultStatus = String(giveaway?.resultStatus || "").trim().toLowerCase();
    return isSummerEventKind(giveaway?.giveawayKind)
      && (resultStatus === "no_winners" || (Boolean(giveaway?.entriesFinalized) && resultStatus === "won"));
  }

  function canReuseSummerEventMetadata(giveaway) {
    return isSummerEventKind(giveaway?.giveawayKind)
      && Boolean(giveaway?.appId)
      && Boolean(giveaway?.giveawayKindChecked)
      && Number(giveaway?.points || 0) > 0;
  }

  function isEntriesPageUrl(url) {
    try {
      return /\/entries(?:\/search)?$/.test(new URL(url, window.location.origin).pathname);
    } catch {
      return false;
    }
  }

  function extractSteamMedia(container, appId) {
    const fallback = buildSteamMediaUrls(appId);
    const imageCandidates = Array.from(container.querySelectorAll("img"))
      .map((image) => image.getAttribute("src") || image.getAttribute("data-src") || "")
      .filter(Boolean);
    const html = container.outerHTML;
    const htmlMatches = Array.from(
      html.matchAll(/https?:\/\/[^"' )]+(?:header|capsule_[^"' )]+)\.(?:jpg|png|webp)/gi),
    ).map((match) => match[0]);
    const candidates = [...imageCandidates, ...htmlMatches];

    return {
      headerImageUrl:
        candidates.find((value) => /\/header\.(?:jpg|png|webp)/i.test(value)) || fallback.headerImageUrl,
      capsuleImageUrl:
        candidates.find((value) => /\/capsule_(?:616x353|467x181|460x215)\.(?:jpg|png|webp)/i.test(value)) ||
        fallback.capsuleImageUrl,
      capsuleSmallUrl:
        candidates.find((value) => /\/capsule_(?:231x87|184x69|120x45)\.(?:jpg|png|webp)/i.test(value)) ||
        fallback.capsuleSmallUrl,
    };
  }

  function extractPointCost(container, title = "") {
    if (!container) {
      return 0;
    }

    const directPointText = normalizeText(
      container.querySelector(".giveaway__heading__thin, .featured__heading__small")?.textContent || "",
    );
    const directMatch = directPointText.match(/\((\d+)P\)/i);
    if (directMatch) {
      return Number(directMatch[1]) || 0;
    }

    const normalizedTitle = normalizeText(title);
    const text = normalizeText(container.textContent || "");
    if (normalizedTitle) {
      const titleMatch = text.match(new RegExp(`${escapeRegex(normalizedTitle)}\\s*\\((\\d+)P\\)`, "i"));
      if (titleMatch) {
        return Number(titleMatch[1]) || 0;
      }
    }

    return 0;
  }

  function extractWinnerInfo(rowText, primaryUser, secondaryUsers, endTimestamp) {
    const ended = Boolean(endTimestamp && endTimestamp <= Date.now());

    if (!ended || /remaining/i.test(rowText)) {
      return { winners: [], resultStatus: "open", resultLabel: "Open" };
    }
    if (/awaiting feedback/i.test(rowText)) {
      return { winners: [], resultStatus: "awaiting_feedback", resultLabel: "Awaiting feedback" };
    }
    if (/no winners/i.test(rowText)) {
      return { winners: [], resultStatus: "no_winners", resultLabel: "No winners" };
    }
    if (primaryUser) {
      return {
        winners: [
          {
            username: primaryUser.username,
            profileUrl: primaryUser.profileUrl,
            status: "Won",
          },
        ],
        resultStatus: "won",
        resultLabel: primaryUser.username,
      };
    }
    if (secondaryUsers.length) {
      return {
        winners: secondaryUsers.map((winner) => ({
          username: winner.username,
          profileUrl: winner.profileUrl,
          status: "Won",
        })),
        resultStatus: "won",
        resultLabel: secondaryUsers.map((winner) => winner.username).join(", "),
      };
    }
    return { winners: [], resultStatus: "unknown", resultLabel: "" };
  }

  function resolveCreatorRecord(primaryUser, secondaryUsers, resultStatus) {
    if (resultStatus === "won") {
      return secondaryUsers[0] || primaryUser || null;
    }
    return primaryUser || secondaryUsers[0] || null;
  }

  function mergeMembersWithGiveawayUsers(members, giveaways) {
    const byUsername = new Map(
      members
        .filter((member) => member && member.username)
        .map((member) => [member.username, { ...member, isActiveMember: Boolean(member.isActiveMember) }]),
    );

    for (const giveaway of giveaways) {
      if (giveaway.creatorUsername && !byUsername.has(giveaway.creatorUsername)) {
        byUsername.set(giveaway.creatorUsername, {
          username: giveaway.creatorUsername,
          profileUrl: giveaway.creatorProfileUrl || "",
          steamProfile: "",
          isActiveMember: false,
        });
      }
      for (const winner of giveaway.winners || []) {
        if (!winner.username || byUsername.has(winner.username)) {
          continue;
        }
        byUsername.set(winner.username, {
          username: winner.username,
          profileUrl: winner.profileUrl || "",
          steamProfile: "",
          isActiveMember: false,
        });
      }
    }

    return Array.from(byUsername.values()).sort((left, right) => left.username.localeCompare(right.username));
  }

  function needsGiveawayDetails(giveaway) {
    const ended = isGiveawayEnded(giveaway);
    return (
      !giveaway.appId ||
      !giveaway.giveawayKindChecked ||
      shouldRefreshSummerEventEntries(giveaway) ||
      (ended && ["open", "awaiting_feedback", "unknown"].includes(String(giveaway.resultStatus || "")))
    );
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function enrichGiveaway(giveaway) {
    const shouldLoadDetails = !canReuseSummerEventMetadata(giveaway);
    const doc = shouldLoadDetails ? await fetchDocument(giveaway.url) : null;
    const featureMap = doc ? parseFeatureMap(doc) : {};
    const descriptionText = doc ? getGiveawayDescriptionText(doc) : "";
    const detectedGiveawayKind = doc ? detectGiveawayKindFromDescription(descriptionText) : "";
    const storeLink = doc
      ? doc.querySelector('a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]')
      : null;
    const appMatch = storeLink ? storeLink.href.match(/\/(?:app|sub)\/(\d+)/) : null;
    const timestamps = doc ? Array.from(doc.querySelectorAll("[data-timestamp]")) : [];
    const endTimestamp = timestamps.length
      ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
      : null;
    const appId = appMatch ? Number(appMatch[1]) : giveaway.appId || null;
    const media = doc ? extractSteamMedia(doc.body, appId) : {
      headerImageUrl: giveaway.headerImageUrl || "",
      capsuleImageUrl: giveaway.capsuleImageUrl || "",
      capsuleSmallUrl: giveaway.capsuleSmallUrl || "",
    };
    const resolvedEndDate = giveaway.endDate || (endTimestamp ? new Date(endTimestamp).toISOString() : null);
    const resolvedGiveawayKind = detectedGiveawayKind || giveaway.giveawayKind || "";
    const giveawayMonthOverride = doc ? detectGiveawayMonthOverride(descriptionText, resolvedEndDate, resolvedGiveawayKind) : "";
    // The group list row already shows the winner, so reuse it and skip the extra
    // /winners request when it's a confident win; only fetch when the row was
    // ambiguous (no winner detected on the list).
    const rowWinners = Array.isArray(giveaway.winners) ? giveaway.winners : [];
    const rowConfidentWin =
      String(giveaway.resultStatus || "").trim().toLowerCase() === "won" && rowWinners.length > 0;
    const winners = rowConfidentWin ? rowWinners : await fetchWinners(giveaway.url);
    const resolvedResultStatus = winners.length
      ? "won"
      : String(giveaway.resultStatus || "").trim().toLowerCase();
    const resolvedResultLabel = winners.length
      ? winners.map((winner) => winner.username).join(", ")
      : giveaway.resultLabel || "";
    const entrySnapshot = isSummerEventKind(resolvedGiveawayKind) && !hasCompletedSummerEventEntryTracking({
      ...giveaway,
      giveawayKind: resolvedGiveawayKind,
      resultStatus: resolvedResultStatus,
    })
      ? await fetchGiveawayEntries(giveaway.url)
      : null;
    const hasTrackedWinnerEntries = Boolean(entrySnapshot?.users?.length);
    const hasPersistedWinnerEntries = Array.isArray(giveaway.entryUsers) && giveaway.entryUsers.length > 0;
    const shouldKeepWinnerSnapshot = resolvedResultStatus !== "won" || hasTrackedWinnerEntries;

    return {
      ...giveaway,
      appId,
      steamAppUrl: storeLink ? storeLink.href : giveaway.steamAppUrl || "",
      headerImageUrl: media.headerImageUrl || giveaway.headerImageUrl || "",
      capsuleImageUrl: media.capsuleImageUrl || giveaway.capsuleImageUrl || "",
      capsuleSmallUrl: media.capsuleSmallUrl || giveaway.capsuleSmallUrl || "",
      entriesCount: parseInt(String(featureMap.Entries || "").replace(/[^\d]/g, ""), 10) || giveaway.entriesCount || 0,
      points:
        extractPointCost(
          doc ? doc.querySelector(".featured__heading, .featured__summary, .featured__container, .featured__outer-wrap") : null,
          giveaway.title,
        ) || Number(giveaway.points || 0),
      endDate: resolvedEndDate,
      regionRestricted: /region/i.test(String(featureMap.Type || "")),
      giveawayKind: resolvedGiveawayKind,
      giveawayMonthOverride,
      penaltyForCode:
        resolvedGiveawayKind === "penalty"
          ? detectPenaltyForCode(descriptionText) || giveaway.penaltyForCode || ""
          : giveaway.penaltyForCode || "",
      giveawayKindChecked: true,
      resultStatus: resolvedResultStatus,
      resultLabel: resolvedResultLabel,
      entryUsers:
        shouldKeepWinnerSnapshot && entrySnapshot
          ? entrySnapshot.users
          : Array.isArray(giveaway.entryUsers)
            ? giveaway.entryUsers
            : undefined,
      entriesFinalized:
        resolvedResultStatus === "no_winners"
        || (resolvedResultStatus === "won" && (hasTrackedWinnerEntries || (Boolean(giveaway.entriesFinalized) && hasPersistedWinnerEntries))),
      entriesSnapshotAt:
        shouldKeepWinnerSnapshot && entrySnapshot
          ? entrySnapshot.capturedAt
          : resolvedResultStatus === "won"
            ? ""
            : giveaway.entriesSnapshotAt || "",
      winners,
    };
  }

  async function fetchGiveawayEntries(giveawayUrl) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= 100; page += 1) {
      const url = page === 1 ? `${giveawayUrl}/entries` : `${giveawayUrl}/entries/search?page=${page}`;
      const response = await fetchDocumentResponse(url);
      if (!isEntriesPageUrl(response.finalUrl)) {
        return null;
      }
      const doc = response.doc;
      const rows = Array.from(doc.querySelectorAll(".table__row-inner-wrap"));
      if (!rows.length) {
        break;
      }

      let foundAny = false;
      for (const row of rows) {
        const userLink = Array.from(row.querySelectorAll('a[href*="/user/"]')).find((anchor) =>
          /\/user\/[^/]+/.test(anchor.getAttribute("href") || "")
          && normalizeText(anchor.textContent || ""),
        );
        if (!userLink) {
          continue;
        }
        const username = normalizeText(userLink.textContent || "");
        if (!username || seen.has(username)) {
          continue;
        }
        seen.add(username);
        results.push(username);
        foundAny = true;
      }

      if (!foundAny) {
        break;
      }
    }

    return {
      users: results,
      capturedAt: new Date().toISOString(),
    };
  }

  async function fetchWinners(giveawayUrl) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= 100; page += 1) {
      const url = `${giveawayUrl}/winners/search?page=${page}`;
      const doc = await fetchDocument(url);
      const rows = Array.from(doc.querySelectorAll(".table__row-inner-wrap"));
      if (!rows.length) {
        break;
      }

      let foundAny = false;
      for (const row of rows) {
        const userLink = Array.from(row.querySelectorAll('a[href*="/user/"]')).find((anchor) =>
          /\/user\/[^/]+/.test(anchor.getAttribute("href") || "")
          && normalizeText(anchor.textContent || ""),
        );
        if (!userLink) {
          continue;
        }
        const username = userLink.textContent.trim();
        if (!username || seen.has(username)) {
          continue;
        }
        seen.add(username);
        results.push({
          username,
          profileUrl: new URL(userLink.href, window.location.origin).href,
          status: row.lastElementChild ? row.lastElementChild.textContent.trim() : "",
        });
        foundAny = true;
      }

      if (!foundAny) {
        break;
      }
    }

    return results;
  }

  function parseFeatureMap(doc) {
    const labels = Array.from(doc.querySelectorAll(".featured__table__row__left"));
    const map = {};
    for (const label of labels) {
      const key = label.textContent.trim();
      const value = label.nextElementSibling ? label.nextElementSibling.textContent.trim() : "";
      map[key] = value;
    }
    return map;
  }

  async function fetchDocumentResponse(url) {
    for (let attempt = 0; ; attempt += 1) {
      // Global pacer: hold a minimum gap between every request once throttling
      // is on (covers detail pages, winners, and each entries/winners page).
      if (requestGapMs > 0) {
        const wait = requestGapMs - (Date.now() - lastRequestAt);
        if (wait > 0) {
          await delay(wait);
        }
      }
      lastRequestAt = Date.now();

      const response = await fetch(url, { credentials: "include" });
      if (response.status === 429) {
        // Hit the limit: pace every request from now on, wait, then retry.
        requestGapMs = Math.max(requestGapMs, PACED_REQUEST_GAP_MS);
        if (attempt < RATE_LIMIT_MAX_RETRIES) {
          log(
            `Rate limited (429). Pacing requests and waiting ${Math.round(RATE_LIMIT_BACKOFF_MS / 1000)}s before retry...`,
          );
          await delay(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
      }
      if (!response.ok) {
        throw new Error(`Could not load ${url} (${response.status})`);
      }
      const html = await response.text();
      return {
        doc: new DOMParser().parseFromString(html, "text/html"),
        finalUrl: response.url || url,
      };
    }
  }

  async function fetchDocument(url) {
    const response = await fetchDocumentResponse(url);
    return response.doc;
  }

  // Existence check for a giveaway detail page. A deleted SteamGifts giveaway
  // does NOT 404 — the page still loads (HTTP 200) but drops the live
  // ".featured__heading" block and renders a "Deleted <when> by <whom>" notice
  // instead. Confirm deletion only when BOTH hold: no live heading AND the
  // notice text. That way a transient/error page (heading missing but no notice)
  // or a live page that merely mentions the phrase in a comment is never
  // misread, and a failed fetch returns "unknown" so a live giveaway is never
  // tombstoned. Reuses fetchDocumentResponse for the shared pacer + 429 retry.
  async function probeGiveawayDeleted(url) {
    let doc;
    try {
      doc = (await fetchDocumentResponse(url)).doc;
    } catch (error) {
      return "unknown";
    }
    const hasLiveHeading = Boolean(doc.querySelector(".featured__heading"));
    const hasDeletionNotice = /\bDeleted\b[\s\S]{0,60}\bby\b/i.test(doc.body ? doc.body.textContent || "" : "");
    if (!hasLiveHeading && hasDeletionNotice) {
      return "deleted";
    }
    return hasLiveHeading ? "exists" : "unknown";
  }

  function log(message) {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    state.log.prepend(line);
  }
})();
