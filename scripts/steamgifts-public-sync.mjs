import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = path.resolve(__dirname, "..");
const DEFAULT_GROUP_URL = "https://www.steamgifts.com/group/7Ypot/akatsukigamessteamgifts";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function waitForSteamGifts(page) {
  await page.waitForFunction(
    () => {
      const title = document.title || "";
      const text = document.body?.innerText || "";
      if (/just a moment/i.test(title) || /enable javascript and cookies to continue/i.test(text)) {
        return false;
      }
      return Boolean(
        document.querySelector('a[href*="/giveaway/"], a[href*="/group/"], .page__heading, .sidebar'),
      );
    },
    { timeout: 120000 },
  );
}

const groupUrl = readArg("--group-url", process.env.AKATSUKI_GROUP_URL || DEFAULT_GROUP_URL);
const outputPath = path.resolve(readArg("--output", path.join(BASE_DIR, "data", "steamgifts-sync.public.json")));
const existingSyncPath = path.resolve(
  readArg("--existing-sync", path.join(BASE_DIR, "data", "steamgifts-sync.json")),
);
const fullHistory = hasFlag("--full-history");
const maxGiveawayPages = Number.parseInt(readArg("--giveaway-pages", fullHistory ? "500" : "8"), 10) || 8;
const maxMemberPages = Number.parseInt(readArg("--member-pages", "25"), 10) || 25;
const requestDelayMs = Number.parseInt(readArg("--delay-ms", "600"), 10) || 600;
const existingSync = await readJson(existingSyncPath, {});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: USER_AGENT,
  viewport: { width: 1440, height: 2200 },
  locale: "en-US",
});
const page = await context.newPage();

