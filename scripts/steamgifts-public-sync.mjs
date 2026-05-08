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
const CONTEXT_OPTIONS = {
  userAgent: USER_AGENT,
  viewport: { width: 1440, height: 2200 },
  locale: "en-US",
};
let navigationDelayMs = 505;
const browserChannel = readArg("--browser-channel", process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : ""));
const browserHeadless = !["0", "false", "no"].includes(
  String(readArg("--headless", process.env.BROWSER_HEADLESS || (process.platform === "win32" ? "false" : "true"))).toLowerCase(),
);
let verificationPromptShown = false;

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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

async function waitForSteamGifts(page) {
  const deadline = Date.now() + (browserHeadless ? 180000 : 900000);
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => {
        const title = document.title || "";
        const text = document.body?.innerText || "";
        return {
          title,
          text,
        };
      });
      const text = state.text || "";
      const verificationRequired =
        /just a moment/i.test(state.title || "") ||
        /enable javascript and cookies to continue/i.test(text) ||
        /performing security verification/i.test(text) ||
        /verification successful\.?\s*waiting/i.test(text) ||
        /verify you are human/i.test(text);
      if (
        !verificationRequired
      ) {
        verificationPromptShown = false;
        await page.waitForTimeout(1000);
        return;
      }

      if (!browserHeadless && verificationRequired && !verificationPromptShown) {
        verificationPromptShown = true;
        console.log(
          `SteamGifts needs human verification in the opened browser for ${page.url()}. `
            + "Complete the Cloudflare check there and the sync will continue automatically.",
        );
      }
    } catch {
      // Ignore transient evaluation failures during Cloudflare redirects.
    }
    await page.waitForTimeout(5000);
  }

  throw new Error(`Timed out waiting for SteamGifts page to finish Cloudflare verification: ${page.url()}`);
}

