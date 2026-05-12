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
  const LOCAL_SERVER_TIMEOUT_MS = 4000;
  const LOCAL_SERVER_POST_TIMEOUT_MS = 15000;
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
      const giveaways = await collectGiveaways(existingSync);
      log(`Giveaways found: ${giveaways.length}`);

      let detailedGiveaways = giveaways;
      const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
      if (unresolvedGiveaways.length) {
        log(`Resolving ${unresolvedGiveaways.length} giveaway(s) missing app, winner, or label data...`);
        const resolvedGiveaways = new Map();
        for (const [index, giveaway] of unresolvedGiveaways.entries()) {
          log(`Resolving giveaway ${index + 1}/${unresolvedGiveaways.length}: ${giveaway.title}`);
          resolvedGiveaways.set(giveaway.code, await enrichGiveaway(giveaway));
        }
        detailedGiveaways = giveaways.map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway);
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

  async function collectGiveaways(existingSync) {
    const results = [];
    const seen = new Set();
    const existingGiveaways = new Map(
      (existingSync?.giveaways || []).filter((giveaway) => giveaway?.code).map((giveaway) => [giveaway.code, giveaway]),
    );

    for (let page = 1; page <= 500; page += 1) {
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
      const endTimestamp = timestamps.length
        ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
        : null;
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
    const timeoutId = window.setTimeout(() => controller.abort(), LOCAL_SERVER_TIMEOUT_MS);
    try {
      const response = await fetch(LOCAL_SERVER_URL, { signal: controller.signal });
      if (!response.ok) {
        return {};
      }
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") {
        log("Existing sync timed out; continuing fresh.");
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
    if (String(giveawayKind || "").trim().toLowerCase() !== "cycle") {
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
    const winners = await fetchWinners(giveaway.url);
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
      giveawayMonthOverride: resolvedGiveawayKind === "cycle" ? giveawayMonthOverride : "",
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
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Could not load ${url} (${response.status})`);
    }
    const html = await response.text();
    return {
      doc: new DOMParser().parseFromString(html, "text/html"),
      finalUrl: response.url || url,
    };
  }

  async function fetchDocument(url) {
    const response = await fetchDocumentResponse(url);
    return response.doc;
  }

  async function postToLocalServer(payload) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), LOCAL_SERVER_POST_TIMEOUT_MS);
    try {
      const response = await fetch(LOCAL_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Servidor local respondeu ${response.status}`);
      }
    } catch (error) {
      downloadFallback(payload);
      if (error?.name === "AbortError") {
        throw new Error("Local server save timed out. The JSON file was downloaded for manual import.");
      }
      throw new Error(
        "Could not send data to the local server. The JSON file was downloaded for manual import.",
      );
    } finally {
      window.clearTimeout(timeoutId);
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
