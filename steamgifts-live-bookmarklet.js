(()=> {
  "use strict";

  const groupMatch = window.location.pathname.match(/(\/group\/[^/]+\/[^/]+)/);
  if (!groupMatch) {
    window.alert("Open the SteamGifts Akatsuki group page first.");
    return;
  }

  const groupBase = `${window.location.origin}${groupMatch[1]}`;
  const LOCAL_SERVER_URL = "http://127.0.0.1:4173/api/steamgifts-sync";
  const SETTINGS = {
    memberPages: 2,
    giveawayPages: 1,
    winnerPages: 1,
    delayMs: 505,
    localServerTimeoutMs: 4000,
    localServerPostTimeoutMs: 15000,
    retryDelayMs: 8000,
    maxRetries: 3,
  };
  const state = {
    running: false,
    panel: null,
    log: null,
  };

  addPanel();
  runSync();

  function addPanel() {
    const existing = document.getElementById("akatsuki-live-sync-panel");
    if (existing) {
      existing.remove();
    }
    const panel = document.createElement("div");
    panel.id = "akatsuki-live-sync-panel";
    panel.style.position = "fixed";
    panel.style.right = "18px";
    panel.style.bottom = "18px";
    panel.style.zIndex = "99999";
    panel.style.width = "340px";
    panel.style.padding = "14px";
    panel.style.borderRadius = "16px";
    panel.style.background = "rgba(15, 17, 21, 0.96)";
    panel.style.border = "1px solid rgba(110, 168, 254, 0.35)";
    panel.style.boxShadow = "0 18px 45px rgba(0,0,0,.35)";
    panel.style.color = "#f4f7fb";
    panel.innerHTML = `
      <div style="display:grid;gap:10px;">
        <strong>Akatsuki Live Sync</strong>
        <div id="akatsuki-live-sync-log" style="font-size:12px;line-height:1.5;color:#c7d2e2;max-height:220px;overflow:auto;"></div>
      </div>
    `;
    document.body.appendChild(panel);
    state.panel = panel;
    state.log = panel.querySelector("#akatsuki-live-sync-log");
  }

  async function runSync() {
    if (state.running) {
      log("A sync is already running.");
      return;
    }
    configureRun();
    state.running = true;
    try {
      log("Loading existing local sync...");
      const existingSync = await loadExistingSync();
      log("Reading group members...");
      const members = await collectMembers(existingSync);
      log(`Members found: ${members.length}`);

      log("Reading group giveaways...");
      const giveaways = await collectGiveaways(existingSync);
      log(`Giveaways found: ${giveaways.length}`);

      const pendingGiveaways = getPendingGiveawaysToRefresh(existingSync, giveaways);
      if (pendingGiveaways.length) {
        log(`Refreshing ${pendingGiveaways.length} unresolved giveaway(s) from earlier pages...`);
      }

      let detailedGiveaways = giveaways;
      const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
      const followUpGiveaways = [...unresolvedGiveaways, ...pendingGiveaways];
      if (followUpGiveaways.length) {
        log(`Resolving ${followUpGiveaways.length} giveaway(s) missing app, winner, or label data...`);
        const resolvedGiveaways = new Map();
        for (const [index, giveaway] of followUpGiveaways.entries()) {
          log(`Resolving giveaway ${index + 1}/${followUpGiveaways.length}: ${giveaway.title}`);
          resolvedGiveaways.set(giveaway.code, await enrichGiveaway(giveaway));
        }
        detailedGiveaways = [
          ...giveaways.map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway),
          ...pendingGiveaways
            .map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway)
            .filter((giveaway) => !giveaways.some((current) => current.code === giveaway.code)),
        ];
      }
      const mergedMembers = mergeMembersWithGiveawayUsers(members, detailedGiveaways);

      const payload = {
        source: "akatsuki-steamgifts-sync",
        syncedAt: new Date().toISOString(),
        group: {
          url: groupBase,
          name: document.title.replace(/\s*\|\s*SteamGifts.*/, "").trim() || "Akatsuki",
        },
        members: mergedMembers,
        giveaways: detailedGiveaways,
      };
      payload.wins = detailedGiveaways.flatMap((giveaway) =>
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

      await postToLocalServer(payload);
      log("Sync finished and saved to the local dashboard.");
      log(`Batch saved. Next time, try giveaway page ${SETTINGS.giveawayPages + 1}.`);
    } catch (error) {
      log(`Sync failed: ${error.message}`);
    } finally {
      state.running = false;
    }
  }

  function configureRun() {
    SETTINGS.giveawayPages = Math.max(
      1,
      parseInt(window.prompt("How many giveaway pages should this run fetch?", String(SETTINGS.giveawayPages)), 10) ||
        SETTINGS.giveawayPages,
    );
    log(`Configured: giveaway pages 1-${SETTINGS.giveawayPages}, delay ${SETTINGS.delayMs}ms.`);
  }

  async function collectMembers(existingSync) {
    const results = [];
    const seen = new Set();
    const cachedProfiles = new Map(
      (existingSync?.members || [])
        .filter((member) => member?.username)
        .map((member) => [member.username, member.steamProfile || ""]),
    );
    for (let page = 1; page <= SETTINGS.memberPages; page += 1) {
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

  async function collectGiveaways(existingSync) {
    const results = [];
    const seen = new Set();
    const existingGiveaways = new Map(
      (existingSync?.giveaways || []).filter((giveaway) => giveaway?.code).map((giveaway) => [giveaway.code, giveaway]),
    );
    const startPage = 1;
    const endPage = SETTINGS.giveawayPages;
    for (let page = startPage; page <= endPage; page += 1) {
      let pageResults = [];
      try {
        pageResults = await fetchGiveawayPageJson(page, existingGiveaways);
      } catch (error) {
        const url = page === 1 ? groupBase : `${groupBase}/search?page=${page}`;
        const doc = await fetchDocument(url);
        pageResults = parseGiveawayRows(doc, existingGiveaways);
      }
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
    const rows = Array.from(doc.querySelectorAll(".giveaway__row-inner-wrap, .table__row-inner-wrap"));
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
      const primaryUser = getCreatorRecord(row);
      const secondaryUsers = getWinnerRecords(row, primaryUser);
      const rowText = normalizeText(row.textContent || "");
      const entryLink = Array.from(row.querySelectorAll('a[href$="/entries"]')).find(Boolean);
      const timestamps = Array.from(row.querySelectorAll("[data-timestamp]"));
      const endTimestamp = timestamps.length
        ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
        : null;
      const { appId, steamAppUrl } = extractAppInfo(row);
      const winnerInfo = extractWinnerInfo(rowText, primaryUser, secondaryUsers, endTimestamp);
      const creator = resolveCreatorRecord(primaryUser, secondaryUsers, winnerInfo.resultStatus);
      results.push(mergeGiveawayWithExisting({
        code: codeMatch[1],
        url: giveawayLink.href,
        title: giveawayLink.textContent.trim(),
        creatorUsername: creator ? creator.username : "",
        creatorProfileUrl: creator ? creator.profileUrl : "",
        appId,
        steamAppUrl,
        entriesCount: entryLink ? parseInt(entryLink.textContent.replace(/[^\d]/g, ""), 10) || 0 : 0,
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
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SETTINGS.localServerTimeoutMs);
    try {
      const response = await fetch(LOCAL_SERVER_URL, { signal: controller.signal });
      if (!response.ok) {
        return {};
      }
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") {
        log("Local sync read timed out; continuing without cached sync.");
        return {};
      }
      return {};
    } finally {
      window.clearTimeout(timeoutId);
    }
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
    const ended = Boolean(giveaway.endDate && new Date(giveaway.endDate).getTime() <= Date.now());
    return (
      !giveaway.appId ||
      !giveaway.giveawayKindChecked ||
      (ended && ["open", "awaiting_feedback", "unknown"].includes(String(giveaway.resultStatus || "")))
    );
  }

  function getPendingGiveawaysToRefresh(existingSync, currentGiveaways) {
    const currentCodes = new Set(currentGiveaways.map((giveaway) => giveaway.code));
    const maxAgeMs = 120 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return (existingSync?.giveaways || []).filter((giveaway) => {
      if (!giveaway?.code || currentCodes.has(giveaway.code) || !giveaway.url) {
        return false;
      }
      if (!["open", "awaiting_feedback", "unknown"].includes(giveaway.resultStatus)) {
        return false;
      }
      if (!giveaway.endDate) {
        return true;
      }
      return Math.abs(now - new Date(giveaway.endDate).getTime()) <= maxAgeMs;
    });
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    return {
      ...existingGiveaway,
      ...giveaway,
      giveawayKind:
        typeof giveaway.giveawayKind === "string" && giveaway.giveawayKind
          ? giveaway.giveawayKind
          : existingGiveaway.giveawayKind || "",
      giveawayKindChecked:
        giveaway.giveawayKindChecked !== undefined
          ? giveaway.giveawayKindChecked
          : Boolean(existingGiveaway.giveawayKindChecked),
    };
  }

  function buildGiveawayFromJsonRecord(record, existingGiveaway) {
    const giveawayUrl = String(record?.link || "");
    const codeMatch = giveawayUrl.match(/\/giveaway\/([^/]+)\//);
    if (!codeMatch) {
      return null;
    }

    const appId = Number(record?.app_id || 0) || null;
    const packageId = Number(record?.package_id || 0) || null;
    const endTimestamp = Number(record?.end_timestamp || 0) * 1000;
    return mergeGiveawayWithExisting(
      {
        code: codeMatch[1],
        url: giveawayUrl,
        title: normalizeText(record?.name || ""),
        creatorUsername: normalizeText(record?.creator?.username || ""),
        creatorProfileUrl: record?.creator?.username
          ? `https://www.steamgifts.com/user/${encodeURIComponent(record.creator.username)}`
          : "",
        appId,
        steamAppUrl: buildSteamStoreUrl(appId, packageId),
        entriesCount: Number(record?.entry_count || 0),
        endDate: endTimestamp ? new Date(endTimestamp).toISOString() : null,
        winners: existingGiveaway?.winners || [],
        resultStatus: endTimestamp && endTimestamp <= Date.now() ? existingGiveaway?.resultStatus || "unknown" : "open",
        resultLabel: endTimestamp && endTimestamp <= Date.now() ? existingGiveaway?.resultLabel || "" : "Open",
        points: Number(record?.points || 0),
        regionRestricted: Boolean(record?.region_restricted),
      },
      existingGiveaway,
    );
  }

  async function fetchGiveawayPageJson(pageNumber, existingGiveaways = new Map()) {
    const url = new URL(groupBase);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("format", "json");

    const response = await fetch(url.href, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Could not load ${url.href} (${response.status})`);
    }

    const payload = await response.json().catch(() => null);
    if (!payload?.success || !Array.isArray(payload.results)) {
      throw new Error(`Invalid JSON payload for ${url.href}`);
    }

    return payload.results
      .map((record) => buildGiveawayFromJsonRecord(record, existingGiveaways.get(String(record?.link || "").match(/\/giveaway\/([^/]+)\//)?.[1] || "")))
      .filter(Boolean);
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
    const matches = [
      { kind: "extra", index: text.search(/\bextra\b/i) },
      { kind: "extra", index: text.search(/\bpenalty\b/i) },
      { kind: "cycle", index: text.search(/\bmonthly\b/i) },
    ].filter((match) => match.index >= 0);

    if (!matches.length) {
      return "";
    }

    matches.sort((left, right) => left.index - right.index);
    return matches[0].kind;
  }

  async function enrichGiveaway(giveaway) {
    const doc = await fetchDocument(giveaway.url);
    const featureMap = parseFeatureMap(doc);
    const descriptionText = getGiveawayDescriptionText(doc);
    const detectedGiveawayKind = detectGiveawayKindFromDescription(descriptionText);
    const storeLink = doc.querySelector('a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]');
    const appMatch = storeLink ? storeLink.href.match(/\/(?:app|sub)\/(\d+)/) : null;
    const timestamps = Array.from(doc.querySelectorAll("[data-timestamp]"));
    const endTimestamp = timestamps.length
      ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
      : null;
    return {
      ...giveaway,
      appId: appMatch ? Number(appMatch[1]) : null,
      steamAppUrl: storeLink ? storeLink.href : "",
      entriesCount:
        giveaway.entriesCount ||
        parseInt(String(featureMap.Entries || "").replace(/[^\d]/g, ""), 10) ||
        0,
      points: parseInt(String(featureMap.Points || "").replace(/[^\d]/g, ""), 10) || 0,
      endDate: giveaway.endDate || (endTimestamp ? new Date(endTimestamp).toISOString() : null),
      regionRestricted: /region/i.test(String(featureMap.Type || "")),
      giveawayKind: detectedGiveawayKind || giveaway.giveawayKind || "",
      giveawayKindChecked: true,
      winners: await fetchWinners(giveaway.url),
    };
  }

  async function fetchWinners(giveawayUrl) {
    const results = [];
    const seen = new Set();
    for (let page = 1; page <= SETTINGS.winnerPages; page += 1) {
      const url = `${giveawayUrl}/winners/search?page=${page}`;
      const doc = await fetchDocument(url);
      const rows = Array.from(doc.querySelectorAll(".table__row-inner-wrap"));
      if (!rows.length) {
        break;
      }
      let foundAny = false;
      for (const row of rows) {
        const userLink = Array.from(row.querySelectorAll('a[href*="/user/"]')).find((anchor) =>
          /\/user\/[^/]+/.test(anchor.getAttribute("href") || ""),
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

  async function fetchDocument(url) {
    await sleep(SETTINGS.delayMs + Math.floor(Math.random() * 250));
    for (let attempt = 1; attempt <= SETTINGS.maxRetries; attempt += 1) {
      const response = await fetch(url, { credentials: "include" });
      const html = await response.text();
      if (
        response.ok &&
        !/Error 1015|rate limited|temporarily banned/i.test(html)
      ) {
        return new DOMParser().parseFromString(html, "text/html");
      }
      if (attempt >= SETTINGS.maxRetries) {
        throw new Error(`Could not load ${url} without rate limiting.`);
      }
      log(`Backing off after rate-limit warning (${attempt}/${SETTINGS.maxRetries})...`);
      await sleep(SETTINGS.retryDelayMs * attempt);
    }
  }

  async function postToLocalServer(payload) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SETTINGS.localServerPostTimeoutMs);
    try {
      const response = await fetch(LOCAL_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Local server responded with ${response.status}`);
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Local server save timed out.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function log(message) {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    state.log.prepend(line);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }
})();