async function gotoSteamGifts(page, url) {
  if (navigationDelayMs > 0) {
    await page.waitForTimeout(navigationDelayMs);
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForSteamGifts(page);
}

async function collectMembers(page, groupBase, existingSync, maxMemberPages) {
  const results = [];
  const seen = new Set();
  const cachedProfiles = new Map(
    (existingSync?.members || [])
      .filter((member) => member?.username)
      .map((member) => [member.username, member.steamProfile || ""]),
  );
  let pagesScanned = 0;

  await gotoSteamGifts(page, `${groupBase}/users`);
  for (let pageNumber = 1; pageNumber <= maxMemberPages; pageNumber += 1) {
    const pageMembers = await page.evaluate((cachedEntries) => {
      function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      const cachedProfiles = new Map(cachedEntries);
      const rowLinks = Array.from(document.querySelectorAll('.table__row-inner-wrap a[href*="/user/"]'));
      const links = rowLinks.length ? rowLinks : Array.from(document.querySelectorAll('a[href*="/user/"]'));
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
        const container = link.closest(".table__row-inner-wrap, .giveaway__row-inner-wrap") || document.body;
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
    }, Array.from(cachedProfiles.entries()));

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
    pagesScanned = pageNumber;

    if (pageNumber >= maxMemberPages) {
      break;
    }

    const nextUrl = await page.evaluate((nextPage) => {
      const link = document.querySelector(`a[href*="/users/search?page=${nextPage}"]`);
      return link ? link.href : "";
    }, pageNumber + 1);
    if (!nextUrl) {
      break;
    }
    await gotoSteamGifts(page, nextUrl);
  }

  const missingProfiles = results.filter((member) => !member.steamProfile && member.profileUrl);
  for (const member of missingProfiles) {
    await gotoSteamGifts(page, member.profileUrl);
    member.steamProfile = await page.evaluate(() => {
      const steamLink = document.querySelector(
        'a[href*="steamcommunity.com/profiles/"], a[href*="steamcommunity.com/id/"]',
      );
      return steamLink ? steamLink.href : "";
    });
  }

  const groupName = normalizeText((await page.title()).replace(/\s*\|\s*SteamGifts.*/i, "")) || "Akatsuki";
  return { members: results, pagesScanned, groupName };
}

async function collectGiveaways(page, groupBase, maxGiveawayPages) {
  const results = [];
  const seen = new Set();
  let pagesScanned = 0;

  await gotoSteamGifts(page, groupBase);
  for (let pageNumber = 1; pageNumber <= maxGiveawayPages; pageNumber += 1) {
    const pageGiveaways = await page.evaluate(() => {
      function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function escapeRegex(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

      const rows = Array.from(document.querySelectorAll(".giveaway__row-inner-wrap, .table__row-inner-wrap"));
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
    });

    if (!pageGiveaways.length) {
      break;
    }

    let added = 0;
    for (const giveaway of pageGiveaways) {
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
    pagesScanned = pageNumber;

    if (pageNumber >= maxGiveawayPages) {
      break;
    }

    const nextUrl = await page.evaluate((nextPage) => {
      const link = document.querySelector(`a[href*="/search?page=${nextPage}"]`);
      return link ? link.href : "";
    }, pageNumber + 1);
    if (!nextUrl) {
      break;
    }
    await gotoSteamGifts(page, nextUrl);
  }

  return { giveaways: results, pagesScanned };
}

async function fetchWinners(page, giveawayUrl) {
  const results = [];
  const seen = new Set();

  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    await gotoSteamGifts(page, `${giveawayUrl}/winners/search?page=${pageNumber}`);
    const pageWinners = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".table__row-inner-wrap"));
      return rows
        .map((row) => {
          const userLink = Array.from(row.querySelectorAll('a[href*="/user/"]')).find((anchor) =>
            /\/user\/[^/]+/.test(anchor.getAttribute("href") || ""),
          );
          if (!userLink) {
            return null;
          }
          return {
            username: normalizeText(userLink.textContent || ""),
            profileUrl: new URL(userLink.href, window.location.origin).href,
            status: row.lastElementChild ? normalizeText(row.lastElementChild.textContent || "") : "",
          };
        })
        .filter(Boolean);
    });

    if (!pageWinners.length) {
      break;
    }

    let added = 0;
    for (const winner of pageWinners) {
      if (!winner.username || seen.has(winner.username)) {
        continue;
      }
      seen.add(winner.username);
      results.push(winner);
      added += 1;
    }

    if (!added) {
      break;
    }
  }

  return results;
}

async function enrichGiveaway(page, giveaway) {
  await gotoSteamGifts(page, giveaway.url);
  const details = await page.evaluate(() => {
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
      return { appId: null, steamAppUrl: "" };
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

    const featureRows = Array.from(document.querySelectorAll(".featured__table__row__left"));
    const featureMap = {};
    for (const label of featureRows) {
      const key = normalizeText(label.textContent || "");
      const value = label.nextElementSibling ? normalizeText(label.nextElementSibling.textContent || "") : "";
      featureMap[key] = value;
    }

    const timestamps = Array.from(document.querySelectorAll("[data-timestamp]"));
    const endTimestamp = timestamps.length
      ? Number(timestamps[timestamps.length - 1].getAttribute("data-timestamp")) * 1000
      : null;
    const { appId, steamAppUrl } = extractAppInfo(document.body);
    const media = extractSteamMedia(document.body, appId);

    return {
      appId,
      steamAppUrl,
      headerImageUrl: media.headerImageUrl,
      capsuleImageUrl: media.capsuleImageUrl,
      capsuleSmallUrl: media.capsuleSmallUrl,
      entriesCount: Number.parseInt(String(featureMap.Entries || "").replace(/[^\d]/g, ""), 10) || 0,
      points: Number.parseInt(String(featureMap.Points || "").replace(/[^\d]/g, ""), 10) || 0,
      endDate: endTimestamp ? new Date(endTimestamp).toISOString() : null,
      regionRestricted: /region/i.test(String(featureMap.Type || "")),
    };
  });

  return {
    ...giveaway,
    appId: details.appId || giveaway.appId || null,
    steamAppUrl: details.steamAppUrl || giveaway.steamAppUrl || "",
    headerImageUrl: details.headerImageUrl || giveaway.headerImageUrl || "",
    capsuleImageUrl: details.capsuleImageUrl || giveaway.capsuleImageUrl || "",
    capsuleSmallUrl: details.capsuleSmallUrl || giveaway.capsuleSmallUrl || "",
    entriesCount: giveaway.entriesCount || details.entriesCount || 0,
    points: details.points || giveaway.points || 0,
    endDate: giveaway.endDate || details.endDate || null,
    regionRestricted: details.regionRestricted || giveaway.regionRestricted || false,
    winners: await fetchWinners(page, giveaway.url),
  };
}

