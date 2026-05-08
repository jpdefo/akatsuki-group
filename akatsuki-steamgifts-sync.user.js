// ==UserScript==
// @name         Akatsuki SteamGifts Sync
// @namespace    akatsuki-monitor
// @version      1.0.0
// @description  Collect Akatsuki members, giveaways, entries and winners from the logged-in SteamGifts session and send them to the local monitor server.
// @match        https://www.steamgifts.com/group/*/*
// @match        https://www.steamgifts.com/group/*/*/users*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const groupMatch = window.location.pathname.match(/(\/group\/[^/]+\/[^/]+)/);
  if (!groupMatch) {
    return;
  }

  const groupBase = `${window.location.origin}${groupMatch[1]}`;
  const LOCAL_SERVER_URL = "http://127.0.0.1:4173/api/steamgifts-sync";
  const state = {
    running: false,
    panel: null,
    log: null,
  };

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
      <div style="display:grid;gap:10px;">
        <strong>Akatsuki Sync</strong>
        <button id="akatsuki-sync-button" style="border:0;border-radius:10px;padding:10px 12px;background:#3d7bff;color:#fff;font:inherit;font-weight:700;cursor:pointer;">Sync group</button>
        <div id="akatsuki-sync-log" style="font-size:12px;line-height:1.5;color:#c7d2e2;max-height:180px;overflow:auto;"></div>
      </div>
    `;
    document.body.appendChild(panel);
    state.panel = panel;
    state.log = panel.querySelector("#akatsuki-sync-log");
    panel.querySelector("#akatsuki-sync-button").addEventListener("click", runSync);
    log("Ready. Run it from a logged-in group session.");
  }

  async function runSync() {
    if (state.running) {
      log("A sync is already running.");
      return;
    }

    state.running = true;
    log("Reading group members...");

    try {
      const existingSync = await loadExistingSync();
      const members = await collectMembers(existingSync);
      log(`Members found: ${members.length}`);

      log("Reading group giveaways...");
      const giveaways = await collectGiveaways();
      log(`Giveaways found: ${giveaways.length}`);

      const pendingGiveaways = getPendingGiveawaysToRefresh(existingSync, giveaways);
      if (pendingGiveaways.length) {
        log(`Refreshing ${pendingGiveaways.length} unresolved giveaway(s) from earlier pages...`);
      }

      let detailedGiveaways = giveaways;
      const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
      const followUpGiveaways = [...unresolvedGiveaways, ...pendingGiveaways];
      if (followUpGiveaways.length) {
        log(`Resolving ${followUpGiveaways.length} giveaway(s) missing app or winner data...`);
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
          name: document.title.replace(/\s*\|\s*SteamGifts.*/, "").trim(),
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
      log("Sync finished and sent to the local server.");
    } catch (error) {
      log(`Falha: ${error.message}`);
    } finally {
      state.running = false;
    }
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

  async function collectGiveaways() {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= 500; page += 1) {
      const url = page === 1 ? groupBase : `${groupBase}/search?page=${page}`;
      const doc = await fetchDocument(url);
      const pageResults = parseGiveawayRows(doc);
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

  function parseGiveawayRows(doc) {
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

      results.push({
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
      });
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
    try {
      const response = await fetch(LOCAL_SERVER_URL);
      if (!response.ok) {
        return {};
      }
      return await response.json();
    } catch (error) {
      return {};
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
    return !giveaway.appId || (ended && giveaway.resultStatus === "unknown");
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

  async function enrichGiveaway(giveaway) {
    const doc = await fetchDocument(giveaway.url);
    const featureMap = parseFeatureMap(doc);
    const storeLink = doc.querySelector('a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]');
    const appMatch = storeLink ? storeLink.href.match(/\/(?:app|sub)\/(\d+)/) : null;
    const entryLink = doc.querySelector('a[href$="/entries"]');
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
      winners: await fetchWinners(giveaway.url),
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
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Could not load ${url} (${response.status})`);
    }
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function postToLocalServer(payload) {
    try {
      const response = await fetch(LOCAL_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Servidor local respondeu ${response.status}`);
      }
    } catch (error) {
      downloadFallback(payload);
      throw new Error(
        "Could not send data to the local server. The JSON file was downloaded for manual import.",
      );
    }
  }

  function downloadFallback(payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "akatsuki-steamgifts-sync.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function log(message) {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    state.log.prepend(line);
  }
})();