try {
  await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForSteamGifts(page);
  const payload = await page.evaluate(
    async ({ groupUrl, existingSync, maxGiveawayPages, maxMemberPages, requestDelayMs }) => {
      const groupMatch = groupUrl.match(/(https:\/\/www\.steamgifts\.com\/group\/[^/]+\/[^/?#]+)/i);
      if (!groupMatch) {
        throw new Error(`Invalid SteamGifts group URL: ${groupUrl}`);
      }

      const groupBase = groupMatch[1];

      function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function escapeRegex(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function sleep(delayMs) {
        return new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      async function fetchDocument(url) {
        await sleep(requestDelayMs);
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`Could not load ${url} (${response.status})`);
        }
        const html = await response.text();
        return new DOMParser().parseFromString(html, "text/html");
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

      function getCreatorContainer(container) {
        return (
          Array.from(container.querySelectorAll(".giveaway__heading__thin")).find((node) =>
            /\bby\b/i.test(normalizeText(node.textContent || "")),
          ) || null
        );
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

      function extractAppInfo(container) {
        const storeLink = container.querySelector(
          'a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]',
        );
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

      function parseGiveawayRows(doc) {
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
          const media = extractSteamMedia(row, appId);
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
            headerImageUrl: media.headerImageUrl,
            capsuleImageUrl: media.capsuleImageUrl,
            capsuleSmallUrl: media.capsuleSmallUrl,
            entriesCount: entryLink ? Number.parseInt(entryLink.textContent.replace(/[^\d]/g, ""), 10) || 0 : 0,
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
          const steamLink = container.querySelector(
            'a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]',
          );
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
        const steamLink = doc.querySelector(
          'a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]',
        );
        return steamLink ? steamLink.href : "";
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

      async function enrichGiveaway(giveaway) {
        const doc = await fetchDocument(giveaway.url);
        const featureMap = parseFeatureMap(doc);
        const storeLink = doc.querySelector(
          'a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]',
        );
        const appMatch = storeLink ? storeLink.href.match(/\/(?:app|sub)\/(\d+)/) : null;
        const timestamps = Array.from(doc.querySelectorAll("[data-timestamp]"));
        const endTimestamp = timestamps.length
          ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
          : null;
        const appId = appMatch ? Number(appMatch[1]) : giveaway.appId || null;
        const media = extractSteamMedia(doc.body, appId);

        return {
          ...giveaway,
          appId,
          steamAppUrl: storeLink ? storeLink.href : giveaway.steamAppUrl || "",
          headerImageUrl: media.headerImageUrl || giveaway.headerImageUrl || "",
          capsuleImageUrl: media.capsuleImageUrl || giveaway.capsuleImageUrl || "",
          capsuleSmallUrl: media.capsuleSmallUrl || giveaway.capsuleSmallUrl || "",
          entriesCount:
            giveaway.entriesCount ||
            Number.parseInt(String(featureMap.Entries || "").replace(/[^\d]/g, ""), 10) ||
            0,
          points: Number.parseInt(String(featureMap.Points || "").replace(/[^\d]/g, ""), 10) || 0,
          endDate: giveaway.endDate || (endTimestamp ? new Date(endTimestamp).toISOString() : null),
          regionRestricted: /region/i.test(String(featureMap.Type || "")),
          winners: await fetchWinners(giveaway.url),
        };
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

      async function collectMembers(existingSync) {
        const results = [];
        const seen = new Set();
        const cachedProfiles = new Map(
          (existingSync?.members || [])
            .filter((member) => member?.username)
            .map((member) => [member.username, member.steamProfile || ""]),
        );

        for (let page = 1; page <= maxMemberPages; page += 1) {
          const url = page === 1 ? `${groupBase}/users` : `${groupBase}/users/search?page=${page}`;
          const doc = await fetchDocument(url);
          const pageMembers = parseMemberRows(doc, cachedProfiles);
          if (!pageMembers.length) {
            break;
          }

          let added = 0;
          for (const member of pageMembers) {
            if (!member.username || seen.has(member.username)) {
              continue;
            }
            results.push(member);
            seen.add(member.username);
            added += 1;
          }

          if (!added) {
            break;
          }
        }

        const missingProfiles = results.filter((member) => !member.steamProfile && member.profileUrl);
        for (const member of missingProfiles) {
          member.steamProfile = (await fetchMemberSteamProfile(member.profileUrl)) || cachedProfiles.get(member.username) || "";
        }

        return results;
      }

      async function collectGiveaways() {
        const results = [];
        const seen = new Set();

        for (let page = 1; page <= maxGiveawayPages; page += 1) {
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

      const members = await collectMembers(existingSync);
      const giveaways = await collectGiveaways();
      const pendingGiveaways = getPendingGiveawaysToRefresh(existingSync, giveaways);
      const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
      const followUpGiveaways = [...unresolvedGiveaways, ...pendingGiveaways];
      const resolvedGiveaways = new Map();

      for (const giveaway of followUpGiveaways) {
        resolvedGiveaways.set(giveaway.code, await enrichGiveaway(giveaway));
      }

      const detailedGiveaways = [
        ...giveaways.map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway),
        ...pendingGiveaways
          .map((giveaway) => resolvedGiveaways.get(giveaway.code) || giveaway)
          .filter((giveaway) => !giveaways.some((current) => current.code === giveaway.code)),
      ];
      const mergedMembers = mergeMembersWithGiveawayUsers(members, detailedGiveaways);
      const payload = {
        source: "akatsuki-steamgifts-public-sync",
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
      payload.syncStats = {
        memberPagesScanned: maxMemberPages,
        giveawayPagesScanned: maxGiveawayPages,
        unresolvedGiveawaysResolved: followUpGiveaways.length,
      };
      return payload;
    },
    { groupUrl, existingSync, maxGiveawayPages, maxMemberPages, requestDelayMs },
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `Public SteamGifts sync saved to ${outputPath} (${payload.members.length} members, ${payload.giveaways.length} giveaways).`,
  );
} finally {
  await context.close();
  await browser.close();
}