const groupUrl = readArg("--group-url", process.env.AKATSUKI_GROUP_URL || DEFAULT_GROUP_URL);
const outputPath = path.resolve(readArg("--output", path.join(BASE_DIR, "data", "steamgifts-sync.public.json")));
const existingSyncPath = path.resolve(
  readArg("--existing-sync", path.join(BASE_DIR, "data", "steamgifts-sync.json")),
);
const fullHistory = hasFlag("--full-history");
const maxGiveawayPages = Number.parseInt(readArg("--giveaway-pages", fullHistory ? "500" : "5"), 10) || 5;
const maxMemberPages = Math.max(1, Number.parseInt(readArg("--member-pages", "1"), 10) || 1);
const existingSync = await readJson(existingSyncPath, {});
navigationDelayMs = Math.max(0, Number.parseInt(readArg("--delay-ms", "505"), 10) || 505);

const browser = await chromium.launch({
  headless: browserHeadless,
  ...(browserChannel ? { channel: browserChannel } : {}),
  args: ["--disable-blink-features=AutomationControlled"],
});

try {
  const groupMatch = groupUrl.match(/(https:\/\/www\.steamgifts\.com\/group\/[^/]+\/[^/?#]+)/i);
  if (!groupMatch) {
    throw new Error(`Invalid SteamGifts group URL: ${groupUrl}`);
  }
  const groupBase = groupMatch[1];
  const membersContext = await browser.newContext(CONTEXT_OPTIONS);
  await membersContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const membersPage = await membersContext.newPage();
  membersPage.setDefaultTimeout(120000);
  const {
    members,
    pagesScanned: memberPagesScanned,
    groupName,
  } = await collectMembers(membersPage, groupBase, existingSync, maxMemberPages);
  await membersContext.close();

  const giveawaysContext = await browser.newContext(CONTEXT_OPTIONS);
  await giveawaysContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const giveawaysPage = await giveawaysContext.newPage();
  giveawaysPage.setDefaultTimeout(120000);
  const { giveaways, pagesScanned: giveawayPagesScanned } = await collectGiveaways(
    giveawaysPage,
    groupBase,
    maxGiveawayPages,
  );

  const pendingGiveaways = getPendingGiveawaysToRefresh(existingSync, giveaways);
  const unresolvedGiveaways = giveaways.filter(needsGiveawayDetails);
  const followUpGiveaways = Array.from(
    new Map([...unresolvedGiveaways, ...pendingGiveaways].map((giveaway) => [giveaway.code, giveaway])).values(),
  );
  const resolvedGiveaways = new Map();

  for (const giveaway of followUpGiveaways) {
    resolvedGiveaways.set(giveaway.code, await enrichGiveaway(giveawaysPage, giveaway));
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
      name: groupName,
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
    memberPagesScanned,
    giveawayPagesScanned,
    unresolvedGiveawaysResolved: followUpGiveaways.length,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `Public SteamGifts sync saved to ${outputPath} (${payload.members.length} members, ${payload.giveaways.length} giveaways).`,
  );
  await giveawaysContext.close();
} finally {
  await browser.close();
}
