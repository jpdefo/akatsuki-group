import {
  addMonths,
  cloneState,
  differenceInDays,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatHours,
  formatISODateLocal,
  formatMonthKey,
  getAchievementPercent,
  monthKey,
  normalizeGameTitle,
  parseDate,
  parseSteamAppId,
  setDayOfCurrentMonth,
  shiftDate,
  startOfCurrentMonth,
  todayISO,
  uid,
} from "./client/utils.js";
import {
  getCycleKey,
  getCycleMonthKeys,
  getNextCycleExemptionInfo,
  getPeriodInfo,
  getPreviousCyclePeriod,
  getRequiredHours,
} from "./client/cycle-rules.js";

const STORAGE_KEY = "akatsuki-monitor-state-v1";
const GITHUB_PUBLISH_REPO = { owner: "jpdefo", name: "akatsuki-group", branch: "main" };
const GITHUB_OVERRIDES_PATH = "data/overrides.json";
const GITHUB_TOKEN_STORAGE_KEY = "akatsuki-github-token";

const defaultState = {
  settings: {
    groupName: "Akatsuki",
    activeMembers: 30,
    minimumValuePoints: 15,
    currentDate: todayISO(),
    // Summer-event entry-swing ruleset: "auto" (legacy <=2025, 2026 rules from
    // 2026), or force "legacy" / "2026".
    summerRuleset: "auto",
  },
  sync: {
    steamgifts: null,
    steamProgressUpdatedAt: null,
    dashboard: null,
    lastProgressStats: null,
    lastLibraryStats: null,
  },
  members: [],
  games: [],
  wins: [],
  giveaways: [],
  overrides: {
    games: {},
    wins: {},
    giveaways: {},
    cycleMembers: {},
    members: {},
  },
};

let state = loadState();
const loadedMediaAppIds = new Set();
const attemptedMediaAppIds = new Set();
const pendingMediaRequests = new Map();
// On GitHub Pages (or a file:// open) the API is prebuilt static JSON, so
// requests must go straight to the `.json` files. Detecting this up front lets
// the parallel initial load skip the extensionless probe that always 404s there.
const IS_STATIC_HOST =
  window.location.protocol === "file:" || /\.github\.io$/i.test(window.location.hostname);
const runtime = {
  staticApi: IS_STATIC_HOST,
  // While true, render() is a no-op. Used to coalesce the initial parallel load
  // into a single paint instead of re-rendering as each payload arrives.
  renderSuspended: false,
  editModal: null,
  editModalState: null,
  sharedOverrides: normalizeOverrideState(),
  sharedOverridesLoaded: false,
};
const GAME_OVERRIDE_FIELDS = ["hltbHoursOverride", "achievementTargetOverride"];
const WIN_OVERRIDE_FIELDS = ["requiredAchievementsOverride", "monthOverride"];
const GIVEAWAY_OVERRIDE_FIELDS = ["giveawayKindOverride", "manualWinners", "cycleMonthOverride", "summerBasePointsOverride"];
const MEMBER_OVERRIDE_FIELDS = ["membershipStatus"];

applyManualOverrides();

const elements = {
  settingsForm: document.querySelector("#settings-form"),
  memberForm: document.querySelector("#member-form"),
  gameForm: document.querySelector("#game-form"),
  winForm: document.querySelector("#win-form"),
  giveawayForm: document.querySelector("#giveaway-form"),
  groupSnapshot: document.querySelector("#group-snapshot"),
  summaryCards: document.querySelector("#summary-cards"),
  alertsPanel: document.querySelector("#alerts-panel"),
  membersTable: document.querySelector("#members-table"),
  gamesTable: document.querySelector("#games-table"),
  winsTable: document.querySelector("#wins-table"),
  giveawaysTable: document.querySelector("#giveaways-table"),
  periodSummary: document.querySelector("#period-summary"),
  storageStatus: document.querySelector("#storage-status"),
  syncStatus: document.querySelector("#sync-status"),
  memberOverview: document.querySelector("#member-overview"),
  recentGiveaways: document.querySelector("#recent-giveaways"),
  monthlyFilter: document.querySelector("#monthly-filter"),
  monthlyMemberFilter: document.querySelector("#monthly-member-filter"),
  monthlySort: document.querySelector("#monthly-sort"),
  monthlyProgressTable: document.querySelector("#monthly-progress-table"),
  penaltiesFilter: document.querySelector("#penalties-filter"),
  penaltiesTable: document.querySelector("#penalties-table"),
  penaltiesSummary: document.querySelector("#penalties-summary"),
  cycleFilter: document.querySelector("#cycle-filter"),
  cycleSummary: document.querySelector("#cycle-summary"),
  cycleBestGifterWarning: document.querySelector("#cycle-best-gifter-warning"),
  cycleTable: document.querySelector("#cycle-table"),
  cycleGiveawaysTable: document.querySelector("#cycle-giveaways-table"),
  cycleGiveawayMonthFilter: document.querySelector("#cycle-giveaway-month-filter"),
  cycleGiveawaySort: document.querySelector("#cycle-giveaway-sort"),
  cycleWinsTable: document.querySelector("#cycle-wins-table"),
  summerEventFilter: document.querySelector("#summer-event-filter"),
  summerRuleset: document.querySelector("#summer-ruleset"),
  summerEventSort: document.querySelector("#summer-event-sort"),
  summerEventCreatorFilter: document.querySelector("#summer-event-creator-filter"),
  summerEventWinnerFilter: document.querySelector("#summer-event-winner-filter"),
  summerEventDescription: document.querySelector("#summer-event-description"),
  summerEventSummaryCards: document.querySelector("#summer-event-summary-cards"),
  summerEventMemberGrid: document.querySelector("#summer-event-member-grid"),
  summerEventGiveawaysTable: document.querySelector("#summer-event-giveaways-table"),
  allGiveawaysTable: document.querySelector("#all-giveaways-table"),
  giveawaysSummary: document.querySelector("#giveaways-summary"),
  giveawaysSearch: document.querySelector("#giveaways-search"),
  giveawaysKindFilter: document.querySelector("#giveaways-kind-filter"),
  giveawaysMonthFilter: document.querySelector("#giveaways-month-filter"),
  giveawaysSort: document.querySelector("#giveaways-sort"),
  summerEntryEventFilter: document.querySelector("#summer-entry-event-filter"),
  summerEntryMemberFilter: document.querySelector("#summer-entry-member-filter"),
  summerEntryCreatorFilter: document.querySelector("#summer-entry-creator-filter"),
  summerEntrySort: document.querySelector("#summer-entry-sort"),
  summerEntryDescription: document.querySelector("#summer-entry-description"),
  summerEntrySummaryCards: document.querySelector("#summer-entry-summary-cards"),
  summerEntryTable: document.querySelector("#summer-entry-table"),
  activeUsersTable: document.querySelector("#active-users-table"),
  activeUsersSort: document.querySelector("#active-users-sort"),
  inactiveUsersTable: document.querySelector("#inactive-users-table"),
  totalProgressTable: document.querySelector("#total-progress-table"),
  seedDemoButton: document.querySelector("#seed-demo"),
  exportButton: document.querySelector("#export-data"),
  publishOverridesButton: document.querySelector("#publish-overrides"),
  publishToPagesButton: document.querySelector("#publish-to-pages"),
  githubTokenButton: document.querySelector("#github-token-button"),
  clearGithubTokenButton: document.querySelector("#github-token-clear"),
  quickPublishButton: document.querySelector("#quick-publish"),
  importInput: document.querySelector("#import-data"),
  resetButton: document.querySelector("#reset-data"),
  syncRefreshButton: document.querySelector("#sync-refresh"),
  steamRefreshButton: document.querySelector("#steam-refresh"),
  steamRefreshAllButton: document.querySelector("#steam-refresh-all"),
  emptyStateTemplate: document.querySelector("#empty-state-template"),
};

bootstrap();

function bootstrap() {
  ensureEditModal();
  bindEvents();
  // No eager render: painting from stale localStorage is what shows the
  // "22 members / 11 penalties" values that then correct themselves. The first
  // paint happens once, after the initial load below has applied real data.
  loadInitialData();
}

async function loadInitialData() {
  // Fetch every payload in parallel, apply them all with rendering suspended,
  // then paint once. Previously this was a sequential chain (sync -> dashboard ->
  // progress/overrides) that re-rendered after each step, so derived numbers
  // (members, penalties) appeared before overrides/progress were applied and then
  // visibly corrected themselves. One round-trip, one render, correct the first
  // time.
  runtime.renderSuspended = true;
  try {
    const [syncResult, dashboardResult, overridesResult, progressResult] = await Promise.allSettled([
      fetchApiJson("./api/steamgifts-sync"),
      fetchApiJson("./api/dashboard"),
      fetchApiJson("./api/overrides"),
      fetchApiJson("./api/steam-progress"),
    ]);
    // Apply in dependency order: sync builds the records, overrides layer on top,
    // progress feeds PoP/penalties.
    await refreshRemoteSync({ silent: true, skipDashboard: true, prefetched: settledValue(syncResult) });
    await loadDashboardData({ silent: true, prefetched: settledValue(dashboardResult) });
    await loadSharedOverrides({ silent: true, prefetched: settledValue(overridesResult) });
    await loadStoredSteamProgress({ silent: true, prefetched: settledValue(progressResult) });
  } finally {
    runtime.renderSuspended = false;
    render();
  }
  void loadVisibleGameMedia({ silent: true });
}

function settledValue(result) {
  return result && result.status === "fulfilled" ? result.value : undefined;
}

function bindEvents() {
  elements.settingsForm?.addEventListener("submit", handleSettingsSubmit);
  elements.memberForm?.addEventListener("submit", handleMemberSubmit);
  elements.gameForm?.addEventListener("submit", handleGameSubmit);
  elements.winForm?.addEventListener("submit", handleWinSubmit);
  elements.giveawayForm?.addEventListener("submit", handleGiveawaySubmit);
  elements.seedDemoButton?.addEventListener("click", seedDemoData);
  elements.exportButton?.addEventListener("click", exportData);
  elements.publishOverridesButton?.addEventListener("click", () => publishSharedOverrides());
  elements.publishToPagesButton?.addEventListener("click", () => publishOverridesToGitHub());
  elements.githubTokenButton?.addEventListener("click", () => {
    promptForGithubToken({ announce: true });
    updateQuickPublishVisibility();
  });
  elements.clearGithubTokenButton?.addEventListener("click", () => {
    if (!getStoredGithubToken()) {
      window.alert("No GitHub token is set.");
      return;
    }
    if (!window.confirm("Remove the saved GitHub token from this browser?")) {
      return;
    }
    setStoredGithubToken("");
    updateQuickPublishVisibility();
    window.alert("GitHub token removed from this browser.");
  });
  elements.quickPublishButton?.addEventListener("click", () => publishOverridesToGitHub());
  updateQuickPublishVisibility();
  elements.importInput?.addEventListener("change", importData);
  elements.resetButton?.addEventListener("click", resetData);
  elements.syncRefreshButton?.addEventListener("click", () => refreshRemoteSync());
  elements.steamRefreshButton?.addEventListener("click", () => refreshSteamProgress());
  elements.steamRefreshAllButton?.addEventListener("click", () => refreshSteamProgress({ fullRefresh: true }));
  elements.monthlyFilter?.addEventListener("change", () => {
    renderProgressViews();
    void loadVisibleGameMedia({ silent: true });
  });
  elements.monthlySort?.addEventListener("change", () => renderProgressViews());
  elements.cycleFilter?.addEventListener("change", () => renderCycleHistoryPage());
  elements.cycleGiveawayMonthFilter?.addEventListener("change", () => renderCycleHistoryPage());
  elements.cycleGiveawaySort?.addEventListener("change", () => renderCycleHistoryPage());
  elements.summerEventFilter?.addEventListener("change", () => renderSummerEventPage());
  elements.summerRuleset?.addEventListener("change", () => {
    state.settings.summerRuleset = elements.summerRuleset.value || "auto";
    persistAndRender();
  });
  elements.summerEventSort?.addEventListener("change", () => renderSummerEventPage());
  elements.summerEventCreatorFilter?.addEventListener("input", () => renderSummerEventPage());
  elements.summerEventWinnerFilter?.addEventListener("input", () => renderSummerEventPage());
  elements.giveawaysSearch?.addEventListener("input", () => renderAllGiveawaysPage());
  elements.giveawaysKindFilter?.addEventListener("change", () => renderAllGiveawaysPage());
  elements.giveawaysMonthFilter?.addEventListener("change", () => renderAllGiveawaysPage());
  elements.giveawaysSort?.addEventListener("change", () => renderAllGiveawaysPage());
  elements.summerEntryEventFilter?.addEventListener("change", () => renderSummerEventEntriesPage());
  elements.summerEntryMemberFilter?.addEventListener("change", () => renderSummerEventEntriesPage());
  elements.summerEntryCreatorFilter?.addEventListener("change", () => renderSummerEventEntriesPage());
  elements.summerEntrySort?.addEventListener("change", () => renderSummerEventEntriesPage());
  elements.activeUsersSort?.addEventListener("change", () => renderMemberBuckets());
  elements.monthlyMemberFilter?.addEventListener("change", () => renderProgressViews());
  elements.penaltiesFilter?.addEventListener("change", () => renderPenaltiesPage());

  document.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-action]");
    if (editButton) {
      handleEditAction(editButton);
      return;
    }

    const reactivateButton = event.target.closest("[data-reactivate-member]");
    if (reactivateButton) {
      handleReactivateMember(reactivateButton);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-type]");
    if (!deleteButton) {
      return;
    }

    const { deleteType, deleteId } = deleteButton.dataset;
    state[deleteType] = state[deleteType].filter((item) => item.id !== deleteId);
    persistAndRender();
  });

  document.addEventListener("change", (event) => {
    const cycleMemberStatusSelect = event.target.closest("[data-cycle-member-status-select]");
    if (cycleMemberStatusSelect) {
      handleCycleMemberStatusChange(cycleMemberStatusSelect);
      return;
    }

    const memberStatusSelect = event.target.closest("[data-member-status-select]");
    if (memberStatusSelect) {
      handleMemberStatusChange(memberStatusSelect);
      return;
    }

    const giveawayKindSelect = event.target.closest("[data-giveaway-kind-select]");
    if (!giveawayKindSelect) {
      return;
    }
    handleGiveawayKindChange(giveawayKindSelect);
  });
}

function handleSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.settings = {
    groupName: formData.get("groupName").trim() || "Akatsuki",
    activeMembers: Number(formData.get("activeMembers")),
    minimumValuePoints: Number(formData.get("minimumValuePoints")),
    currentDate: formData.get("currentDate"),
  };
  persistAndRender();
}

function handleMemberSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.members.unshift({
    id: uid("member"),
    name: formData.get("name").trim(),
    steamProfile: formData.get("steamProfile").trim(),
    joinDate: formData.get("joinDate"),
  });
  event.currentTarget.reset();
  persistAndRender();
}

function handleGameSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.games.unshift({
    id: uid("game"),
    title: formData.get("title").trim(),
    appId: Number(formData.get("appId")),
    hltbHours: Number(formData.get("hltbHours")),
    achievementsTotal: Number(formData.get("achievementsTotal")),
  });
  event.currentTarget.reset();
  persistAndRender();
}

function handleWinSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.wins.unshift({
    id: uid("win"),
    memberId: formData.get("memberId"),
    gameId: formData.get("gameId"),
    winDate: formData.get("winDate"),
    ruleMode: formData.get("ruleMode"),
    currentHours: Number(formData.get("currentHours")),
    earnedAchievements: Number(formData.get("earnedAchievements")),
    proofProvided: formData.get("proofProvided") === "on",
    evidenceNotes: formData.get("evidenceNotes").trim(),
    createdAt: new Date().toISOString(),
  });
  event.currentTarget.reset();
  persistAndRender();
}

function handleGiveawaySubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.giveaways.unshift({
    id: uid("giveaway"),
    creatorId: formData.get("creatorId"),
    title: formData.get("title").trim(),
    type: formData.get("type"),
    createdAt: formData.get("createdAt"),
    valuePoints: Number(formData.get("valuePoints")),
    entriesCount: Number(formData.get("entriesCount")),
    regionLocked: formData.get("regionLocked") === "on",
    bundled: formData.get("bundled") === "on",
    notes: formData.get("notes").trim(),
  });
  event.currentTarget.reset();
  persistAndRender();
}

function render() {
  if (runtime.renderSuspended) {
    return;
  }
  renderSettings();
  renderSyncStatus();
  renderServerViews();
  renderProgressViews();
  renderCycleHistoryPage();
  renderSummerEventPage();
  renderSummerEventEntriesPage();
  renderAllGiveawaysPage();
  renderMemberBuckets();
  renderPenaltiesPage();
}

// Created = the earlier captured timestamp; End = the later one, shown only when
// we actually captured a distinct end (i.e. after a fresh group-page scrape).
// Older data only has the creation date, so End stays hidden until re-scraped.
function getGiveawayCreatedDisplay(giveaway) {
  return giveaway?.startDate || giveaway?.endDate || "";
}

function getGiveawayEndedDisplay(giveaway) {
  const start = giveaway?.startDate;
  const end = giveaway?.endDate;
  return start && end && start !== end ? end : "";
}

function sortAllGiveaways(giveaways, sortValue) {
  const endOf = (g) => String(g.createdAt || ""); // createdAt holds the giveaway end date for synced giveaways
  const byCreator = (g) => getCycleGiveawayCreatorLabel(g);
  const byWinner = (g) => getCycleGiveawayWinnerLabel(g);
  const sorted = giveaways.slice();
  sorted.sort((a, b) => {
    switch (sortValue) {
      case "ended-asc":
        return endOf(a).localeCompare(endOf(b));
      case "creator-asc":
        return byCreator(a).localeCompare(byCreator(b), "en-US", { sensitivity: "base" }) || endOf(b).localeCompare(endOf(a));
      case "creator-desc":
        return byCreator(b).localeCompare(byCreator(a), "en-US", { sensitivity: "base" }) || endOf(b).localeCompare(endOf(a));
      case "winner-asc":
        return byWinner(a).localeCompare(byWinner(b), "en-US", { sensitivity: "base" }) || endOf(b).localeCompare(endOf(a));
      case "winner-desc":
        return byWinner(b).localeCompare(byWinner(a), "en-US", { sensitivity: "base" }) || endOf(b).localeCompare(endOf(a));
      case "title-asc":
        return String(a.title || "").localeCompare(String(b.title || ""), "en-US", { sensitivity: "base" });
      case "title-desc":
        return String(b.title || "").localeCompare(String(a.title || ""), "en-US", { sensitivity: "base" });
      case "entries-desc":
        return Number(b.entriesCount || 0) - Number(a.entriesCount || 0) || endOf(b).localeCompare(endOf(a));
      case "entries-asc":
        return Number(a.entriesCount || 0) - Number(b.entriesCount || 0) || endOf(b).localeCompare(endOf(a));
      case "ended-desc":
      default:
        return endOf(b).localeCompare(endOf(a));
    }
  });
  return sorted;
}

function renderAllGiveawaysPage() {
  if (!elements.allGiveawaysTable) {
    return;
  }

  const all = state.giveaways.slice();

  if (elements.giveawaysMonthFilter) {
    const months = Array.from(new Set(all.map((giveaway) => getGiveawayMonth(giveaway)).filter(Boolean))).sort((left, right) =>
      right.localeCompare(left),
    );
    const previous = elements.giveawaysMonthFilter.value;
    elements.giveawaysMonthFilter.innerHTML = [`<option value="all">All months</option>`]
      .concat(months.map((month) => `<option value="${month}">${escapeHtml(formatMonthKey(month))}</option>`))
      .join("");
    elements.giveawaysMonthFilter.value = months.includes(previous) ? previous : "all";
  }

  const search = String(elements.giveawaysSearch?.value || "").trim().toLowerCase();
  const kindFilter = String(elements.giveawaysKindFilter?.value || "all");
  const monthFilter = String(elements.giveawaysMonthFilter?.value || "all");
  const sortValue = String(elements.giveawaysSort?.value || "ended-desc");

  const filtered = all.filter((giveaway) => {
    if (kindFilter !== "all" && getGiveawayKind(giveaway) !== kindFilter) {
      return false;
    }
    if (monthFilter !== "all" && getGiveawayMonth(giveaway) !== monthFilter) {
      return false;
    }
    if (search) {
      const haystack = `${giveaway.title || ""} ${getCycleGiveawayCreatorLabel(giveaway)} ${getCycleGiveawayWinnerLabel(giveaway)}`.toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });

  const sortedRows = sortAllGiveaways(filtered, sortValue);
  const RENDER_LIMIT = 400;
  const visibleRows = sortedRows.slice(0, RENDER_LIMIT);

  if (elements.giveawaysSummary) {
    elements.giveawaysSummary.textContent = sortedRows.length > RENDER_LIMIT
      ? `${sortedRows.length.toLocaleString("en-US")} giveaways match — showing the first ${RENDER_LIMIT}. Use the filters to narrow down.`
      : `${sortedRows.length.toLocaleString("en-US")} giveaway${sortedRows.length === 1 ? "" : "s"}.`;
  }

  elements.allGiveawaysTable.innerHTML = visibleRows.length
    ? visibleRows
        .map((giveaway) => {
          const title = escapeHtml(giveaway.title || "Untitled giveaway");
          const thumb = buildImageMarkup({
            className: "giveaway-thumb",
            alt: title,
            appId: giveaway.appId,
            sources: [giveaway.capsuleSmallUrl, giveaway.headerImageUrl, giveaway.capsuleImageUrl],
            placeholder: "—",
          });
          const thumbCell = giveaway.steamAppUrl
            ? `<a href="${escapeHtml(giveaway.steamAppUrl)}" target="_blank" rel="noreferrer">${thumb}</a>`
            : thumb;
          const giveawayUrl = String(giveaway.notes || "").trim();
          const titleMarkup = giveawayUrl
            ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${title}</a>`
            : title;
          const creator = findById("members", giveaway.creatorId);
          const kind = getGiveawayKind(giveaway);
          const month = getGiveawayMonth(giveaway);
          const manualWinners = getGiveawayManualWinners(giveaway);
          const wins = findWinsForGiveaway(giveaway);
          const winnerMarkup = manualWinners.length
            ? manualWinners.map((winner) => buildManualWinnerMarkup(winner)).join(", ")
            : wins.length
              ? wins.map((win) => buildWinnerMarkup(findById("members", win.memberId))).join(", ")
              : "-";
          const currentWinnerNames = (manualWinners.length
            ? manualWinners.map((winner) => winner.username)
            : wins
                .map((win) => {
                  const member = findById("members", win.memberId);
                  return String(member?.steamgiftsUsername || member?.name || "").trim();
                })
                .filter(Boolean)
          ).join(", ");
          const winnerKey = getGiveawayCodeKey(giveaway);
          return `
            <tr>
              <td>${thumbCell}</td>
              <td>
                <strong>${titleMarkup}</strong>
                <span class="meta-line">Created: ${escapeHtml(formatDateTime(getGiveawayCreatedDisplay(giveaway)))}</span>
                <span class="meta-line">End date: ${escapeHtml(formatDateTime(getGiveawayEndedDisplay(giveaway)))}</span>
              </td>
              <td>${escapeHtml(creator?.name || giveaway.creatorUsername || "Unknown member")}</td>
              <td>
                <div>${month ? formatMonthKey(month) : "-"}</div>
                <button class="inline-action" data-edit-action="giveaway-month" data-giveaway-id="${giveaway.id}">Edit month</button>
              </td>
              <td>
                <label class="inline-select-wrap compact-select-wrap">
                  <select class="inline-select" data-giveaway-kind-select="true" data-giveaway-id="${giveaway.id}">
                    <option value="cycle" ${kind === "cycle" ? "selected" : ""}>Cycle</option>
                    <option value="extra" ${kind === "extra" ? "selected" : ""}>Extra</option>
                    <option value="pop_free" ${kind === "pop_free" ? "selected" : ""}>PoP Free</option>
                    <option value="penalty" ${kind === "penalty" ? "selected" : ""}>Penalty</option>
                    <option value="summer_event" ${kind === "summer_event" ? "selected" : ""}>Summer event</option>
                  </select>
                </label>
              </td>
              <td>
                <div>${winnerMarkup}${manualWinners.length ? ` ${buildBadge("info", "Manual")}` : ""}</div>
                ${canEditGiveawayWinner(giveaway) ? `<button class="inline-action" data-edit-action="winner" data-giveaway-key="${escapeHtml(winnerKey)}" data-current-winners="${escapeHtml(currentWinnerNames)}">Edit winner</button>` : ""}
              </td>
              <td>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")}</td>
            </tr>
          `;
        })
        .join("")
    : buildMessageRow(7, "No giveaways match the current filters.", "Adjust the search, type, or month filters.");

  void loadVisibleGameMedia({ silent: true });
}

function renderSettings() {
  if (elements.summerRuleset) {
    elements.summerRuleset.value = state.settings.summerRuleset || "auto";
  }
  if (elements.storageStatus) {
    elements.storageStatus.textContent = runtime.staticApi
      ? "GitHub Pages snapshot"
      : state.sync?.dashboard
        ? "Server-backed + browser cache"
        : "Saved in browser";
  }
  if (!elements.groupSnapshot) {
    return;
  }
  const sync = state.sync?.steamgifts;
  const dashboardSummary = state.sync?.dashboard?.summary;
  const effectiveActiveMembers = state.members.filter((member) => member.isActiveMember).length;
  const cards = [
    ["Group", state.settings.groupName],
    [
      "Active members",
      state.members.length ? effectiveActiveMembers : dashboardSummary?.activeMembers ?? state.settings.activeMembers,
    ],
    ["Tracked giveaways", dashboardSummary?.giveaways ?? state.giveaways.length],
    [
      "Latest sync",
      dashboardSummary?.syncedAt ? formatDateTime(dashboardSummary.syncedAt) : formatDate(state.settings.currentDate),
    ],
  ];
  elements.groupSnapshot.innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="summary-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </article>
      `,
    )
    .join("");
}

function renderSelectors() {
  if (!elements.winForm || !elements.giveawayForm) {
    return;
  }
  const memberOptions = buildOptions(
    state.members,
    "Select a member",
    (member) => member.name,
  );
  const gameOptions = buildOptions(
    state.games,
    "Select a game",
    (game) => game.title,
  );
  elements.winForm.memberId.innerHTML = memberOptions;
  elements.winForm.gameId.innerHTML = gameOptions;
  elements.giveawayForm.creatorId.innerHTML = memberOptions;
}

function renderSummary() {
  const metrics = computeMetrics();
  const period = getPeriodInfo(state.settings.currentDate);
  elements.periodSummary.textContent =
    period.kind === "cycle"
      ? `${period.label} • month ${period.monthPosition} of the cycle • current minimum threshold: ${metrics.minimumEntriesRequired} entries`
      : `${period.label} • special month/pause • current minimum threshold: ${metrics.minimumEntriesRequired} entries`;

  const cards = [
    ["Overdue wins", metrics.overdueWins],
    ["Penalty giveaways owed", metrics.penaltyGiveawaysOwed],
    ["Due in 30 days", metrics.dueSoonWins],
    ["Members above 8 wins", metrics.membersOverWinCap],
  ];

  elements.summaryCards.innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="summary-card">
          <strong>${value}</strong>
          <span>${label}</span>
        </article>
      `,
    )
    .join("");
}

function renderSyncStatus() {
  if (!elements.syncStatus) {
    return;
  }
  const sync = state.sync?.steamgifts;
  const progressUpdatedAt = state.sync?.steamProgressUpdatedAt;
  const dashboardSummary = state.sync?.dashboard?.summary;
  const librarySummary = dashboardSummary;

  if (!sync) {
    elements.syncStatus.innerHTML = `
      <article class="alert-card info">
        <h3>No SteamGifts sync loaded</h3>
        <p>Open the Admin tools page to import a SteamGifts JSON file, or install the SteamGifts userscript and run it from the group page.</p>
      </article>
    `;
    return;
  }

  if (elements.syncRefreshButton) {
    elements.syncRefreshButton.hidden = runtime.staticApi;
  }
  if (elements.steamRefreshButton) {
    elements.steamRefreshButton.hidden = runtime.staticApi;
  }
  if (elements.steamRefreshAllButton) {
    elements.steamRefreshAllButton.hidden = runtime.staticApi;
  }

  const playtimeUpdatedAt = librarySummary?.libraryUpdatedAt;
  const effectiveActiveMembers = state.members.filter((member) => member.isActiveMember).length;
  const memberCount = state.members.length
    ? effectiveActiveMembers
    : dashboardSummary?.activeMembers ?? state.settings.activeMembers ?? 0;
  const giveawayCount = dashboardSummary?.giveaways ?? state.giveaways.length;

  elements.syncStatus.innerHTML = `
    <article class="alert-card success sync-stat">
      <h3>SteamGifts synced</h3>
      <p class="sync-time">${formatDateTime(sync.syncedAt)}</p>
      <p class="sync-ago">${escapeHtml(formatTimeAgo(sync.syncedAt))}</p>
      ${runtime.staticApi ? `<p class="meta-line">GitHub Pages snapshot — data changes only after a new publish.</p>` : ""}
    </article>
    <article class="alert-card info sync-stat">
      <h3>Achievements synced</h3>
      ${
        progressUpdatedAt
          ? `<p class="sync-time">${formatDateTime(progressUpdatedAt)}</p>
             <p class="sync-ago">${escapeHtml(formatTimeAgo(progressUpdatedAt))}</p>`
          : `<p class="sync-empty">Not refreshed yet.</p>`
      }
    </article>
    <article class="alert-card ${librarySummary?.libraryApiEnabled ? "success" : "warning"} sync-stat">
      <h3>Playtime synced</h3>
      ${
        playtimeUpdatedAt
          ? `<p class="sync-time">${formatDateTime(playtimeUpdatedAt)}</p>
             <p class="sync-ago">${escapeHtml(formatTimeAgo(playtimeUpdatedAt))}</p>`
          : librarySummary?.libraryApiEnabled
            ? `<p class="sync-empty">No snapshot stored yet.</p>`
            : `<p class="sync-empty">Set STEAM_WEB_API_KEY to enable playtime snapshots.</p>`
      }
    </article>
    <article class="alert-card sync-stat">
      <h3>Group</h3>
      <p class="sync-time">${memberCount} members</p>
      <p class="sync-ago">${giveawayCount} tracked giveaways</p>
    </article>
  `;
}

// Human-friendly "x ago" label so it's obvious at a glance how stale each sync is.
function formatTimeAgo(dateInput) {
  if (!dateInput) {
    return "";
  }
  const then = new Date(dateInput).getTime();
  if (!Number.isFinite(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  if (diffMs < 60000) {
    return "Updated just now";
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
}

function renderServerViews() {
  renderMemberOverview();
  renderRecentGiveaways();
}

function renderMemberOverview() {
  if (!elements.memberOverview) {
    return;
  }

  const dashboardMembers = state.sync?.dashboard?.members || {};
  const allMembers = [...(dashboardMembers.active || []), ...(dashboardMembers.inactive || [])];
  // Effective membership honors the manual override, so a member set inactive
  // drops out of the directory (and stays out across future syncs).
  const activeMembers = allMembers
    .filter((member) => {
      const stateMember = findMemberByUsername(member.username);
      return stateMember
        ? getMemberMembershipStatus(stateMember) === "active"
        : Boolean(member.isActiveMember);
    })
    .sort((left, right) =>
      String(left.username || "").localeCompare(String(right.username || ""), "en", { sensitivity: "base" }),
    );

  if (!activeMembers.length) {
    elements.memberOverview.innerHTML = buildEmptyPanel(
      "No tracked members yet.",
      "Run the SteamGifts sync to populate the server-backed member directory.",
    );
    return;
  }

  const cards = activeMembers.map(buildMemberCard);
  const cycleReminderCard = buildCurrentCycleMissingGiveawaysCard();
  if (cycleReminderCard) {
    cards.unshift(cycleReminderCard);
  }
  const penaltiesCard = buildPenaltiesOwedCard();
  if (penaltiesCard) {
    cards.unshift(penaltiesCard);
  }

  elements.memberOverview.innerHTML = cards.join("");
}

function buildPenaltiesOwedCard() {
  const debts = getOutstandingPenalties();
  if (!debts.length) {
    return "";
  }
  const items = debts
    .slice(0, 15)
    .map((debt) => {
      const name = String(debt.member?.name || "Unknown member");
      const gameTitle = String(debt.game?.title || debt.win.title || "a won game");
      return `<li><strong>${escapeHtml(name)}</strong>: ${escapeHtml(gameTitle)} (due ${escapeHtml(formatPenaltyDeadline(debt.deadline))})</li>`;
    })
    .join("");
  const more = debts.length > 15 ? `<li>+${debts.length - 15} more…</li>` : "";

  return `
    <article class="member-card negative penalty-owed-card">
      ${buildBadge("danger", "Penalties owed")}
      <h3>${debts.length} penalt${debts.length === 1 ? "y" : "ies"} to pay</h3>
      <span class="meta-line">Incomplete wins past their ${PENALTY_GRACE_MONTHS}-month deadline with no penalty giveaway attached. Create a "Penalty GA - &lt;won giveaway link&gt;" to settle.</span>
      <ul class="penalty-list">${items}${more}</ul>
    </article>
  `;
}

function renderRecentGiveaways() {
  if (!elements.recentGiveaways) {
    return;
  }

  const giveaways = state.sync?.dashboard?.recentGiveaways || [];
  if (!giveaways.length) {
    elements.recentGiveaways.innerHTML = buildEmptyPanel(
      "No synced giveaways yet.",
      "Recent giveaway cards will appear here after the next SteamGifts sync.",
    );
    return;
  }

  elements.recentGiveaways.innerHTML = giveaways.map(buildGiveawayCard).join("");
}

function renderProgressViews() {
  if (!elements.monthlyFilter || !elements.monthlyProgressTable) {
    return;
  }

  const months = getAvailableMonths();

  // Optional per-member filter (merges the old User progress page in here):
  // pick a member to scope the table to their wins, across one month or all.
  const memberWinCounts = new Map();
  for (const win of state.wins) {
    if (win.memberId) {
      memberWinCounts.set(win.memberId, (memberWinCounts.get(win.memberId) || 0) + 1);
    }
  }
  const filterMembers = state.members
    .filter((member) => member.isActiveMember && memberWinCounts.has(member.id))
    .sort((left, right) =>
      String(left.name || "").localeCompare(String(right.name || ""), "en", { sensitivity: "base" }),
    );

  const monthSelection = elements.monthlyFilter.value;
  const selectedMonth =
    monthSelection === "all" || months.includes(monthSelection) ? monthSelection : months[0] || "";
  const memberSelection = elements.monthlyMemberFilter?.value || "all";
  const selectedMember =
    memberSelection !== "all" && filterMembers.some((member) => member.id === memberSelection)
      ? memberSelection
      : "all";

  const monthlyWins = state.wins.filter((win) => {
    if (selectedMonth && selectedMonth !== "all" && getWinPlayMonth(win) !== selectedMonth) {
      return false;
    }
    if (selectedMember !== "all" && win.memberId !== selectedMember) {
      return false;
    }
    return selectedMonth || selectedMember !== "all";
  });
  const monthlyGiveaways = selectedMonth && selectedMonth !== "all" ? getGiveawaysForMonth(selectedMonth) : [];
  const period = selectedMonth && selectedMonth !== "all" ? getPeriodInfo(`${selectedMonth}-01`) : null;

  elements.monthlyFilter.innerHTML = months.length
    ? [`<option value="all" ${selectedMonth === "all" ? "selected" : ""}>All months</option>`]
        .concat(
          months.map(
            (month) =>
              `<option value="${month}" ${month === selectedMonth ? "selected" : ""}>${formatMonthKey(month)}</option>`,
          ),
        )
        .join("")
    : `<option value="">No wins</option>`;

  if (elements.monthlyMemberFilter) {
    elements.monthlyMemberFilter.innerHTML = [
      `<option value="all" ${selectedMember === "all" ? "selected" : ""}>All members</option>`,
    ]
      .concat(
        filterMembers.map(
          (member) =>
            `<option value="${escapeHtml(member.id)}" ${member.id === selectedMember ? "selected" : ""}>${escapeHtml(member.name || "Unknown")} (${memberWinCounts.get(member.id)})</option>`,
        ),
      )
      .join("");
  }

  if (elements.periodSummary) {
    const scope = selectedMonth === "all" ? "All months" : selectedMonth ? formatMonthKey(selectedMonth) : "";
    if (!scope && selectedMember === "all") {
      elements.periodSummary.textContent = "Waiting for synced wins.";
    } else {
      const below = monthlyWins.filter((win) => evaluateMonthlyProgress(win).badge === "danger").length;
      const parts = [];
      if (selectedMember !== "all") {
        parts.push(findById("members", selectedMember)?.name || "Member");
      }
      if (scope) {
        parts.push(scope);
      }
      parts.push(`${monthlyWins.length} win(s)`, `${monthlyWins.length - below} meeting threshold`, `${below} below`);
      if (selectedMember === "all" && period) {
        parts.push(`${monthlyGiveaways.length} giveaway(s)`);
        parts.push(period.kind === "cycle" ? `${period.label}, month ${period.monthPosition} of 3` : period.label);
      }
      elements.periodSummary.textContent = parts.join(" • ");
    }
  }

  renderMonthlyDetailsTable(elements.monthlyProgressTable, monthlyWins);
  renderCycleViews(selectedMonth === "all" ? "" : selectedMonth);
}

function renderCycleViews(selectedMonth) {
  if (!elements.cycleSummary || !elements.cycleTable || !elements.cycleGiveawaysTable) {
    return;
  }

  if (!selectedMonth) {
    elements.cycleSummary.textContent = "Waiting for synced wins.";
    elements.cycleTable.innerHTML = buildEmptyRow(8);
    elements.cycleGiveawaysTable.innerHTML = buildEmptyRow(6);
    return;
  }

  const period = getPeriodInfo(`${selectedMonth}-01`);
  const monthlyGiveaways = getGiveawaysForMonth(selectedMonth).sort(
    (left, right) => parseDate(right.createdAt) - parseDate(left.createdAt),
  );

  elements.cycleSummary.textContent =
    period.kind === "cycle"
      ? `${period.label} • month ${period.monthPosition} of 3 • cycle giveaways count toward obligations, extras stay separate.`
      : `${period.label} • cycle obligations are paused for this month.`;

  if (period.kind !== "cycle") {
    elements.cycleTable.innerHTML = buildMessageRow(
      8,
      period.label,
      "Cycle requirements are paused for this month. Giveaway classification still applies.",
    );
  } else {
    const rule9Carryover = getRule9CarryoverForCycle(selectedMonth);
    const cycleRows = state.members
      .filter((member) => member?.isActiveMember !== false)
      .map((member) => {
        const memberCycleStatus = getCycleMemberStatus(member, selectedMonth);
        const paused = memberCycleStatus === "paused";
        const winsBeforeMonth = computeCycleWinsForMemberInMonth(member.id, selectedMonth, { beforeSelectedMonth: true });
        const cycleWinsToDate = computeCycleWinsForMemberInMonth(member.id, selectedMonth);
        const cycleGiveawaysThisMonth = countMemberGiveawaysForMonth(member.id, selectedMonth, "cycle");
        const extraGiveawaysThisMonth = countMemberGiveawaysForMonth(member.id, selectedMonth, "extra");
        const memberRule9Carryover = isRule9CarryoverWinner(rule9Carryover, member.id) ? rule9Carryover : null;
        const requiredGiveaways = paused
          ? 0
          : getRequiredCycleGiveawaysForMember(member.id, selectedMonth, { rule9Carryover });
        const status = buildCycleStatus({
          period,
          winsBeforeMonth,
          cycleWinsToDate,
          cycleGiveawaysThisMonth,
          requiredGiveaways,
          rule9Carryover: memberRule9Carryover,
          paused,
        });

        return {
          name: member.name,
          markup: `
            <tr>
              <td>${escapeHtml(member.name)}</td>
              <td>${winsBeforeMonth}</td>
              <td>${cycleWinsToDate}</td>
              <td>${cycleGiveawaysThisMonth}</td>
              <td>${extraGiveawaysThisMonth}</td>
              <td>${requiredGiveaways}</td>
              <td>
                <label class="inline-select-wrap">
                  <select class="inline-select" data-cycle-member-status-select="true" data-cycle-member-key="${escapeHtml(getCycleMemberOverrideKey(member, selectedMonth))}">
                    <option value="active" ${memberCycleStatus === "active" ? "selected" : ""}>Active</option>
                    <option value="paused" ${memberCycleStatus === "paused" ? "selected" : ""}>Paused</option>
                  </select>
                </label>
              </td>
              <td>
                ${status.memberTagLabel ? `${buildBadge(status.memberTagLevel, status.memberTagLabel)} ` : ""}${buildBadge(status.level, status.label)}
                <span class="meta-line">${escapeHtml(status.note)}</span>
              </td>
            </tr>
          `,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }));

    elements.cycleTable.innerHTML = cycleRows.length
      ? cycleRows.map((row) => row.markup).join("")
      : buildEmptyRow(8);
  }

  elements.cycleGiveawaysTable.innerHTML = monthlyGiveaways.length
    ? monthlyGiveaways
        .map((giveaway) => {
          const creator = findById("members", giveaway.creatorId);
          const giveawayUrl = String(giveaway.notes || "").trim();
          const kind = getGiveawayKind(giveaway);
          return `
            <tr>
              <td>${escapeHtml(creator?.name || "Unknown member")}</td>
              <td>
                <strong>${giveawayUrl ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(giveaway.title)}</a>` : escapeHtml(giveaway.title)}</strong>
                <span class="meta-line">${formatDate(giveaway.createdAt)}</span>
              </td>
              <td>${formatMonthKey(selectedMonth)}</td>
              <td>
                <label class="inline-select-wrap">
                  <select class="inline-select" data-giveaway-kind-select="true" data-giveaway-id="${giveaway.id}">
                    <option value="cycle" ${kind === "cycle" ? "selected" : ""}>Cycle</option>
                    <option value="extra" ${kind === "extra" ? "selected" : ""}>Extra</option>
                    <option value="pop_free" ${kind === "pop_free" ? "selected" : ""}>PoP Free</option>
                    <option value="penalty" ${kind === "penalty" ? "selected" : ""}>Penalty</option>
                    <option value="summer_event" ${kind === "summer_event" ? "selected" : ""}>Summer event</option>
                  </select>
                </label>
                <span class="meta-line">${describeGiveawayKind(kind)}</span>
              </td>
              <td>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")}</td>
              <td>${buildBadge(getGiveawayKindBadgeLevel(kind), getGiveawayKindLabel(kind))}</td>
            </tr>
          `;
        })
        .join("")
    : buildMessageRow(6, "No giveaways in this month.", "Use the month filter to inspect a different cycle month.");
}

function renderCycleHistoryPage() {
  if (!elements.cycleFilter || !elements.cycleSummary || !elements.cycleTable || !elements.cycleGiveawaysTable) {
    return;
  }

  const cycles = getAvailableCycles();
  const currentSelection = elements.cycleFilter.value;
  const selectedCycleKey = cycles.some((cycle) => cycle.key === currentSelection) ? currentSelection : cycles[0]?.key || "";

  elements.cycleFilter.innerHTML = cycles.length
    ? cycles
        .map(
          (cycle) =>
            `<option value="${cycle.key}" ${cycle.key === selectedCycleKey ? "selected" : ""}>${escapeHtml(cycle.label)}</option>`,
        )
        .join("")
    : `<option value="">No cycles</option>`;

  if (!selectedCycleKey) {
    elements.cycleSummary.textContent = "Waiting for synced cycle history.";
    if (elements.cycleBestGifterWarning) {
      elements.cycleBestGifterWarning.innerHTML = "";
    }
    elements.cycleTable.innerHTML = buildEmptyRow(6);
    elements.cycleGiveawaysTable.innerHTML = buildEmptyRow(6);
    return;
  }

  const selectedCycle = cycles.find((cycle) => cycle.key === selectedCycleKey);
  const cycleMonths = getRenderableCycleMonths(selectedCycle);
  const cycleWins = state.wins
    .filter((win) => cycleMonths.includes(getEffectiveWinMonth(win)))
    .sort(
      (left, right) =>
        String(getEffectiveWinMonth(right)).localeCompare(String(getEffectiveWinMonth(left)), "en-US") ||
        parseDate(right.winDate) - parseDate(left.winDate),
    );
  const cycleGiveaways = state.giveaways
    .filter((giveaway) => getGiveawayKind(giveaway) !== "summer_event" && cycleMonths.includes(getGiveawayMonth(giveaway)))
    .sort((left, right) => parseDate(right.createdAt) - parseDate(left.createdAt));
  const countableCycleGiveaways = cycleGiveaways.filter((giveaway) => doesGiveawayCountForCycleMath(giveaway));
  const cycleOnlyWins = cycleWins.filter((win) => getWinTrackKind(win) === "cycle");
  const cycleGiveawayCount = countableCycleGiveaways.filter((giveaway) => getGiveawayKind(giveaway) === "cycle").length;
  const extraGiveawayCount = countableCycleGiveaways.filter((giveaway) => getGiveawayKind(giveaway) === "extra").length;
  const bestGifterAward = buildCycleBestGifterAward(selectedCycle, cycleMonths, cycleGiveaways);
  const rule9Carryover = getRule9CarryoverForCycle(selectedCycle);

  elements.cycleSummary.textContent = `${selectedCycle.label} • ${cycleMonths.map(formatMonthKey).join(" • ")} • ${cycleOnlyWins.length} cycle win(s) • ${cycleGiveawayCount} cycle giveaway(s) • ${extraGiveawayCount} extra giveaway(s)`;
  renderCycleBestGifterWarning(bestGifterAward, selectedCycle, cycleMonths, rule9Carryover);

  renderCycleHistoryMembersTable(selectedCycle, cycleMonths, cycleWins, cycleGiveaways, rule9Carryover);

  if (elements.cycleGiveawayMonthFilter) {
    const previousMonth = elements.cycleGiveawayMonthFilter.value;
    elements.cycleGiveawayMonthFilter.innerHTML = [`<option value="all">All months</option>`]
      .concat(cycleMonths.map((month) => `<option value="${month}">${escapeHtml(formatMonthKey(month))}</option>`))
      .join("");
    elements.cycleGiveawayMonthFilter.value = cycleMonths.includes(previousMonth) ? previousMonth : "all";
  }

  renderCycleHistoryResultsTable(cycleGiveaways);
}

function renderCycleBestGifterWarning(bestGifterAward, selectedCycle, cycleMonths, rule9Carryover) {
  if (!elements.cycleBestGifterWarning) {
    return;
  }

  const articles = [];

  if (rule9Carryover?.status === "winner" && rule9Carryover.monthKey) {
    articles.push(`
      <article class="alert-card info compact-alert">
        <h3>Previous cycle exemption</h3>
        <p><strong>${escapeHtml(rule9Carryover.memberName)}</strong> won Rule 9 in ${escapeHtml(rule9Carryover.previousCycle.label)} and is exempt from the regular mandatory giveaway in ${escapeHtml(formatMonthKey(rule9Carryover.monthKey))}.</p>
      </article>
    `);
  } else if (rule9Carryover?.status === "tie" && rule9Carryover.monthKey) {
    articles.push(`
      <article class="alert-card warning compact-alert">
        <h3>Previous cycle exemption pending</h3>
        <p>${escapeHtml(rule9Carryover.tieMembers.join(", "))} are tied for Rule 9 in ${escapeHtml(rule9Carryover.previousCycle.label)}, so the month 1 exemption for ${escapeHtml(formatMonthKey(rule9Carryover.monthKey))} still needs an admin tie-break.</p>
      </article>
    `);
  }

  if (!bestGifterAward.eligibleCount) {
    articles.push(`
      <article class="alert-card info compact-alert">
        <h3>Best gifter not decided yet</h3>
        <p>Rule 9 needs at least 2 cycle giveaways from a member before someone can take the exemption lead in ${escapeHtml(selectedCycle.label)}.</p>
      </article>
    `);
    elements.cycleBestGifterWarning.innerHTML = articles.join("");
    return;
  }

  const nextMonthInfo = getNextCycleExemptionInfo(selectedCycle.months);
  if (bestGifterAward.tieMembers.length > 1) {
    articles.push(`
      <article class="alert-card warning compact-alert">
        <h3>Best gifter tie</h3>
        <p>${escapeHtml(bestGifterAward.tieMembers.join(", "))} are tied on average entries in ${escapeHtml(selectedCycle.label)}. Highest single giveaway entries are also tied, so this still needs an admin tie-break.</p>
      </article>
    `);
    elements.cycleBestGifterWarning.innerHTML = articles.join("");
    return;
  }

  const gifterLabel = bestGifterAward.isComplete ? "Best gifter of the cycle" : "Best gifter so far";
  const exemptionText = bestGifterAward.isComplete
    ? nextMonthInfo.hasMandatoryGiveaway
      ? `${bestGifterAward.winnerName} is exempt from the regular mandatory giveaway in ${nextMonthInfo.label}.`
      : `${bestGifterAward.winnerName} wins Rule 9, but the next month is ${nextMonthInfo.label}, so there is no regular mandatory giveaway to waive there.`
    : nextMonthInfo.hasMandatoryGiveaway
      ? `If ${bestGifterAward.winnerName} stays ahead through the end of the cycle, the Rule 9 exemption will apply in ${nextMonthInfo.label}.`
      : `If ${bestGifterAward.winnerName} stays ahead through the end of the cycle, the exemption lands in ${nextMonthInfo.label}, which has no regular mandatory giveaway.`;
  articles.push(`
    <article class="alert-card warning compact-alert">
      <h3>${escapeHtml(gifterLabel)}</h3>
      <p>
        <strong>${escapeHtml(bestGifterAward.winnerName)}</strong> averages ${bestGifterAward.averageEntries.toFixed(1)} entries across ${bestGifterAward.giveawayCount} cycle giveaway(s), with a best single result of ${bestGifterAward.bestSingleEntries.toLocaleString("en-US")} entries.<br />
        ${escapeHtml(exemptionText)}
      </p>
    </article>
  `);
  elements.cycleBestGifterWarning.innerHTML = articles.join("");
}

function renderCycleHistoryMembersTable(selectedCycle, cycleMonths, cycleWins, cycleGiveaways, rule9Carryover) {
  const rows = getCycleHistoryVisibleMembers(selectedCycle, cycleWins, cycleGiveaways)
    .map((member) => {
      const memberCycleStatus = getCycleMemberStatus(member, selectedCycle.key);
      const paused = memberCycleStatus === "paused";
      const thirdMonth = cycleMonths[2] || "";
      const winsBeforeMonthThree = thirdMonth
        ? cycleWins.filter(
            (win) =>
              win.memberId === member.id &&
              getWinTrackKind(win) === "cycle" &&
              getEffectiveWinMonth(win) < thirdMonth,
          ).length
        : 0;
      const cycleWinsTotal = cycleWins.filter(
        (win) => win.memberId === member.id && getWinTrackKind(win) === "cycle",
      ).length;
      const cycleGiveawaysTotal = cycleGiveaways.filter(
        (giveaway) =>
          giveaway.creatorId === member.id &&
          getGiveawayKind(giveaway) === "cycle" &&
          doesGiveawayCountForCycleMath(giveaway),
      ).length;
      const extraGiveawaysTotal = cycleGiveaways.filter(
        (giveaway) =>
          giveaway.creatorId === member.id &&
          getGiveawayKind(giveaway) === "extra" &&
          doesGiveawayCountForCycleMath(giveaway),
      ).length;
      const cycleEntries = cycleGiveaways
        .filter(
          (giveaway) =>
            giveaway.creatorId === member.id &&
            getGiveawayKind(giveaway) === "cycle" &&
            doesGiveawayCountForCycleMath(giveaway),
        )
        .map((giveaway) => Number(giveaway.entriesCount || 0));
      const averageEntries = cycleEntries.length
        ? cycleEntries.reduce((sum, value) => sum + value, 0) / cycleEntries.length
        : null;
      const bestEntries = cycleEntries.length ? Math.max(...cycleEntries) : 0;
      const memberRule9Carryover = isRule9CarryoverWinner(rule9Carryover, member.id) ? rule9Carryover : null;
      const requiredGiveaways = paused
        ? 0
        : getRequiredCycleGiveawaysForCycle(member.id, cycleMonths, { rule9Carryover });
      const status = buildCycleHistoryStatus({
        cycleMonths,
        winsBeforeMonthThree,
        cycleWinsTotal,
        cycleGiveawaysTotal,
        requiredGiveaways,
        rule9Carryover: memberRule9Carryover,
        paused,
      });

      return {
        name: member.name,
        markup: `
          <tr>
            <td>${escapeHtml(member.name)}</td>
            <td>
              <strong>${cycleWinsTotal}</strong>
              <span class="meta-line">Before M3: ${winsBeforeMonthThree}</span>
            </td>
            <td>
              <strong>${cycleGiveawaysTotal}</strong>
              <span class="meta-line">Extra: ${extraGiveawaysTotal} • Required: ${requiredGiveaways}</span>
            </td>
            <td>
              <strong>${averageEntries === null ? "-" : averageEntries.toFixed(1)}</strong>
              <span class="meta-line">Best: ${bestEntries ? bestEntries.toLocaleString("en-US") : "-"}</span>
            </td>
            <td>
              <label class="inline-select-wrap compact-select-wrap">
                <select class="inline-select" data-cycle-member-status-select="true" data-cycle-member-key="${escapeHtml(getCycleMemberOverrideKey(member, selectedCycle.key))}">
                  <option value="active" ${memberCycleStatus === "active" ? "selected" : ""}>Active</option>
                  <option value="paused" ${memberCycleStatus === "paused" ? "selected" : ""}>Paused</option>
                </select>
              </label>
            </td>
            <td>
              ${status.memberTagLabel ? `${buildBadge(status.memberTagLevel, status.memberTagLabel)} ` : ""}${buildBadge(status.level, status.label)}
              <span class="meta-line compact-meta-line">${escapeHtml(status.note)}</span>
            </td>
          </tr>
        `,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }));

  elements.cycleTable.innerHTML = rows.length
    ? rows.map((row) => row.markup).join("")
    : buildMessageRow(6, "No tracked members in this cycle.", "Wins and giveaway creators for the selected cycle will appear here.");
}

function getCycleHistoryVisibleMembers(selectedCycle, cycleWins, cycleGiveaways) {
  const cycleKey = String(selectedCycle?.key || "").trim();
  // Inclusion is about CREATING cycle giveaways, not winning. Winning a giveaway
  // never puts someone on this list.
  const cycleCreatorIds = new Set(
    cycleGiveaways
      .filter((giveaway) => getGiveawayKind(giveaway) === "cycle")
      .map((giveaway) => giveaway.creatorId)
      .filter(Boolean),
  );

  return state.members.filter((member) => {
    // Paused = exempt this cycle, so hide them from the obligations list.
    if (cycleKey && getCycleMemberStatus(member, cycleKey) === "paused") {
      return false;
    }
    // Every active member (so those who still owe a cycle giveaway are flagged
    // as pending), plus anyone who created a cycle giveaway even if now inactive.
    return member.isActiveMember || cycleCreatorIds.has(member.id);
  });
}

function getCycleGiveawayCreatorLabel(giveaway) {
  return String(findById("members", giveaway.creatorId)?.name || giveaway.creatorUsername || "").trim();
}

function getCycleGiveawayWinnerLabel(giveaway) {
  const manualWinners = getGiveawayManualWinners(giveaway);
  if (manualWinners.length) {
    return manualWinners
      .map((winner) => winner.displayName || findMemberByUsername(winner.username)?.name || winner.username)
      .join(", ");
  }
  return findWinsForGiveaway(giveaway)
    .map((win) => String(findById("members", win.memberId)?.name || "").trim())
    .filter(Boolean)
    .join(", ");
}

function sortCycleGiveaways(giveaways, sortValue) {
  const sorted = giveaways.slice();
  sorted.sort((left, right) => {
    switch (sortValue) {
      case "created-asc":
        return parseDate(left.createdAt) - parseDate(right.createdAt);
      case "creator-asc":
        return (
          getCycleGiveawayCreatorLabel(left).localeCompare(getCycleGiveawayCreatorLabel(right), "en-US", { sensitivity: "base" }) ||
          parseDate(right.createdAt) - parseDate(left.createdAt)
        );
      case "creator-desc":
        return (
          getCycleGiveawayCreatorLabel(right).localeCompare(getCycleGiveawayCreatorLabel(left), "en-US", { sensitivity: "base" }) ||
          parseDate(right.createdAt) - parseDate(left.createdAt)
        );
      case "winner-asc":
        return (
          getCycleGiveawayWinnerLabel(left).localeCompare(getCycleGiveawayWinnerLabel(right), "en-US", { sensitivity: "base" }) ||
          parseDate(right.createdAt) - parseDate(left.createdAt)
        );
      case "winner-desc":
        return (
          getCycleGiveawayWinnerLabel(right).localeCompare(getCycleGiveawayWinnerLabel(left), "en-US", { sensitivity: "base" }) ||
          parseDate(right.createdAt) - parseDate(left.createdAt)
        );
      case "created-desc":
      default:
        return parseDate(right.createdAt) - parseDate(left.createdAt);
    }
  });
  return sorted;
}

function renderCycleHistoryResultsTable(cycleGiveaways) {
  const monthFilter = String(elements.cycleGiveawayMonthFilter?.value || "all");
  const sortValue = String(elements.cycleGiveawaySort?.value || "created-desc");
  const filteredGiveaways = sortCycleGiveaways(
    monthFilter === "all" ? cycleGiveaways : cycleGiveaways.filter((giveaway) => getGiveawayMonth(giveaway) === monthFilter),
    sortValue,
  );

  elements.cycleGiveawaysTable.innerHTML = filteredGiveaways.length
    ? filteredGiveaways
        .map((giveaway) => {
          const creator = findById("members", giveaway.creatorId);
          const giveawayWins = findWinsForGiveaway(giveaway);
          const manualWinners = getGiveawayManualWinners(giveaway);
          const winnerMarkup = manualWinners.length
            ? manualWinners.map((winner) => buildManualWinnerMarkup(winner)).join(", ")
            : giveawayWins.length
              ? giveawayWins.map((win) => buildWinnerMarkup(findById("members", win.memberId))).join(", ")
              : "-";
          const winnerKey = getGiveawayCodeKey(giveaway);
          const currentWinnerNames = (manualWinners.length
            ? manualWinners.map((winner) => winner.username)
            : giveawayWins
                .map((win) => {
                  const member = findById("members", win.memberId);
                  return String(member?.steamgiftsUsername || member?.name || "").trim();
                })
                .filter(Boolean)
          ).join(", ");
          const giveawayUrl = String(giveaway.notes || "").trim();
          const kind = getGiveawayKind(giveaway);
          const giveawayMonth = getGiveawayMonth(giveaway);
          return `
            <tr>
              <td>
                <div>${giveawayMonth ? formatMonthKey(giveawayMonth) : "-"}</div>
                <button class="inline-action" data-edit-action="giveaway-month" data-giveaway-id="${giveaway.id}">Edit month</button>
              </td>
              <td>${escapeHtml(creator?.name || "Unknown member")}</td>
              <td>
                <strong>${giveawayUrl ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(giveaway.title)}</a>` : escapeHtml(giveaway.title)}</strong>
                <span class="meta-line">${formatDate(giveaway.createdAt)}</span>
              </td>
              <td>
                <div>${winnerMarkup}${manualWinners.length ? ` ${buildBadge("info", "Manual")}` : ""}</div>
                ${canEditGiveawayWinner(giveaway) ? `<button class="inline-action" data-edit-action="winner" data-giveaway-key="${escapeHtml(winnerKey)}" data-current-winners="${escapeHtml(currentWinnerNames)}">Edit winner</button>` : ""}
              </td>
              <td>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")}</td>
              <td>
                <label class="inline-select-wrap compact-select-wrap">
                  <select class="inline-select" data-giveaway-kind-select="true" data-giveaway-id="${giveaway.id}">
                    <option value="cycle" ${kind === "cycle" ? "selected" : ""}>Cycle</option>
                    <option value="extra" ${kind === "extra" ? "selected" : ""}>Extra</option>
                    <option value="pop_free" ${kind === "pop_free" ? "selected" : ""}>PoP Free</option>
                    <option value="penalty" ${kind === "penalty" ? "selected" : ""}>Penalty</option>
                    <option value="summer_event" ${kind === "summer_event" ? "selected" : ""}>Summer event</option>
                  </select>
                </label>
                <span class="meta-line compact-meta-line">${describeGiveawayKind(kind)}</span>
              </td>
            </tr>
          `;
        })
        .join("")
    : buildMessageRow(6, "No giveaways match the current filters.", "Giveaways from the selected cycle will appear here.");
}

function renderSummerEventPage() {
  if (!elements.summerEventSummaryCards && !elements.summerEventMemberGrid && !elements.summerEventGiveawaysTable) {
    return;
  }

  const allGiveaways = getTrackedSummerEventGiveaways();
  if (!allGiveaways.length) {
    if (elements.summerEventFilter) {
      elements.summerEventFilter.innerHTML = "";
    }
    if (elements.summerEventDescription) {
      elements.summerEventDescription.textContent = "Tag a giveaway as Summer event and refresh the sync to start tracking event balances.";
    }
    if (elements.summerEventSummaryCards) {
      elements.summerEventSummaryCards.innerHTML = buildEmptyPanel(
        "No summer event giveaways yet.",
        "Summer-event giveaways will appear here after they are tagged in the sync.",
      );
    }
    if (elements.summerEventMemberGrid) {
      elements.summerEventMemberGrid.innerHTML = buildEmptyPanel(
        "No participant balances yet.",
        "Tracked creators and entrants will show up here once summer-event giveaways are synced.",
      );
    }
    if (elements.summerEventGiveawaysTable) {
      elements.summerEventGiveawaysTable.innerHTML = buildMessageRow(
        7,
        "No summer-event giveaways tracked.",
        "Run the sync again after tagging a giveaway as Summer event.",
      );
    }
    return;
  }

  const periods = getSummerEventPeriods(allGiveaways);
  const selectedKey = periods.some((period) => period.key === elements.summerEventFilter?.value)
    ? elements.summerEventFilter.value
    : periods[0].key;
  const selectedPeriod = periods.find((period) => period.key === selectedKey) || periods[0];

  if (elements.summerEventFilter) {
    elements.summerEventFilter.innerHTML = periods
      .map(
        (period) => `<option value="${period.key}">${escapeHtml(period.label)}</option>`,
      )
      .join("");
    elements.summerEventFilter.value = selectedPeriod.key;
  }

  const giveaways = allGiveaways
    .filter((giveaway) => getSummerEventPeriodDescriptor(giveaway).key === selectedPeriod.key)
    .sort((left, right) => String(right.endDate || "").localeCompare(String(left.endDate || "")));
  const summerEventMemberIndex = getSummerEventMemberIndex();
  const standings = computeSummerEventStandings(giveaways, summerEventMemberIndex);
  const trackedEntries = giveaways.reduce((sum, giveaway) => sum + getSummerEventEntryUsers(giveaway).length, 0);
  const trackedGiveaways = giveaways.length;
  const giveawaysWithEntries = giveaways.filter((giveaway) => getSummerEventEntryUsers(giveaway).length > 0).length;
  const giveawaysWithWinner = giveaways.filter(
    (giveaway) =>
      getSummerEventEntryUsers(giveaway).length > 0
      && Array.isArray(giveaway.winners)
      && giveaway.winners.length > 0,
  ).length;
  const pendingSnapshots = giveaways.filter(isSummerEventSnapshotPending).length;
  const blockedParticipants = standings.filter((participant) => participant.balance < 0).length;

  if (elements.summerEventDescription) {
    const blockedLabel = blockedParticipants
      ? ` ${blockedParticipants} participant${blockedParticipants === 1 ? " is" : "s are"} below zero and should stop entering new giveaways.`
      : "";
    elements.summerEventDescription.textContent = `${selectedPeriod.label} has ${giveawaysWithEntries} tracked giveaway${giveawaysWithEntries === 1 ? "" : "s"} with entries, ${giveawaysWithWinner} with a winner, ${trackedEntries.toLocaleString("en-US")} tracked entr${trackedEntries === 1 ? "y" : "ies"}, and ${pendingSnapshots} snapshot${pendingSnapshots === 1 ? "" : "s"} still waiting for a final post-close capture.${blockedLabel}`;
  }

  if (elements.summerEventSummaryCards) {
    const cards = [
      ["Tracked giveaways", trackedGiveaways],
      ["With a winner", giveawaysWithWinner],
      ["Participants", standings.length],
      ["Tracked entries", trackedEntries.toLocaleString("en-US")],
      ["Pending final snapshots", pendingSnapshots],
    ];
    elements.summerEventSummaryCards.innerHTML = cards
      .map(
        ([label, value]) => `
          <article class="summary-card">
            <strong>${value}</strong>
            <span>${label}</span>
          </article>
        `,
      )
      .join("");
  }

  if (elements.summerEventMemberGrid) {
    elements.summerEventMemberGrid.innerHTML = standings.length
      ? standings
          .map((participant) => {
            const profileMarkup = participant.profileUrl
              ? `<a class="linked-title" href="${escapeHtml(participant.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(participant.displayName)}</a>`
              : escapeHtml(participant.displayName);
            const balanceBadge = participant.balance < 0
              ? buildBadge("danger", "ENTRY BLOCKED")
              : participant.balance === 0
                ? buildBadge("warning", "AT LIMIT")
                : buildBadge("success", "CAN ENTER");
            const activityBadge = participant.isActiveMember ? buildBadge("info", "Active member") : "";
            const wonCreatedRatio = buildSummerEventRatioMarkup(participant.wonGiveaways, participant.createdGiveaways);
            const wonPointsCreatedRatio = buildSummerEventRatioMarkup(participant.wonPoints, participant.createdPoints);
            return `
              <article class="member-card${participant.balance < 0 ? " negative" : participant.balance === 0 ? " neutral" : ""}">
                <h3>${profileMarkup}</h3>
                <div class="member-card-badges">${balanceBadge}${activityBadge ? ` ${activityBadge}` : ""}</div>
                <strong>${escapeHtml(formatPointBalance(participant.balance))}</strong>
                <div class="member-card-meta">
                  <span>Created: ${participant.createdGiveaways} • +${participant.createdPoints.toLocaleString("en-US")} P</span>
                  <span>Won: ${participant.wonGiveaways} • Won/Created ratio: ${wonCreatedRatio}</span>
                  <span>Won base: +${participant.wonPoints.toLocaleString("en-US")} P • Base ratio: ${wonPointsCreatedRatio}</span>
                  <span>Entry bonus: +${participant.entryBonusPoints.toLocaleString("en-US")} P from ${participant.receivedEntries.toLocaleString("en-US")} entr${participant.receivedEntries === 1 ? "y" : "ies"}</span>
                  <span>Joined: ${participant.joinedGiveaways} • -${participant.entryCostPoints.toLocaleString("en-US")} P</span>
                </div>
              </article>
            `;
          })
          .join("")
      : buildEmptyPanel(
          "No participant balances yet.",
          "Summer-event creators and entrants will appear here after the first synced entry snapshot.",
        );
  }

  if (elements.summerEventGiveawaysTable) {
    const creatorFilter = String(elements.summerEventCreatorFilter?.value || "").trim().toLowerCase();
    const winnerFilter = String(elements.summerEventWinnerFilter?.value || "").trim().toLowerCase();
    const sortValue = String(elements.summerEventSort?.value || "ended-desc");
    const filteredGiveaways = sortSummerEventGiveaways(
      giveaways.filter((giveaway) => {
        const creatorLabel = getSummerEventCreatorLabel(giveaway, summerEventMemberIndex).toLowerCase();
        const winnerLabels = getSummerEventWinnerUsers(giveaway).map((winner) => winner.toLowerCase());
        const matchesCreator = !creatorFilter || creatorLabel.includes(creatorFilter);
        const matchesWinner = !winnerFilter || winnerLabels.some((winner) => winner.includes(winnerFilter));
        return matchesCreator && matchesWinner;
      }),
      sortValue,
      summerEventMemberIndex,
    );

    elements.summerEventGiveawaysTable.innerHTML = filteredGiveaways.length
      ? filteredGiveaways
          .map((giveaway) => {
            const creator = summerEventMemberIndex.get(giveaway.creatorUsername) || null;
            const creatorLabel = creator?.displayName || giveaway.creatorUsername || "Unknown member";
            const creatorMarkup = creator?.profileUrl
              ? `<a class="linked-title" href="${escapeHtml(creator.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(creatorLabel)}</a>`
              : escapeHtml(creatorLabel);
            const giveawayUrl = String(giveaway.url || "").trim();
            const titleMarkup = giveawayUrl
              ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(giveaway.title || "Untitled giveaway")}</a>`
              : escapeHtml(giveaway.title || "Untitled giveaway");
            const entryUsers = getSummerEventEntryUsers(giveaway);
            const rewardPoints = getSummerEventBasePoints(giveaway);
            const entryDelta = getSummerEventEntryDelta(giveaway);
            const entryPoints = entryUsers.length * entryDelta;
            const totalPoints = rewardPoints + entryPoints;
            const winners = getSummerEventWinnerUsers(giveaway);
            const manualWinnerSet = hasManualWinners(giveaway);
            const winnerKey = getGiveawayCodeKey(giveaway);
            const winnerMarkup = winners.length
              ? winners
                  .map((username) => {
                    const winner = summerEventMemberIndex.get(username) || null;
                    const winnerLabel = winner?.displayName || username;
                    return winner?.profileUrl
                      ? `<a class="linked-title" href="${escapeHtml(winner.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(winnerLabel)}</a>`
                      : escapeHtml(winnerLabel);
                  })
                  .join(", ")
              : "-";
            const resultStatus = manualWinnerSet ? "won" : String(giveaway.resultStatus || "").toLowerCase();
            const resultBadge = resultStatus === "won"
              ? buildBadge("success", "Winner drawn")
              : resultStatus === "no_winners"
                ? buildBadge("warning", "No winners")
                : resultStatus === "awaiting_feedback"
                  ? buildBadge("info", "Awaiting feedback")
                  : buildBadge("info", "Open");
            const resultMeta = resultStatus === "won"
              ? `${winners.length} winner${winners.length === 1 ? "" : "s"} confirmed`
              : giveaway.resultLabel || "Still running";
            const thumb = buildImageMarkup({
              className: "giveaway-thumb",
              alt: giveaway.title || "Giveaway",
              appId: giveaway.appId,
              sources: [giveaway.capsuleSmallUrl, giveaway.headerImageUrl, giveaway.capsuleImageUrl],
              placeholder: "—",
            });
            const thumbCell = giveaway.steamAppUrl
              ? `<a href="${escapeHtml(giveaway.steamAppUrl)}" target="_blank" rel="noreferrer">${thumb}</a>`
              : thumb;
            return `
              <tr>
                <td>${thumbCell}</td>
                <td>
                  <strong>${titleMarkup}</strong>
                  <span class="meta-line">Created: ${escapeHtml(formatDateTime(getGiveawayCreatedDisplay(giveaway)))}</span>
                  <span class="meta-line">End date: ${escapeHtml(formatDateTime(getGiveawayEndedDisplay(giveaway)))}</span>
                </td>
                <td>
                  <strong>${creatorMarkup}</strong>
                </td>
                <td>
                  <strong>${rewardPoints.toLocaleString("en-US")} P</strong>
                  <span class="meta-line">${getSummerEventValueMeta(giveaway)}</span>
                  ${getSummerEventBasePointsOverride(giveaway) !== null ? `<span class="meta-line override-note">Manual base</span>` : ""}
                  <button class="inline-action" data-edit-action="summer-base-points" data-giveaway-key="${escapeHtml(winnerKey)}" data-giveaway-title="${escapeHtml(giveaway.title || "")}" data-current-base="${escapeHtml(String(getSummerEventBasePointsOverride(giveaway) ?? ""))}">Edit base</button>
                </td>
                <td>
                  <strong>${entryPoints.toLocaleString("en-US")} P</strong>
                  <span class="meta-line">${entryUsers.length.toLocaleString("en-US")} × ${entryDelta} P</span>
                </td>
                <td>
                  <strong>${totalPoints.toLocaleString("en-US")} P</strong>
                </td>
                <td>
                  <strong>${entryUsers.length.toLocaleString("en-US")}</strong>
                </td>
                <td>
                  <strong>${winnerMarkup}</strong>${manualWinnerSet ? ` ${buildBadge("info", "Manual")}` : ""}
                  <span class="meta-line">${escapeHtml(winners.length ? `${winners.length} winner${winners.length === 1 ? "" : "s"}` : resultStatus === "no_winners" ? "No winners" : "No winner yet")}</span>
                  ${canEditGiveawayWinner(giveaway) ? `<button class="inline-action" data-edit-action="winner" data-giveaway-key="${escapeHtml(winnerKey)}" data-current-winners="${escapeHtml(winners.join(", "))}">Edit winner</button>` : ""}
                </td>
                <td>
                  ${resultBadge}
                  <span class="meta-line">${escapeHtml(resultMeta)}</span>
                </td>
                <td>
                  ${buildSummerEventSnapshotBadge(giveaway)}
                  <span class="meta-line">${escapeHtml(giveaway.entriesSnapshotAt ? `Updated ${formatDateTime(giveaway.entriesSnapshotAt)}` : "No entries snapshot yet")}</span>
                </td>
              </tr>
            `;
          })
          .join("")
      : buildMessageRow(
          10,
          giveaways.length ? "No summer-event giveaways match the current filters." : "No summer-event giveaways in this event.",
          giveaways.length ? "Adjust the creator, winner, or sort controls to see more giveaways." : "Choose another event or tag more giveaways as Summer event.",
        );
  }
}

function renderSummerEventEntriesPage() {
  if (!elements.summerEntrySummaryCards && !elements.summerEntryTable) {
    return;
  }

  const allGiveaways = getTrackedSummerEventGiveaways();
  if (!allGiveaways.length) {
    if (elements.summerEntryEventFilter) {
      elements.summerEntryEventFilter.innerHTML = "";
    }
    if (elements.summerEntryMemberFilter) {
      elements.summerEntryMemberFilter.innerHTML = '<option value="">All entrants</option>';
    }
    if (elements.summerEntryCreatorFilter) {
      elements.summerEntryCreatorFilter.innerHTML = '<option value="">All creators</option>';
    }
    if (elements.summerEntryDescription) {
      elements.summerEntryDescription.textContent = "Summer-event entry deductions appear here after the first synced entrant snapshot.";
    }
    if (elements.summerEntrySummaryCards) {
      elements.summerEntrySummaryCards.innerHTML = buildEmptyPanel(
        "No counted summer-event entries yet.",
        "Run the sync again after tagging giveaways as Summer event and capturing entrant snapshots.",
      );
    }
    if (elements.summerEntryTable) {
      elements.summerEntryTable.innerHTML = buildMessageRow(
        7,
        "No summer-event entry deductions yet.",
        "Once entrants are tracked on a summer-event giveaway, each counted deduction will appear here.",
      );
    }
    return;
  }

  const periods = getSummerEventPeriods(allGiveaways);
  const selectedEventKey = periods.some((period) => period.key === elements.summerEntryEventFilter?.value)
    ? elements.summerEntryEventFilter.value
    : periods[0]?.key;
  const selectedPeriod = periods.find((period) => period.key === selectedEventKey) || periods[0];

  if (elements.summerEntryEventFilter) {
    elements.summerEntryEventFilter.innerHTML = periods
      .map(
        (period) => `<option value="${escapeHtml(period.key)}">${escapeHtml(period.label)}</option>`,
      )
      .join("");
    elements.summerEntryEventFilter.value = selectedPeriod.key;
  }

  const giveaways = allGiveaways
    .filter((giveaway) => getSummerEventPeriodDescriptor(giveaway).key === selectedPeriod.key)
    .sort((left, right) => String(right.endDate || "").localeCompare(String(left.endDate || "")));
  const summerEventMemberIndex = getSummerEventMemberIndex();
  const ledgerRows = buildSummerEventEntryLedger(giveaways, summerEventMemberIndex);

  const entrantOptions = getDistinctSummerEntryOptions(ledgerRows, "entrantUsername", "entrantLabel");
  const creatorOptions = getDistinctSummerEntryOptions(ledgerRows, "creatorUsername", "creatorLabel");
  const selectedEntrant = entrantOptions.some((option) => option.value === elements.summerEntryMemberFilter?.value)
    ? elements.summerEntryMemberFilter.value
    : "";
  const selectedCreator = creatorOptions.some((option) => option.value === elements.summerEntryCreatorFilter?.value)
    ? elements.summerEntryCreatorFilter.value
    : "";

  if (elements.summerEntryMemberFilter) {
    elements.summerEntryMemberFilter.innerHTML = [
      '<option value="">All entrants</option>',
      ...entrantOptions.map(
        (option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
      ),
    ].join("");
    elements.summerEntryMemberFilter.value = selectedEntrant;
  }

  if (elements.summerEntryCreatorFilter) {
    elements.summerEntryCreatorFilter.innerHTML = [
      '<option value="">All creators</option>',
      ...creatorOptions.map(
        (option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
      ),
    ].join("");
    elements.summerEntryCreatorFilter.value = selectedCreator;
  }

  const filteredRows = sortSummerEventEntryLedger(
    ledgerRows.filter((row) => (!selectedEntrant || row.entrantUsername === selectedEntrant) && (!selectedCreator || row.creatorUsername === selectedCreator)),
    String(elements.summerEntrySort?.value || "ended-desc"),
  );
  const totalDeducted = filteredRows.reduce((sum, row) => sum + row.entryDelta, 0);
  const uniqueEntrants = new Set(filteredRows.map((row) => row.entrantUsername)).size;
  const uniqueGiveaways = new Set(filteredRows.map((row) => row.giveaway.code || row.giveaway.url || row.giveaway.title || "")).size;

  if (elements.summerEntryDescription) {
    const entrantLabel = selectedEntrant
      ? ` for ${summerEventMemberIndex.get(selectedEntrant)?.displayName || selectedEntrant}`
      : "";
    const creatorLabel = selectedCreator
      ? ` created by ${summerEventMemberIndex.get(selectedCreator)?.displayName || selectedCreator}`
      : "";
    elements.summerEntryDescription.textContent = `${selectedPeriod.label} has ${ledgerRows.length.toLocaleString("en-US")} counted entr${ledgerRows.length === 1 ? "y" : "ies"} costing ${ledgerRows.reduce((sum, row) => sum + row.entryDelta, 0).toLocaleString("en-US")} P in total. Showing ${filteredRows.length.toLocaleString("en-US")} row${filteredRows.length === 1 ? "" : "s"}${entrantLabel}${creatorLabel}.`;
  }

  if (elements.summerEntrySummaryCards) {
    const cards = [
      ["Rows shown", filteredRows.length.toLocaleString("en-US")],
      ["Points deducted", `${totalDeducted.toLocaleString("en-US")} P`],
      ["Entrants shown", uniqueEntrants.toLocaleString("en-US")],
      ["Giveaways touched", uniqueGiveaways.toLocaleString("en-US")],
    ];
    elements.summerEntrySummaryCards.innerHTML = cards
      .map(
        ([label, value]) => `
          <article class="summary-card">
            <strong>${value}</strong>
            <span>${label}</span>
          </article>
        `,
      )
      .join("");
  }

  if (elements.summerEntryTable) {
    elements.summerEntryTable.innerHTML = filteredRows.length
      ? filteredRows
          .map((row) => {
            const giveaway = row.giveaway;
            const giveawayUrl = String(giveaway.url || "").trim();
            const titleMarkup = giveawayUrl
              ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(giveaway.title || "Untitled giveaway")}</a>`
              : escapeHtml(giveaway.title || "Untitled giveaway");
            const entrantMarkup = row.entrantProfileUrl
              ? `<a class="linked-title" href="${escapeHtml(row.entrantProfileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.entrantLabel)}</a>`
              : escapeHtml(row.entrantLabel);
            const creatorMarkup = row.creatorProfileUrl
              ? `<a class="linked-title" href="${escapeHtml(row.creatorProfileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.creatorLabel)}</a>`
              : escapeHtml(row.creatorLabel);
            const winners = getSummerEventWinnerUsers(giveaway);
            const resultStatus = String(giveaway.resultStatus || "").toLowerCase();
            const resultBadge = resultStatus === "won"
              ? buildBadge("success", "Winner drawn")
              : resultStatus === "awaiting_feedback"
                ? buildBadge("info", "Awaiting feedback")
                : buildBadge("info", "Open");
            return `
              <tr>
                <td>
                  <strong>${titleMarkup}</strong>
                  <span class="meta-line">${formatDate(giveaway.endDate || state.settings.currentDate)}</span>
                </td>
                <td>
                  <strong>${entrantMarkup}</strong>
                  <span class="meta-line">${escapeHtml(row.reasonLabel)}</span>
                </td>
                <td>
                  <strong>${creatorMarkup}</strong>
                  <span class="meta-line">${getSummerEventSnapshotParticipantMeta(giveaway)}</span>
                </td>
                <td>
                  <strong>-${row.entryDelta.toLocaleString("en-US")} P</strong>
                  <span class="meta-line">Base value: ${row.basePoints.toLocaleString("en-US")} P</span>
                </td>
                <td>
                  <strong>${row.basePoints.toLocaleString("en-US")} P</strong>
                  <span class="meta-line">${getSummerEventValueMeta(giveaway)}</span>
                </td>
                <td>
                  ${resultBadge}
                  <span class="meta-line">${escapeHtml(winners.length ? getSummerEventWinnerLabel(giveaway, summerEventMemberIndex) : giveaway.resultLabel || "No winner yet")}</span>
                </td>
                <td>
                  ${buildSummerEventSnapshotBadge(giveaway)}
                  <span class="meta-line">${escapeHtml(giveaway.entriesSnapshotAt ? `Updated ${formatDateTime(giveaway.entriesSnapshotAt)}` : "No entries snapshot yet")}</span>
                </td>
              </tr>
            `;
          })
          .join("")
      : buildMessageRow(
          7,
          "No counted entry deductions match the current filters.",
          "Choose another entrant or creator filter to inspect a different slice of the summer-event ledger.",
        );
  }
}

function getSummerEventCreatorLabel(giveaway, memberIndex = getSummerEventMemberIndex()) {
  const creator = memberIndex.get(giveaway?.creatorUsername) || null;
  return String(creator?.displayName || giveaway?.creatorUsername || "Unknown member").trim();
}

function getSummerEventWinnerLabel(giveaway, memberIndex = getSummerEventMemberIndex()) {
  const winners = getSummerEventWinnerUsers(giveaway);
  if (!winners.length) {
    return "";
  }

  return winners
    .map((username) => {
      const winner = memberIndex.get(username) || null;
      return String(winner?.displayName || username || "").trim();
    })
    .filter(Boolean)
    .join(", ");
}

function buildSummerEventEntryLedger(giveaways, memberIndex = getSummerEventMemberIndex()) {
  const rows = [];

  for (const giveaway of giveaways) {
    if (!doesSummerEventGiveawayCountForStandings(giveaway)) {
      continue;
    }

    const creatorUsername = String(giveaway?.creatorUsername || "").trim();
    const creator = memberIndex.get(creatorUsername) || null;
    const creatorLabel = creator?.displayName || creatorUsername || "Unknown member";
    const creatorProfileUrl = creator?.profileUrl || (creatorUsername ? `https://www.steamgifts.com/user/${encodeURIComponent(creatorUsername)}` : "");
    const basePoints = getSummerEventBasePoints(giveaway);
    const entryDelta = getSummerEventEntryDelta(giveaway);
    const reasonLabel = `${basePoints}P giveaway • ${entryDelta}P swing`;

    for (const entrantUsername of getSummerEventEntryUsers(giveaway)) {
      if (!entrantUsername || entrantUsername === creatorUsername) {
        continue;
      }

      const entrant = memberIndex.get(entrantUsername) || null;
      const entrantLabel = entrant?.displayName || entrantUsername;
      const entrantProfileUrl = entrant?.profileUrl || `https://www.steamgifts.com/user/${encodeURIComponent(entrantUsername)}`;
      rows.push({
        giveaway,
        entrantUsername,
        entrantLabel,
        entrantProfileUrl,
        creatorUsername,
        creatorLabel,
        creatorProfileUrl,
        basePoints,
        entryDelta,
        reasonLabel,
      });
    }
  }

  return rows;
}

function getDistinctSummerEntryOptions(rows, valueKey, labelKey) {
  const options = new Map();
  for (const row of rows) {
    const value = String(row?.[valueKey] || "").trim();
    const label = String(row?.[labelKey] || value).trim();
    if (!value || options.has(value)) {
      continue;
    }
    options.set(value, label);
  }
  return Array.from(options.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "en-US", { sensitivity: "base" }));
}

function sortSummerEventEntryLedger(rows, sortValue) {
  const sorted = rows.slice();
  sorted.sort((left, right) => {
    switch (sortValue) {
      case "ended-asc":
        return String(left.giveaway.endDate || "").localeCompare(String(right.giveaway.endDate || ""));
      case "points-desc":
        return right.basePoints - left.basePoints || String(right.giveaway.endDate || "").localeCompare(String(left.giveaway.endDate || ""));
      case "points-asc":
        return left.basePoints - right.basePoints || String(left.giveaway.endDate || "").localeCompare(String(right.giveaway.endDate || ""));
      case "entrant-asc":
        return left.entrantLabel.localeCompare(right.entrantLabel, "en-US", { sensitivity: "base" }) || String(right.giveaway.endDate || "").localeCompare(String(left.giveaway.endDate || ""));
      case "creator-asc":
        return left.creatorLabel.localeCompare(right.creatorLabel, "en-US", { sensitivity: "base" }) || String(right.giveaway.endDate || "").localeCompare(String(left.giveaway.endDate || ""));
      case "title-asc":
        return String(left.giveaway.title || "").localeCompare(String(right.giveaway.title || ""), "en-US", { sensitivity: "base" }) || String(right.giveaway.endDate || "").localeCompare(String(left.giveaway.endDate || ""));
      case "ended-desc":
      default:
        return String(right.giveaway.endDate || "").localeCompare(String(left.giveaway.endDate || ""));
    }
  });
  return sorted;
}

function getSummerEventSnapshotParticipantMeta(giveaway) {
  const trackedEntries = getSummerEventEntryUsers(giveaway).length;
  return `${trackedEntries.toLocaleString("en-US")} tracked entr${trackedEntries === 1 ? "y" : "ies"}`;
}

function sortSummerEventGiveaways(giveaways, sortValue, memberIndex = getSummerEventMemberIndex()) {
  const sorted = giveaways.slice();
  sorted.sort((left, right) => {
    switch (sortValue) {
      case "ended-asc":
        return String(left.endDate || "").localeCompare(String(right.endDate || ""));
      case "title-asc":
        return String(left.title || "").localeCompare(String(right.title || ""), "en-US", { sensitivity: "base" });
      case "title-desc":
        return String(right.title || "").localeCompare(String(left.title || ""), "en-US", { sensitivity: "base" });
      case "creator-asc":
        return getSummerEventCreatorLabel(left, memberIndex).localeCompare(getSummerEventCreatorLabel(right, memberIndex), "en-US", { sensitivity: "base" });
      case "creator-desc":
        return getSummerEventCreatorLabel(right, memberIndex).localeCompare(getSummerEventCreatorLabel(left, memberIndex), "en-US", { sensitivity: "base" });
      case "winner-asc":
        return getSummerEventWinnerLabel(left, memberIndex).localeCompare(getSummerEventWinnerLabel(right, memberIndex), "en-US", { sensitivity: "base" }) || String(left.endDate || "").localeCompare(String(right.endDate || ""));
      case "winner-desc":
        return getSummerEventWinnerLabel(right, memberIndex).localeCompare(getSummerEventWinnerLabel(left, memberIndex), "en-US", { sensitivity: "base" }) || String(right.endDate || "").localeCompare(String(left.endDate || ""));
      case "points-desc":
        return getSummerEventBasePoints(right) - getSummerEventBasePoints(left) || String(right.endDate || "").localeCompare(String(left.endDate || ""));
      case "points-asc":
        return getSummerEventBasePoints(left) - getSummerEventBasePoints(right) || String(left.endDate || "").localeCompare(String(right.endDate || ""));
      case "entries-desc":
        return getSummerEventEntryUsers(right).length - getSummerEventEntryUsers(left).length || String(right.endDate || "").localeCompare(String(left.endDate || ""));
      case "entries-asc":
        return getSummerEventEntryUsers(left).length - getSummerEventEntryUsers(right).length || String(left.endDate || "").localeCompare(String(right.endDate || ""));
      case "ended-desc":
      default:
        return String(right.endDate || "").localeCompare(String(left.endDate || ""));
    }
  });
  return sorted;
}

function getTrackedSummerEventGiveaways() {
  // Honor the manual kind override: the raw sync giveaways don't carry the
  // override field (it's applied to state.giveaways), so look it up by code key.
  // This way re-typing a giveaway (summer_event -> extra) removes it here too,
  // and an override TO summer_event adds it.
  const overrides = getEffectiveOverrideState().giveaways;
  return (state.sync?.steamgifts?.giveaways || []).filter((giveaway) => {
    const key = getGiveawayCodeKey(giveaway);
    const overrideKind = key ? String(overrides[key]?.giveawayKindOverride || "").trim() : "";
    const kind = overrideKind
      ? normalizeGiveawayKindValue(overrideKind, giveaway)
      : normalizeGiveawayKindValue(giveaway?.giveawayKind, giveaway);
    return kind === "summer_event";
  });
}

function getSummerEventPeriods(giveaways) {
  const periods = new Map();
  for (const giveaway of giveaways) {
    const descriptor = getSummerEventPeriodDescriptor(giveaway);
    if (!periods.has(descriptor.key)) {
      periods.set(descriptor.key, descriptor);
    }
  }
  return Array.from(periods.values()).sort((left, right) => right.year - left.year || right.key.localeCompare(left.key));
}

function getSummerEventPeriodDescriptor(giveaway) {
  const referenceDate = giveaway?.endDate || giveaway?.createdAt || state.settings.currentDate;
  const parsed = parseDate(referenceDate);
  const year = Number.isFinite(parsed.getTime()) ? parsed.getFullYear() : new Date().getFullYear();
  const period = getPeriodInfo(referenceDate);
  const label = /^Summer event/i.test(String(period?.label || "")) ? period.label : `Summer event (${year})`;
  return {
    key: `summer-event-${year}`,
    label,
    year,
  };
}

function getSummerEventMemberIndex() {
  const members = new Map();

  for (const member of state.members) {
    const username = String(member?.steamgiftsUsername || member?.name || "").trim();
    if (!username || members.has(username)) {
      continue;
    }
    members.set(username, {
      username,
      displayName: member.name || username,
      profileUrl: `https://www.steamgifts.com/user/${encodeURIComponent(username)}`,
      isActiveMember: Boolean(member.isActiveMember),
    });
  }

  for (const member of state.sync?.steamgifts?.members || []) {
    const username = String(member?.username || "").trim();
    if (!username) {
      continue;
    }
    const existing = members.get(username) || {};
    members.set(username, {
      username,
      displayName: existing.displayName || username,
      profileUrl: member.profileUrl || existing.profileUrl || `https://www.steamgifts.com/user/${encodeURIComponent(username)}`,
      isActiveMember: typeof member.isActiveMember === "boolean" ? member.isActiveMember : Boolean(existing.isActiveMember),
    });
  }

  return members;
}

function computeSummerEventStandings(giveaways, memberIndex = getSummerEventMemberIndex()) {
  const standings = new Map();

  const ensureParticipant = (username) => {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername) {
      return null;
    }

    if (!standings.has(normalizedUsername)) {
      const member = memberIndex.get(normalizedUsername) || null;
      standings.set(normalizedUsername, {
        username: normalizedUsername,
        displayName: member?.displayName || normalizedUsername,
        profileUrl: member?.profileUrl || `https://www.steamgifts.com/user/${encodeURIComponent(normalizedUsername)}`,
        isActiveMember: Boolean(member?.isActiveMember),
        createdGiveaways: 0,
        createdPoints: 0,
        wonGiveaways: 0,
        wonPoints: 0,
        entryBonusPoints: 0,
        receivedEntries: 0,
        joinedGiveaways: 0,
        entryCostPoints: 0,
        balance: 0,
      });
    }

    return standings.get(normalizedUsername);
  };

  for (const giveaway of giveaways) {
    if (!doesSummerEventGiveawayCountForStandings(giveaway)) {
      continue;
    }
    const entryUsers = getSummerEventEntryUsers(giveaway);
    const winnerUsers = getSummerEventWinnerUsers(giveaway);
    const basePoints = getSummerEventBasePoints(giveaway);
    const entryDelta = getSummerEventEntryDelta(giveaway);
    const creator = ensureParticipant(giveaway.creatorUsername);

    if (creator) {
      creator.createdGiveaways += 1;
      creator.createdPoints += basePoints;
      creator.entryBonusPoints += entryUsers.length * entryDelta;
      creator.receivedEntries += entryUsers.length;
      creator.balance += basePoints + entryUsers.length * entryDelta;
    }

    for (const username of winnerUsers) {
      const winner = ensureParticipant(username);
      if (!winner) {
        continue;
      }
      winner.wonGiveaways += 1;
      winner.wonPoints += basePoints;
    }

    for (const username of entryUsers) {
      if (!username || username === giveaway.creatorUsername) {
        continue;
      }
      const participant = ensureParticipant(username);
      if (!participant) {
        continue;
      }
      participant.joinedGiveaways += 1;
      participant.entryCostPoints += entryDelta;
      participant.balance -= entryDelta;
    }
  }

  return Array.from(standings.values()).sort(
    (left, right) =>
      right.balance - left.balance ||
      right.createdPoints - left.createdPoints ||
      left.displayName.localeCompare(right.displayName, "en-US", { sensitivity: "base" }),
  );
}

function getSummerEventEntryUsers(giveaway) {
  return Array.from(
    new Set(
      (Array.isArray(giveaway?.entryUsers) ? giveaway.entryUsers : [])
        .map((username) => String(username || "").trim())
        .filter(Boolean),
    ),
  );
}

function getSummerEventWinnerUsers(giveaway) {
  const manualWinners = getGiveawayManualWinners(giveaway);
  if (manualWinners.length) {
    return Array.from(new Set(manualWinners.map((winner) => winner.username)));
  }
  return Array.from(
    new Set(
      (Array.isArray(giveaway?.winners) ? giveaway.winners : [])
        .map((winner) => String(winner?.username || "").trim())
        .filter(Boolean),
    ),
  );
}

function doesSummerEventGiveawayCountForStandings(giveaway) {
  return !isSummerEventNoWinners(giveaway);
}

function getSummerEventBasePointsOverride(giveaway) {
  const key = getGiveawayCodeKey(giveaway);
  if (!key) {
    return null;
  }
  const raw = getEffectiveOverrideState().giveaways[key]?.summerBasePointsOverride;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function getSummerEventBasePoints(giveaway) {
  // No winner => 0 overall, so a manual base does nothing here; it only matters
  // for giveaways that ended with a winner (and applies if one is set later).
  if (isSummerEventNoWinners(giveaway)) {
    return 0;
  }
  const override = getSummerEventBasePointsOverride(giveaway);
  if (override !== null) {
    return override;
  }
  if (hasSummerEventSteamPrice(giveaway)) {
    return Number(giveaway?.steamPricePoints || 0);
  }
  return Number(giveaway?.points || 0);
}

function getActiveSummerRuleset(giveaway) {
  const selected = String(state.settings.summerRuleset || "auto");
  if (selected === "legacy" || selected === "2026") {
    return selected;
  }
  // Auto: 2026 rules apply from the 2026 event onward, legacy before.
  return getSummerEventPeriodDescriptor(giveaway).year >= 2026 ? "2026" : "legacy";
}

function getSummerEventEntryDelta(giveaway) {
  if (isSummerEventNoWinners(giveaway)) {
    return 0;
  }
  const basePoints = getSummerEventBasePoints(giveaway);
  if (getActiveSummerRuleset(giveaway) === "2026") {
    // 2026: 15-29P -> 5, 30-59P -> 10, 60P+ -> 15.
    if (basePoints >= 60) {
      return 15;
    }
    if (basePoints >= 30) {
      return 10;
    }
    return basePoints >= 15 ? 5 : 0;
  }
  // Legacy: under 30P -> 5, 30P+ -> 10.
  return basePoints >= 30 ? 10 : 5;
}

function isSummerEventNoWinners(giveaway) {
  if (hasManualWinners(giveaway)) {
    return false;
  }
  return String(giveaway?.resultStatus || "").trim().toLowerCase() === "no_winners";
}

function hasSummerEventSteamPrice(giveaway) {
  return Boolean(giveaway?.steamPriceChecked)
    && giveaway?.steamPricePoints !== null
    && giveaway?.steamPricePoints !== undefined
    && giveaway?.steamPricePoints !== "";
}

function formatSummerEventUsd(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(cents || 0) / 100);
}

function getSummerEventValueMeta(giveaway) {
  const entryDelta = getSummerEventEntryDelta(giveaway);
  if (
    Boolean(giveaway?.steamPriceChecked)
    && giveaway?.steamListPriceCents !== null
    && giveaway?.steamListPriceCents !== undefined
    && giveaway?.steamListPriceCents !== ""
  ) {
    return `Steam list: ${formatSummerEventUsd(giveaway.steamListPriceCents)} • Swing: ${entryDelta} P`;
  }
  return `SteamGifts base • Swing: ${entryDelta} P`;
}

// A giveaway is waiting on a final post-close snapshot only if it has ended,
// is not yet finalized, and can still have a winner. Closed no-winner
// giveaways (and still-open ones) are not pending. Shared by the badge and the
// "Pending final snapshots" summary counter so they never disagree.
function isSummerEventSnapshotPending(giveaway) {
  if (giveaway?.entriesFinalized) {
    return false;
  }
  const ended = Boolean(giveaway?.endDate && new Date(giveaway.endDate).getTime() <= Date.now());
  return ended && !isSummerEventNoWinners(giveaway);
}

function buildSummerEventSnapshotBadge(giveaway) {
  if (giveaway?.entriesFinalized) {
    return buildBadge("success", "Final snapshot");
  }

  if (isSummerEventSnapshotPending(giveaway)) {
    return buildBadge("warning", "Final snapshot pending");
  }

  const ended = Boolean(giveaway?.endDate && new Date(giveaway.endDate).getTime() <= Date.now());
  // Ended with no possible winner -> settled, treat as final; otherwise still open.
  return ended ? buildBadge("success", "Final snapshot") : buildBadge("info", "Tracking open entries");
}

function formatPointBalance(value) {
  const amount = Number(value || 0);
  return `${amount > 0 ? "+" : ""}${amount.toLocaleString("en-US")} P`;
}

function formatSummerEventRatio(numerator, denominator) {
  const safeNumerator = Number(numerator || 0);
  const safeDenominator = Number(denominator || 0);
  if (safeDenominator <= 0) {
    return "n/a";
  }
  return `${((safeNumerator / safeDenominator) * 100).toFixed(1)}%`;
}

function getSummerEventRatioTone(numerator, denominator) {
  const safeNumerator = Number(numerator || 0);
  const safeDenominator = Number(denominator || 0);
  if (safeDenominator <= 0) {
    return "";
  }

  const ratioPercent = (safeNumerator / safeDenominator) * 100;
  if (ratioPercent <= 100) {
    return "ratio-success";
  }
  if (ratioPercent <= 150) {
    return "ratio-warning";
  }
  return "ratio-danger";
}

function buildSummerEventRatioMarkup(numerator, denominator) {
  const label = formatSummerEventRatio(numerator, denominator);
  const tone = getSummerEventRatioTone(numerator, denominator);
  return tone
    ? `<span class="ratio-value ${tone}">${escapeHtml(label)}</span>`
    : escapeHtml(label);
}

function renderMemberBuckets() {
  renderMemberBucketTable(elements.activeUsersTable, true);
  renderMemberBucketTable(elements.inactiveUsersTable, false);
}

function renderMemberBucketTable(target, isActiveMember) {
  if (!target) {
    return;
  }
  const rows = computeMemberBucketRows(isActiveMember);
  if (!rows.length) {
    target.innerHTML = buildEmptyRow(isActiveMember ? 5 : 6);
    return;
  }

  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${
            row.steamgiftsUrl
              ? `<a class="linked-title" href="${escapeHtml(row.steamgiftsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a>`
              : escapeHtml(row.name)
          }</td>
          <td>${row.totalWins}</td>
          <td>${formatHours(row.totalPlaytime)}</td>
          <td>${row.averageAchievements === null ? "-" : `${row.averageAchievements}%`}</td>
          <td>${row.thresholdMet}/${row.totalWins}</td>
          ${
            isActiveMember
              ? ""
              : `<td>${
                  row.overrideKey
                    ? `<button type="button" class="table-action-button" data-reactivate-member="${escapeHtml(row.overrideKey)}">Set active</button>`
                    : "-"
                }</td>`
          }
        </tr>
      `,
    )
    .join("");
}

function buildMemberCard(member) {
  const title = escapeHtml(member.username || "Unknown member");
  const usernameMarkup = member.steamProfile
    ? `<a class="linked-title" href="${escapeHtml(member.steamProfile)}" target="_blank" rel="noreferrer">${title}</a>`
    : title;

  // Tag + editor reflect the member's cycle obligation status for the current
  // month. Pause is an explicit choice only (never auto-set from giveaways).
  const stateMember = findMemberByUsername(member.username);
  const currentMonth = monthKey(state.settings.currentDate || "");
  const overrideKey = stateMember ? getCycleMemberOverrideKey(stateMember, currentMonth) : "";
  const paused = overrideKey ? getCycleMemberStatus(stateMember, currentMonth) === "paused" : false;
  const statusBadge = buildBadge(paused ? "warning" : "success", paused ? "Paused" : "Active");
  const statusEditor = overrideKey
    ? `
      <label class="inline-select-wrap member-status-edit">
        <span class="meta-line">Cycle status</span>
        <select class="inline-select" data-cycle-member-status-select="true" data-cycle-member-key="${escapeHtml(overrideKey)}">
          <option value="active" ${paused ? "" : "selected"}>Active</option>
          <option value="paused" ${paused ? "selected" : ""}>Paused</option>
        </select>
      </label>`
    : "";

  const memberKey = stateMember ? getMemberOverrideKey(stateMember) : "";
  const isInactive = stateMember ? getMemberMembershipStatus(stateMember) === "inactive" : false;
  const membershipEditor = memberKey
    ? `
      <label class="inline-select-wrap member-status-edit">
        <span class="meta-line">Membership</span>
        <select class="inline-select" data-member-status-select="true" data-member-key="${escapeHtml(memberKey)}">
          <option value="active" ${isInactive ? "" : "selected"}>Active member</option>
          <option value="inactive" ${isInactive ? "selected" : ""}>Left group (inactive)</option>
        </select>
      </label>`
    : "";

  return `
    <article class="member-card">
      ${statusBadge}
      <h3>${usernameMarkup}</h3>
      <span class="meta-line">${member.winsCount || 0} tracked win(s)</span>
      <strong>${member.lastWinDate ? formatDate(member.lastWinDate) : "No wins yet"}</strong>
      ${statusEditor}
      ${membershipEditor}
      <span class="meta-line">${member.profileUrl ? `<a class="linked-title" href="${escapeHtml(member.profileUrl)}" target="_blank" rel="noreferrer">Open SteamGifts profile</a>` : "SteamGifts profile unavailable"}</span>
    </article>
  `;
}

function buildCurrentCycleMissingGiveawaysCard() {
  const summary = getCurrentCycleMissingGiveawaySummary();
  if (!summary) {
    return "";
  }

  const missingNames = summary.members.map(({ member, missing }) => {
    const name = String(member?.name || member?.steamgiftsUsername || "Unknown member").trim() || "Unknown member";
    return missing > 1 ? `${name} (${missing})` : name;
  });

  return `
    <article class="member-card neutral">
      ${buildBadge("warning", "Cycle giveaway pending")}
      <h3>${escapeHtml(formatMonthKey(summary.monthKey))}</h3>
      <strong>${summary.members.length}</strong>
      <div class="member-card-meta">
        <span>Active members still missing at least one required cycle giveaway.</span>
        <span>${escapeHtml(missingNames.join(", "))}</span>
      </div>
    </article>
  `;
}

function getCurrentCycleMissingGiveawaySummary() {
  const currentMonth = monthKey(state.settings.currentDate || "");
  if (!currentMonth) {
    return null;
  }

  const cycle = getCyclePeriodInfo(currentMonth);
  if (!cycle) {
    return null;
  }

  const cycleMonths = getRenderableCycleMonths(cycle);
  const cycleWins = state.wins.filter((win) => cycleMonths.includes(getEffectiveWinMonth(win)));
  const cycleGiveaways = state.giveaways.filter(
    (giveaway) => getGiveawayKind(giveaway) !== "summer_event" && cycleMonths.includes(getGiveawayMonth(giveaway)),
  );
  const rule9Carryover = getRule9CarryoverForCycle(cycle);
  const members = getCycleHistoryVisibleMembers(cycle, cycleWins, cycleGiveaways)
    .filter((member) => Boolean(member?.isActiveMember))
    .map((member) => {
      if (getCycleMemberStatus(member.id, currentMonth) === "paused") {
        return null;
      }

      const requiredGiveaways = getRequiredCycleGiveawaysForMember(member.id, currentMonth, { rule9Carryover });
      const createdGiveaways = countMemberGiveawaysForMonth(member.id, currentMonth, "cycle");
      const missing = Math.max(requiredGiveaways - createdGiveaways, 0);

      if (!missing) {
        return null;
      }

      return {
        member,
        missing,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.missing - left.missing ||
        String(left.member?.name || "").localeCompare(String(right.member?.name || ""), "en-US", { sensitivity: "base" }),
    );

  return members.length
    ? {
        monthKey: currentMonth,
        members,
      }
    : null;
}

function buildGiveawayCard(giveaway) {
  const title = escapeHtml(giveaway.title || "Unknown giveaway");
  const image = buildImageMarkup({
    className: "giveaway-image",
    alt: title,
    appId: giveaway?.appId,
    sources: [giveaway.capsuleImageUrl, giveaway.headerImageUrl, giveaway.capsuleSmallUrl],
    placeholder: "No image",
  });

  return `
    <article class="giveaway-card">
      ${giveaway.steamAppUrl ? `<a href="${escapeHtml(giveaway.steamAppUrl)}" target="_blank" rel="noreferrer">${image}</a>` : image}
      <div class="giveaway-card-body">
        <h3 class="giveaway-title">
          ${giveaway.url ? `<a href="${escapeHtml(giveaway.url)}" target="_blank" rel="noreferrer">${title}</a>` : title}
        </h3>
        <span class="meta-line">Created by ${escapeHtml(giveaway.creatorUsername || "-")}</span>
        <div class="giveaway-meta-line">
          <span>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")} entries</span>
        </div>
      </div>
    </article>
  `;
}

function buildEmptyPanel(title, description) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
    </div>
  `;
}

function buildImageMarkup({ className, alt, sources, placeholder }) {
  const uniqueSources = Array.from(new Set((sources || []).filter(Boolean)));
  if (!uniqueSources.length) {
    return `<div class="${className} placeholder">${escapeHtml(placeholder)}</div>`;
  }

  const appId = arguments[0]?.appId ? ` data-app-id="${escapeHtml(String(arguments[0].appId))}"` : "";
  return `<img class="${className}" src="${escapeHtml(uniqueSources[0])}" alt="${escapeHtml(alt)}" loading="lazy"${appId} data-fallbacks="${escapeHtml(uniqueSources.slice(1).join("|"))}" data-placeholder="${escapeHtml(placeholder)}" onerror="handleImageFallback(event)" />`;
}

async function handleImageFallback(event) {
  const image = event.target;
  const remaining = (image.dataset.fallbacks || "").split("|").filter(Boolean);
  const nextSource = remaining.shift();
  if (nextSource) {
    image.dataset.fallbacks = remaining.join("|");
    image.src = nextSource;
    return;
  }

  const appId = Number(image.dataset.appId || 0);
  if (appId && image.dataset.storeMediaTried !== "1") {
    image.dataset.storeMediaTried = "1";
    const media = await fetchSteamMediaForApp(appId);
    const storeSources = [media?.capsuleSmallUrl, media?.headerImageUrl, media?.capsuleImageUrl]
      .filter(Boolean)
      .filter((source) => source !== image.currentSrc && source !== image.src);
    if (storeSources.length) {
      image.dataset.fallbacks = storeSources.slice(1).join("|");
      image.src = storeSources[0];
      return;
    }
  }

  const placeholder = document.createElement("div");
  placeholder.className = `${image.className} placeholder`;
  placeholder.textContent = image.dataset.placeholder || "No image";
  image.replaceWith(placeholder);
}

window.handleImageFallback = handleImageFallback;

function computeMemberBucketRows(isActiveMember) {
  const sortMode = isActiveMember ? elements.activeUsersSort?.value || "wins" : "wins";
  return state.members
    .filter((member) => Boolean(member.isActiveMember) === isActiveMember)
    .map((member) => {
      const memberWins = state.wins.filter((win) => win.memberId === member.id);
      const achievementPercents = memberWins
        .map((win) => getAchievementPercent(win, findById("games", win.gameId)))
        .filter((value) => value !== null);
      const sgUsername = String(member.steamgiftsUsername || member.name || "").trim();
      return {
        name: member.name,
        overrideKey: getMemberOverrideKey(member),
        steamgiftsUrl:
          member.profileUrl || (sgUsername ? `https://www.steamgifts.com/user/${encodeURIComponent(sgUsername)}` : ""),
        totalWins: memberWins.length,
        totalPlaytime: memberWins.reduce((sum, win) => sum + Number(win.currentHours || 0), 0),
        averageAchievements: achievementPercents.length
          ? Math.round(achievementPercents.reduce((sum, value) => sum + value, 0) / achievementPercents.length)
          : null,
        thresholdMet: memberWins.filter((win) => evaluateMonthlyProgress(win).badge !== "danger").length,
      };
    })
    .filter((row) => row.totalWins > 0 || isActiveMember)
    .sort((left, right) => compareMemberBucketRows(left, right, sortMode));
}

function renderMonthlyDetailsTable(target, winsSubset, sortMode = elements.monthlySort?.value || "hours-asc") {
  if (!winsSubset.length) {
    target.innerHTML = buildEmptyRow(9);
    return;
  }

  const sortedWins = [...winsSubset].sort((left, right) => compareMonthlyWins(left, right, sortMode));

  target.innerHTML = sortedWins
    .map((win) => {
      const member = findById("members", win.memberId);
      const game = findById("games", win.gameId);
      const progress = evaluateMonthlyProgress(win);
      const prereleaseNote = buildPrereleaseMonthNote(win, game);
      const hltbHours = getGameHltbHours(game);
      const totalAchievements = getGameAchievementsTotal(game);
      const effectiveMonth = getWinPlayMonth(win);

      return `
        <tr class="progress-row ${progress.badge}">
          <td>${buildWinnerMarkup(member)}</td>
          <td>${buildGameCell(game, win)}</td>
          <td>${buildGiveawayCreatorMarkup(win)}</td>
          <td>
            <div class="value-stack">
              <span>${hltbHours ? formatHours(hltbHours) : "-"}</span>
              ${game?.hltbHoursOverride !== undefined && game?.hltbHoursOverride !== null ? `<span class="meta-line override-note">Manual override</span>` : ""}
              ${game ? `<button class="inline-action" data-edit-action="hltb" data-game-id="${game.id}">Edit HLTB</button>` : ""}
            </div>
          </td>
          <td>${progress.requiredHours ? formatHours(progress.requiredHours) : "-"}</td>
          <td>${formatHours(win.currentHours || 0)}</td>
          <td>${buildAchievementCell(win, totalAchievements)}</td>
          <td>
            <div class="value-stack">
              <span>${progress.requiredAchievements || 0}</span>
              ${hasGameAchievementTargetOverride(game) || hasWinAchievementTargetOverride(win) ? `<span class="meta-line override-note">Manual override</span>` : ""}
              <button class="inline-action" data-edit-action="achievement-target" data-win-id="${win.id}">Edit 10%</button>
            </div>
          </td>
          <td class="status-notes-cell">
            <div class="status-notes-stack">
              ${buildBadge(progress.badge, progress.label)}
              <span class="meta-line">${escapeHtml(progress.note)}</span>
              ${effectiveMonth ? `<span class="meta-line">Counts in ${escapeHtml(formatMonthKey(effectiveMonth))}${win?.monthOverride ? " (manual override)" : ""}</span>` : ""}
              ${prereleaseNote ? `<span class="meta-line">${escapeHtml(prereleaseNote)}</span>` : ""}
            </div>
            ${buildEvidenceNoteMarkup(win.evidenceNotes)}
            <div class="row-actions">
              <button class="inline-action" data-edit-action="month" data-win-id="${win.id}">Edit month</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function compareMonthlyWins(left, right, sortMode) {
  const leftMember = findById("members", left.memberId);
  const rightMember = findById("members", right.memberId);
  const leftGame = findById("games", left.gameId);
  const rightGame = findById("games", right.gameId);
  const leftProgress = evaluateMonthlyProgress(left);
  const rightProgress = evaluateMonthlyProgress(right);

  if (sortMode === "creator") {
    const creatorCompare = String(left.creatorUsername || "").localeCompare(String(right.creatorUsername || ""), "en-US", {
      sensitivity: "base",
    });
    if (creatorCompare !== 0) {
      return creatorCompare;
    }
  }

  if (sortMode === "threshold") {
    const rank = { danger: 0, warning: 1, success: 2 };
    const thresholdCompare = (rank[leftProgress.badge] ?? 99) - (rank[rightProgress.badge] ?? 99);
    if (thresholdCompare !== 0) {
      return thresholdCompare;
    }
  }

  if (sortMode === "hours" || sortMode === "hours-desc") {
    const hoursCompare = Number(right.currentHours || 0) - Number(left.currentHours || 0);
    if (hoursCompare !== 0) {
      return hoursCompare;
    }
  }

  if (sortMode === "hours-asc") {
    const hoursCompare = Number(left.currentHours || 0) - Number(right.currentHours || 0);
    if (hoursCompare !== 0) {
      return hoursCompare;
    }
  }

  if (sortMode === "achievements-asc" || sortMode === "achievements-desc") {
    const leftPercent = getAchievementPercent(left, leftGame);
    const rightPercent = getAchievementPercent(right, rightGame);
    // Games without an achievement total sort to the bottom of "least first".
    const leftValue = leftPercent === null ? -1 : leftPercent;
    const rightValue = rightPercent === null ? -1 : rightPercent;
    const achievementCompare =
      sortMode === "achievements-asc" ? leftValue - rightValue : rightValue - leftValue;
    if (achievementCompare !== 0) {
      return achievementCompare;
    }
  }

  if (sortMode === "date-asc" || sortMode === "date-desc") {
    const leftTime = parseDate(left.winDate || "").getTime();
    const rightTime = parseDate(right.winDate || "").getTime();
    // Undated wins sort to the bottom in both directions.
    const leftValue = Number.isFinite(leftTime) ? leftTime : sortMode === "date-asc" ? Infinity : -Infinity;
    const rightValue = Number.isFinite(rightTime) ? rightTime : sortMode === "date-asc" ? Infinity : -Infinity;
    const dateCompare = sortMode === "date-asc" ? leftValue - rightValue : rightValue - leftValue;
    if (dateCompare !== 0) {
      return dateCompare;
    }
  }

  const memberCompare = String(leftMember?.name || "").localeCompare(String(rightMember?.name || ""), "en-US", {
    sensitivity: "base",
  });
  if (memberCompare !== 0) {
    return memberCompare;
  }

  const creatorCompare = String(left.creatorUsername || "").localeCompare(String(right.creatorUsername || ""), "en-US", {
    sensitivity: "base",
  });
  if (creatorCompare !== 0) {
    return creatorCompare;
  }

  return String(leftGame?.title || "").localeCompare(String(rightGame?.title || ""), "en-US", {
    sensitivity: "base",
  });
}

function buildGameCell(game, win) {
  const title = escapeHtml(game?.title || "Unknown game");
  const syncedGiveaway = findSyncedGiveawayForWin(win, game);
  const resolvedAppId = getResolvedGameAppId(game, syncedGiveaway);
  const fallback = getSteamMediaUrls(resolvedAppId);
  const image = buildImageMarkup({
    className: "game-thumb",
    alt: title,
    appId: resolvedAppId,
    sources: [
      game?.capsuleSmallUrl,
      syncedGiveaway?.capsuleSmallUrl,
      game?.headerImageUrl,
      syncedGiveaway?.headerImageUrl,
      game?.capsuleImageUrl,
      syncedGiveaway?.capsuleImageUrl,
      fallback.capsuleSmallUrl,
      fallback.headerImageUrl,
      fallback.capsuleImageUrl,
    ],
    placeholder: "No art",
  });
  const steamAppUrl = game?.steamAppUrl || syncedGiveaway?.steamAppUrl || "";
  const titleMarkup = steamAppUrl
    ? `<a class="linked-title" href="${escapeHtml(steamAppUrl)}" target="_blank" rel="noreferrer">${title}</a>`
    : title;

  return `
    <div class="game-cell">
      ${image}
      <div>
        <strong>${titleMarkup}</strong>
        ${game?.appId ? `<span class="meta-line">App ${game.appId}</span>` : ""}
      </div>
    </div>
  `;
}

function findSyncedGiveawayForWin(win, game) {
  const syncGiveaways = state.sync?.steamgifts?.giveaways || [];
  const giveawayUrl = getGiveawayUrl(win);
  if (giveawayUrl) {
    const byUrl = syncGiveaways.find((giveaway) => giveaway?.url === giveawayUrl);
    if (byUrl) {
      return normalizeGiveawayMedia(byUrl);
    }
  }
  const appId = Number(game?.appId || 0);
  const byAppId = appId ? syncGiveaways.find((giveaway) => Number(giveaway?.appId || 0) === appId) : null;
  if (byAppId) {
    return normalizeGiveawayMedia(byAppId);
  }
  const normalizedTitle = normalizeGameTitle(game?.title || "");
  const byTitle = syncGiveaways.find((giveaway) => normalizeGameTitle(giveaway?.title || "") === normalizedTitle);
  if (byTitle) {
    return normalizeGiveawayMedia(byTitle);
  }
  const byLooseTitle = syncGiveaways.find((giveaway) => {
    const giveawayTitle = normalizeGameTitle(giveaway?.title || "");
    return normalizedTitle && giveawayTitle && (giveawayTitle.includes(normalizedTitle) || normalizedTitle.includes(giveawayTitle));
  });
  if (byLooseTitle) {
    return normalizeGiveawayMedia(byLooseTitle);
  }
  const steamAppUrl = String(game?.steamAppUrl || "");
  const steamUrlAppId = parseSteamAppId(steamAppUrl);
  const bySteamUrl = steamUrlAppId
    ? syncGiveaways.find((giveaway) => Number(giveaway?.appId || 0) === steamUrlAppId)
    : null;
  if (bySteamUrl) {
    return normalizeGiveawayMedia(bySteamUrl);
  }
  return null;
}

function getResolvedGameAppId(game, syncedGiveaway) {
  return (
    Number(game?.appId || 0) ||
    parseSteamAppId(game?.steamAppUrl || "") ||
    Number(syncedGiveaway?.appId || 0) ||
    parseSteamAppId(syncedGiveaway?.steamAppUrl || "") ||
    0
  );
}

function buildGiveawayCreatorMarkup(win) {
  const creatorName = escapeHtml(win?.creatorUsername || "-");
  const giveawayUrl = getGiveawayUrl(win);
  if (!giveawayUrl) {
    return creatorName;
  }
  return `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${creatorName}</a>`;
}

function buildWinnerMarkup(member) {
  const winnerName = escapeHtml(member?.name || "Unknown member");
  if (!member?.steamProfile) {
    return winnerName;
  }
  return `<a class="linked-title" href="${escapeHtml(member.steamProfile)}" target="_blank" rel="noreferrer">${winnerName}</a>`;
}

function buildAchievementCell(win, totalAchievements) {
  const earned = Number(win?.earnedAchievements || 0);
  if (!totalAchievements) {
    return earned ? `${earned}/?` : "-";
  }
  return `${earned}/${totalAchievements}`;
}

function getGiveawayUrl(win) {
  const directUrl = String(win?.giveawayUrl || "").trim();
  if (directUrl) {
    return directUrl;
  }
  const note = String(win?.evidenceNotes || "").trim();
  const steamGiftsMatch = note.match(/^SteamGifts sync:\s*(https?:\/\/\S+)$/i);
  return steamGiftsMatch ? steamGiftsMatch[1] : "";
}

function evaluateMonthlyProgress(win) {
  const base = evaluateBaseMonthlyProgress(win);
  // PoP Free: always counts as complete and never red. If the winner didn't
  // actually reach the threshold, show it blue instead.
  if (getWinTrackKind(win) === "pop_free" && base.badge === "danger") {
    return {
      ...base,
      badge: "info",
      label: "PoP free",
      note: "PoP Free — counts as complete; no minimum play required.",
    };
  }
  return base;
}

// Penalty system: a winner who doesn't finish a won game (stays below the PoP
// threshold) must create a "Penalty GA - <link>" giveaway for it. The deadline is
// 4 months after the month the win appears in PoP (getWinPlayMonth, which is
// release-aware), landing on the 1st of the following month: a January PoP win is
// due June 1, February due July 1, and Gothic (shown in June) due November 1.
// PoP months before Jan 2026 are grandfathered as paid.
const PENALTY_GRACE_MONTHS = 4;
const PENALTY_TRACKING_START_MONTH = "2026-01";

// Deadline date for a "YYYY-MM" PoP month: first day of (month + 4 + 1).
function getPenaltyDeadlineForMonth(popMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(popMonth || ""));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-12
  // Date.UTC handles the year roll-over (e.g. Oct + 5 -> next March).
  return new Date(Date.UTC(year, month + PENALTY_GRACE_MONTHS, 1));
}

// The deadline is a UTC calendar date (1st of the month); format it in UTC so it
// reads "Jun 1" everywhere instead of slipping a day in negative timezones.
function formatPenaltyDeadline(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

function getWinGiveawayCodeKey(win) {
  const giveaway = findGiveawayForWin(win);
  return giveaway ? getGiveawayCodeKey(giveaway) : "";
}

function getPenaltyForCodeKey(giveaway) {
  const raw = String(giveaway?.penaltyForCode || "").trim();
  if (!raw) {
    return "";
  }
  return raw.startsWith("sg-") ? raw : `sg-${raw}`;
}

function isWinPenaltyPaid(win) {
  const codeKey = getWinGiveawayCodeKey(win);
  if (!codeKey) {
    return false;
  }
  return state.giveaways.some(
    (giveaway) => getGiveawayKind(giveaway) === "penalty" && getPenaltyForCodeKey(giveaway) === codeKey,
  );
}

// Classifies a win against the penalty rules. Returns null when the win is not
// subject to penalties at all; otherwise a status:
//   grandfathered  - PoP month before Jan 2026 (always paid)
//   complete       - met the PoP threshold (no debt; finishing late clears it)
//   paid           - incomplete but a penalty giveaway is attached
//   overdue        - incomplete, past the deadline, unpaid -> owes now
//   coming-due     - incomplete, before the deadline, unpaid
function getWinPenaltyInfo(win) {
  // Wait until Steam progress AND overrides are applied. Before progress every
  // win has 0 playtime/achievements (looks incomplete), and before overrides the
  // pop_free/penalty/month/manual-winner edits haven't resolved -> the list would
  // flash full of false penalties during page load.
  if (!isPenaltyDataReady()) {
    return null;
  }
  const trackKind = getWinTrackKind(win);
  if (trackKind === "pop_free" || trackKind === "penalty") {
    return null; // exempt kinds are never subject to penalties
  }
  const popMonth = getWinPlayMonth(win); // release-aware PoP month, "YYYY-MM"
  if (!popMonth) {
    return null;
  }
  if (popMonth < PENALTY_TRACKING_START_MONTH) {
    return { status: "grandfathered", popMonth, deadline: null };
  }
  if (evaluateMonthlyProgress(win).badge !== "danger") {
    return { status: "complete", popMonth, deadline: null };
  }
  const deadline = getPenaltyDeadlineForMonth(popMonth);
  if (!deadline) {
    return null;
  }
  if (isWinPenaltyPaid(win)) {
    return { status: "paid", popMonth, deadline };
  }
  const now = parseDate(state.settings.currentDate || "");
  const reference = Number.isFinite(now.getTime()) ? now : new Date();
  const days = Math.round((deadline.getTime() - reference.getTime()) / 86400000);
  if (reference.getTime() >= deadline.getTime()) {
    return { status: "overdue", popMonth, deadline, daysOverdue: Math.abs(days) };
  }
  return { status: "coming-due", popMonth, deadline, daysLeft: days };
}

function getWinPenaltyDebt(win) {
  const info = getWinPenaltyInfo(win);
  return info && info.status === "overdue" ? { win, deadline: info.deadline } : null;
}

function getOutstandingPenalties() {
  return state.wins
    .map((win) => getWinPenaltyDebt(win))
    .filter(Boolean)
    .map((debt) => ({
      ...debt,
      member: findById("members", debt.win.memberId),
      game: findById("games", debt.win.gameId),
    }))
    .sort((left, right) => left.deadline.getTime() - right.deadline.getTime());
}

// Penalty giveaways that have been created, resolved to the won giveaway they
// pay off (the audit/settled list).
function getPenaltyGiveawayRecords() {
  return state.giveaways
    .filter((giveaway) => getGiveawayKind(giveaway) === "penalty")
    .map((giveaway) => {
      const targetKey = getPenaltyForCodeKey(giveaway);
      const target = targetKey
        ? state.giveaways.find((item) => getGiveawayCodeKey(item) === targetKey) || null
        : null;
      const targetWin = target
        ? state.wins.find((win) => getWinGiveawayCodeKey(win) === targetKey) || null
        : null;
      return {
        giveaway,
        target,
        targetWin,
        creator: findById("members", giveaway.creatorId),
        targetGame: targetWin ? findById("games", targetWin.gameId) : null,
      };
    })
    .sort((left, right) => String(right.giveaway.createdAt || "").localeCompare(String(left.giveaway.createdAt || "")));
}

function getGiveawayPageUrl(giveaway) {
  if (!giveaway) {
    return "";
  }
  const note = String(giveaway.notes || giveaway.url || "").trim();
  if (/^https?:\/\//.test(note)) {
    return note;
  }
  const code = String(giveaway.code || "").trim() || String(giveaway.sourceId || "").replace(/^sg-/, "");
  return code ? `https://www.steamgifts.com/giveaway/${code}/` : "";
}

// "have / need" cells for a win: current playtime vs required 25%, and earned
// achievements vs the required 10%.
function buildPenaltyProgressCells(win) {
  if (!win) {
    return ["-", "-"];
  }
  const progress = evaluateMonthlyProgress(win);
  const hours = `${formatHours(Number(win.currentHours || 0))} / ${formatHours(progress.requiredHours || 0)}`;
  const achievements = `${Number(win.earnedAchievements || 0)} / ${progress.requiredAchievements || 0}`;
  return [hours, achievements];
}

function isPenaltyDataReady() {
  return Boolean(state.sync?.steamProgressUpdatedAt) && runtime.sharedOverridesLoaded;
}

function renderPenaltiesPage() {
  if (!elements.penaltiesTable) {
    return;
  }
  if (!isPenaltyDataReady()) {
    elements.penaltiesTable.innerHTML = `<tr><td colspan="6" class="meta-line">Loading penalty data — waiting for Steam playtime/achievements and overrides…</td></tr>`;
    if (elements.penaltiesSummary) {
      elements.penaltiesSummary.textContent = "Loading…";
    }
    return;
  }
  const filter = elements.penaltiesFilter?.value || "all";

  const winRows = [];
  for (const win of state.wins) {
    const info = getWinPenaltyInfo(win);
    if (!info || (info.status !== "overdue" && info.status !== "coming-due")) {
      continue;
    }
    winRows.push({ win, info });
  }
  const settled = getPenaltyGiveawayRecords();
  const overdueCount = winRows.filter((row) => row.info.status === "overdue").length;
  const comingCount = winRows.filter((row) => row.info.status === "coming-due").length;

  if (elements.penaltiesSummary) {
    elements.penaltiesSummary.textContent = `${overdueCount} owed now • ${comingCount} coming due • ${settled.length} settled`;
  }

  const linkedGame = (title, url) =>
    url
      ? `<a class="linked-title" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`
      : escapeHtml(title);

  const rows = [];

  if (filter === "all" || filter === "overdue" || filter === "coming-due") {
    winRows
      .filter((row) => filter === "all" || row.info.status === filter)
      .sort((left, right) => left.info.deadline.getTime() - right.info.deadline.getTime())
      .forEach(({ win, info }) => {
        const member = findById("members", win.memberId);
        const game = findById("games", win.gameId);
        const overdue = info.status === "overdue";
        const statusBadge = buildBadge(
          overdue ? "danger" : "warning",
          overdue ? `Overdue ${info.daysOverdue}d` : `Due in ${info.daysLeft}d`,
        );
        const [hoursCell, achievementsCell] = buildPenaltyProgressCells(win);
        // Not yet paid -> the game links to the won giveaway (the one to play).
        rows.push(`
          <tr>
            <td>${escapeHtml(member?.name || win.winnerUsername || "Unknown member")}</td>
            <td>${linkedGame(game?.title || win.title || "", getGiveawayUrl(win))}</td>
            <td>${escapeHtml(hoursCell)}</td>
            <td>${escapeHtml(achievementsCell)}</td>
            <td>${statusBadge}</td>
            <td>${escapeHtml(formatPenaltyDeadline(info.deadline))}</td>
          </tr>
        `);
      });
  }

  if (filter === "all" || filter === "settled") {
    for (const record of settled) {
      const payer = record.creator?.name || record.giveaway.creatorUsername || "Unknown member";
      const gameTitle = record.targetGame?.title || record.target?.title || record.giveaway.title || "";
      const [hoursCell, achievementsCell] = buildPenaltyProgressCells(record.targetWin);
      // Paid -> the game links to the penalty giveaway that settled the debt.
      rows.push(`
        <tr>
          <td>${escapeHtml(payer)}</td>
          <td>${linkedGame(gameTitle, getGiveawayPageUrl(record.giveaway))}</td>
          <td>${escapeHtml(hoursCell)}</td>
          <td>${escapeHtml(achievementsCell)}</td>
          <td>${buildBadge("success", "Settled")}</td>
          <td>${escapeHtml(record.giveaway.createdAt ? formatDate(record.giveaway.createdAt) : "-")}</td>
        </tr>
      `);
    }
  }

  elements.penaltiesTable.innerHTML = rows.length ? rows.join("") : buildEmptyRow(6);
}

function evaluateBaseMonthlyProgress(win) {
  const game =
    findById("games", win.gameId) || {
      id: "",
      title: "Unknown game",
      hltbHours: 0,
      achievementsTotal: 0,
    };
  const hltbHours = getGameHltbHours(game);
  const totalAchievements = getGameAchievementsTotal(game);
  const currentHours = Number(win.currentHours || 0);
  const currentAchievements = Number(win.earnedAchievements || 0);
  const requiredHours = hltbHours > 0 ? getRequiredHours(hltbHours, "standard-25") : 0;
  const requiredAchievements = getRequiredAchievementsTarget(win, game);
  const hasThresholdData = hltbHours > 0 || totalAchievements > 0;
  const meetsHours = requiredHours === 0 || currentHours >= requiredHours;
  const meetsAchievements = requiredAchievements === 0 || currentAchievements >= requiredAchievements;
  const allAchievementsDone = totalAchievements > 0 && currentAchievements >= totalAchievements;

  if (!hasThresholdData) {
    return {
      badge: "danger",
      label: "Missing data",
      note: "No HLTB or achievement totals were found yet.",
      requiredHours,
      requiredAchievements,
    };
  }

  if (allAchievementsDone) {
    return {
      badge: "warning",
      label: "All achievements",
      note: "Completed every achievement for this game.",
      requiredHours,
      requiredAchievements,
    };
  }

  if (meetsHours && meetsAchievements) {
    return {
      badge: "success",
      label: "Threshold met",
      note: "Reached 25% of HLTB time and 10% of achievements.",
      requiredHours,
      requiredAchievements,
    };
  }

  const missingBits = [];
  if (requiredHours > currentHours) {
    missingBits.push(`${formatHours(requiredHours - currentHours)} more playtime`);
  }
  if (requiredAchievements > currentAchievements) {
    missingBits.push(`${requiredAchievements - currentAchievements} more achievement(s)`);
  }

  return {
    badge: "danger",
    label: "Below threshold",
    note: missingBits.length ? `Needs ${missingBits.join(" + ")}.` : "Threshold not met yet.",
    requiredHours,
    requiredAchievements,
  };
}

function renderProgressTable(target, winsSubset, monthlyView) {
  const rows = computeMemberProgressRows(winsSubset);
  if (!rows.length) {
    target.innerHTML = buildEmptyRow(6);
    return;
  }

  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${row.winCount}</td>
          <td>${formatHours(row.totalHours)}</td>
          <td>${row.averageAchievementPercent === null ? "-" : `${row.averageAchievementPercent}%`}</td>
          <td>${row.compliantWins}/${row.trackedWins}${monthlyView ? "" : `<span class="meta-line">${row.unknownWins} missing data</span>`}</td>
          <td>${row.overdueWins}</td>
        </tr>
      `,
    )
    .join("");
}

function computeMemberProgressRows(winsSubset) {
  const map = new Map();

  for (const member of state.members) {
    map.set(member.id, {
      name: member.name,
      winCount: 0,
      totalHours: 0,
      compliantWins: 0,
      overdueWins: 0,
      trackedWins: 0,
      unknownWins: 0,
      achievementPercents: [],
    });
  }

  for (const win of winsSubset) {
    const member = findById("members", win.memberId);
    if (!member) {
      continue;
    }

    const game = findById("games", win.gameId);
    const evaluation = evaluateWin(win);
    const row = map.get(member.id);
    row.winCount += 1;
    row.totalHours += Number(win.currentHours || 0);
    if (evaluation.state === "compliant") {
      row.compliantWins += 1;
    }
    if (evaluation.state === "overdue") {
      row.overdueWins += 1;
    }
    if (evaluation.state === "unknown") {
      row.unknownWins += 1;
    } else {
      row.trackedWins += 1;
    }

    const percent = getAchievementPercent(win, game);
    if (percent !== null) {
      row.achievementPercents.push(percent);
    }
  }

  return Array.from(map.values())
    .filter((row) => row.winCount > 0)
    .map((row) => ({
      ...row,
      averageAchievementPercent: row.achievementPercents.length
        ? Math.round(
            row.achievementPercents.reduce((sum, value) => sum + value, 0) /
              row.achievementPercents.length,
          )
        : null,
    }))
    .sort((left, right) => right.winCount - left.winCount || right.totalHours - left.totalHours);
}

function renderAlerts() {
  const alerts = buildAlerts();
  if (!alerts.length) {
    elements.alertsPanel.innerHTML = `
      <article class="alert-card success">
        <h3>No critical alerts</h3>
        <p>Add wins and giveaways so the monitor can start flagging risks.</p>
      </article>
    `;
    return;
  }

  elements.alertsPanel.innerHTML = alerts
    .map(
      (alert) => `
        <article class="alert-card ${alert.level}">
          <h3>${alert.title}</h3>
          ${alert.html}
        </article>
      `,
    )
    .join("");
}

function renderMembers() {
  if (!state.members.length) {
    elements.membersTable.innerHTML = buildEmptyRow(5);
    return;
  }

  const rows = state.members
    .map((member) => {
      const memberMetrics = computeMemberMetrics(member.id);
      const action = memberMetrics.nextAction;

      return `
        <tr>
          <td>
            <strong>${escapeHtml(member.name)}</strong>
            ${member.steamgiftsUsername ? `<span class="meta-line">SteamGifts: ${escapeHtml(member.steamgiftsUsername)}</span>` : ""}
            ${member.steamProfile ? `<a class="meta-line" href="${escapeHtml(member.steamProfile)}" target="_blank" rel="noreferrer">Steam profile</a>` : `<span class="meta-line">No Steam link</span>`}
          </td>
          <td>${memberMetrics.cycleWins}</td>
          <td>${memberMetrics.penalties}</td>
          <td>${action}</td>
          <td><button class="table-action" data-delete-type="members" data-delete-id="${member.id}">Delete</button></td>
        </tr>
      `;
    })
    .join("");

  elements.membersTable.innerHTML = rows;
}

function renderGames() {
  if (!state.games.length) {
    elements.gamesTable.innerHTML = buildEmptyRow(5);
    return;
  }

  elements.gamesTable.innerHTML = state.games
    .map(
      (game) => `
        <tr>
          <td><strong>${escapeHtml(game.title)}</strong></td>
          <td>${game.appId}</td>
          <td>${formatHours(game.hltbHours)}</td>
          <td>${game.achievementsTotal}</td>
          <td><button class="table-action" data-delete-type="games" data-delete-id="${game.id}">Delete</button></td>
        </tr>
      `,
    )
    .join("");
}

function renderWins() {
  if (!state.wins.length) {
    elements.winsTable.innerHTML = buildEmptyRow(8);
    return;
  }

  const rows = state.wins
    .map((win) => {
      const evaluation = evaluateWin(win);
      const member = findById("members", win.memberId);
      const game = findById("games", win.gameId);

      return `
        <tr>
          <td>${escapeHtml(member?.name || "Membro removido")}</td>
          <td>${escapeHtml(game?.title || "Jogo removido")}</td>
          <td>
            ${formatDate(evaluation.deadline)}
            <span class="meta-line">Won on ${formatDate(win.winDate)}</span>
          </td>
          <td>${evaluation.targetLabel}</td>
          <td>${evaluation.progressLabel}</td>
          <td>${buildBadge(evaluation.statusBadge, evaluation.statusLabel)}</td>
          <td>${evaluation.penaltyText}</td>
          <td><button class="table-action" data-delete-type="wins" data-delete-id="${win.id}">Delete</button></td>
        </tr>
      `;
    })
    .join("");

  elements.winsTable.innerHTML = rows;
}

function renderGiveaways() {
  if (!state.giveaways.length) {
    elements.giveawaysTable.innerHTML = buildEmptyRow(6);
    return;
  }

  const threshold = computeMinimumEntriesRequired();
  elements.giveawaysTable.innerHTML = state.giveaways
    .map((giveaway) => {
      const creator = findById("members", giveaway.creatorId);
      const validation = evaluateGiveaway(giveaway);

      return `
        <tr>
          <td>${escapeHtml(creator?.name || "Membro removido")}</td>
          <td>
            <strong>${escapeHtml(giveaway.title)}</strong>
            <span class="meta-line">${formatDate(giveaway.createdAt)} • ${giveaway.entriesCount} entries</span>
          </td>
          <td>${escapeHtml(giveaway.type)}</td>
          <td>Minimum ${threshold}</td>
          <td>
            ${buildBadge(validation.level, validation.label)}
            ${validation.issues.length ? `<span class="meta-line">${escapeHtml(validation.issues.join(" | "))}</span>` : `<span class="meta-line">No issues detected</span>`}
          </td>
          <td><button class="table-action" data-delete-type="giveaways" data-delete-id="${giveaway.id}">Delete</button></td>
        </tr>
      `;
    })
    .join("");
}

function getApiCandidates(path, method = "GET") {
  if (String(method).toUpperCase() !== "GET") {
    return [path];
  }
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  const jsonPath = `./${normalized}.json`;
  // On the static API (Pages) the extensionless path always 404s, so once we
  // know we're static, request the .json directly instead of probing both.
  if (runtime.staticApi) {
    return [jsonPath];
  }
  return [path, jsonPath];
}

function buildFreshApiRequestUrl(path) {
  try {
    const url = new URL(path, window.location.href);
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  } catch {
    const separator = String(path).includes("?") ? "&" : "?";
    return `${path}${separator}_=${Date.now()}`;
  }
}

async function fetchApiJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = method === "GET"
    ? { ...options, cache: "no-store" }
    : options;
  let lastError = null;

  for (const candidate of getApiCandidates(path, method)) {
    try {
      const response = await fetch(
        method === "GET" ? buildFreshApiRequestUrl(candidate) : candidate,
        requestOptions,
      );
      if (!response.ok) {
        lastError = new Error(`Request failed for ${candidate}`);
        continue;
      }
      const payload = await response.json().catch(() => null);
      if (candidate.endsWith(".json")) {
        runtime.staticApi = true;
      }
      return { response, payload, staticApi: runtime.staticApi };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Could not load ${path}`);
}

async function refreshRemoteSync(options = {}) {
  try {
    const result =
      options.prefetched?.payload != null ? options.prefetched : await fetchApiJson("./api/steamgifts-sync");
    const payload = result.payload;
    if (payload?.source === "akatsuki-steamgifts-sync") {
      importSteamGiftsSync(payload, { persist: true });
    } else if (isEmptySyncPayload(payload)) {
      clearStoredSyncState({ persist: true });
    } else if (!options.silent) {
      window.alert("The server responded, but there is no SteamGifts sync stored yet.");
    }
    // During the initial parallel load the dashboard is fetched/applied
    // separately, so skip the nested fetch here.
    if (!options.skipDashboard) {
      await loadDashboardData({ silent: true });
    }
  } catch (error) {
    if (!options.silent) {
      window.alert("Could not load automatic sync. Start the local server with python server.py.");
    }
  }
}

async function loadDashboardData(options = {}) {
  try {
    const result =
      options.prefetched?.payload != null ? options.prefetched : await fetchApiJson("./api/dashboard");
    state.sync = {
      ...state.sync,
      dashboard: result.payload,
    };
    render();
    void loadVisibleGameMedia({ silent: true });
  } catch (error) {
    if (!options.silent && elements.recentGiveaways) {
      elements.recentGiveaways.innerHTML = buildEmptyPanel(
        "Server dashboard unavailable.",
        "Start the local server to load the richer giveaway and member views.",
      );
    }
  }
}

async function loadSharedOverrides(options = {}) {
  try {
    const result =
      options.prefetched?.payload != null ? options.prefetched : await fetchApiJson("./api/overrides");
    runtime.sharedOverrides = normalizeSharedOverridePayload(result.payload);
    applyManualOverrides();
  } catch (error) {
    runtime.sharedOverrides = normalizeOverrideState();
    if (!options.silent) {
      window.alert("Could not load published overrides.");
    }
  } finally {
    // Penalties can only be judged once overrides (kind/manual-winner/month) are
    // applied, so flag completion and re-render either way.
    runtime.sharedOverridesLoaded = true;
    render();
  }
}

function getStoredGithubToken() {
  try {
    return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function setStoredGithubToken(token) {
  try {
    if (token) {
      localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore storage failures */
  }
}

function promptForGithubToken(options = {}) {
  const existing = getStoredGithubToken();
  const message =
    "Paste a GitHub token with 'Contents: Read and write' on jpdefo/akatsuki-group.\n" +
    "It is stored only in this browser. Leave empty to keep the current token; type CLEAR to remove it.";
  const entered = window.prompt(message, "");
  if (entered === null) {
    return existing;
  }
  const trimmed = entered.trim();
  if (!trimmed) {
    if (options.announce) {
      window.alert(existing ? "Kept the existing GitHub token." : "No GitHub token is set.");
    }
    return existing;
  }
  if (trimmed.toUpperCase() === "CLEAR") {
    setStoredGithubToken("");
    if (options.announce) {
      window.alert("GitHub token removed from this browser.");
    }
    return "";
  }
  setStoredGithubToken(trimmed);
  if (options.announce) {
    window.alert("GitHub token saved in this browser.");
  }
  return trimmed;
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function updateQuickPublishVisibility() {
  if (!elements.quickPublishButton) {
    return;
  }
  // Only surface the quick publish button to an admin who already saved a token.
  elements.quickPublishButton.hidden = !getStoredGithubToken();
}

async function publishOverridesToGitHub() {
  const button = elements.publishToPagesButton || elements.quickPublishButton;
  const originalLabel = button?.textContent;

  let token = getStoredGithubToken();
  if (!token) {
    token = promptForGithubToken();
    if (!token) {
      window.alert("Publishing cancelled: no GitHub token provided.");
      return;
    }
  }

  try {
    if (button) {
      button.disabled = true;
      button.textContent = "Publishing to GitHub...";
    }

    const apiBase = `https://api.github.com/repos/${GITHUB_PUBLISH_REPO.owner}/${GITHUB_PUBLISH_REPO.name}/contents/${GITHUB_OVERRIDES_PATH}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    // Look up the current file SHA (required to update; 404 means create new).
    let sha = null;
    const getResponse = await fetch(`${apiBase}?ref=${GITHUB_PUBLISH_REPO.branch}&_=${Date.now()}`, {
      headers,
      cache: "no-store",
    });
    if (getResponse.status === 401) {
      throw new Error("GitHub rejected the token (401). Use 'Set / change GitHub token' to paste a valid token.");
    }
    if (getResponse.ok) {
      const current = await getResponse.json();
      sha = current?.sha || null;
    } else if (getResponse.status !== 404) {
      throw new Error(`Could not read data/overrides.json from GitHub (${getResponse.status}).`);
    }

    const fileBody = `${JSON.stringify({ savedAt: new Date().toISOString(), overrides: getPublishableOverrideState() }, null, 2)}\n`;
    const putResponse = await fetch(apiBase, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Publish overrides from live dashboard",
        content: encodeBase64Utf8(fileBody),
        branch: GITHUB_PUBLISH_REPO.branch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putResponse.status === 401) {
      throw new Error("GitHub rejected the token (401). Set a valid token and try again.");
    }
    if (putResponse.status === 403) {
      throw new Error("GitHub denied the write (403). The token needs 'Contents: Read and write' on jpdefo/akatsuki-group.");
    }
    if (putResponse.status === 409) {
      throw new Error("Conflict (409): data/overrides.json changed on GitHub since this page loaded. Reload and publish again.");
    }
    if (!putResponse.ok) {
      const errorPayload = await putResponse.json().catch(() => null);
      throw new Error(errorPayload?.message || `GitHub write failed (${putResponse.status}).`);
    }

    window.alert("Overrides published to GitHub. The public site rebuilds in ~1–2 minutes, then every visitor sees the changes.");
  } catch (error) {
    window.alert(error?.message || "Could not publish to GitHub.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || "Publish to GitHub Pages";
    }
  }
}

async function publishSharedOverrides() {
  const button = elements.publishOverridesButton;
  const originalLabel = button?.textContent;

  try {
    if (runtime.staticApi) {
      throw new Error("GitHub Pages is read-only. Use \"Publish to GitHub Pages\" to save overrides directly to the repo.");
    }

    if (button) {
      button.disabled = true;
      button.textContent = "Saving overrides...";
    }

    const response = await fetch("./api/overrides", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ overrides: getPublishableOverrideState() }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || "Could not save published overrides.");
    }

    runtime.sharedOverrides = normalizeSharedOverridePayload(payload);
    state.overrides = normalizeOverrideState();
    applyManualOverrides();
    persistAndRender();
    window.alert("Overrides saved to data/overrides.json. Use \"Publish to GitHub Pages\" to publish them to the live site.");
  } catch (error) {
    window.alert(error?.message || "Could not save published overrides.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || "Save current overrides for publish";
    }
  }
}

async function refreshSteamProgress() {
  // Always a full refresh (per-month scope removed); the server's playtime-delta
  // gate means only games actually played since last time are re-fetched.
  const button = elements.steamRefreshAllButton;
  const label = button?.textContent;

  try {
    if (runtime.staticApi) {
      throw new Error("GitHub Pages is read-only. Refresh cached data through GitHub Actions or the local server.");
    }
    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing Steam data...";
    }
    const response = await fetch("./api/refresh-steam-progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fullRefresh: true }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || "Could not refresh Steam progress.");
    }
    await loadStoredSteamProgress({ silent: true });
    await loadDashboardData({ silent: true });
  } catch (error) {
    window.alert(
      error?.message ||
        "Could not refresh Steam progress. Check that the local server is running and that SteamGifts sync data exists.",
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label || "Refresh Steam data";
    }
  }
}

async function loadStoredSteamProgress(options = {}) {
  try {
    const result =
      options.prefetched?.payload != null ? options.prefetched : await fetchApiJson("./api/steam-progress");
    const payload = result.payload;
    if (payload?.progress?.length) {
      applySteamProgress(payload);
    } else if (!options.silent) {
      window.alert("No stored Steam progress was found yet.");
    }
  } catch (error) {
    if (!options.silent) {
      window.alert("Could not load stored Steam progress from the local server.");
    }
  }
}

function importSteamGiftsSync(payload, options = {}) {
  const sync = normalizeSteamGiftsSync(payload);
  state.settings.groupName = sync.group?.name || state.settings.groupName;
  state.settings.activeMembers =
    sync.members.filter((member) => member.isActiveMember).length || state.settings.activeMembers;
  state.settings.currentDate = sync.syncedAt ? String(sync.syncedAt).slice(0, 10) : state.settings.currentDate;
  state.sync = {
    ...state.sync,
    steamgifts: sync,
  };

  for (const memberRecord of sync.members) {
    upsertMemberFromSync(memberRecord);
  }

  for (const giveawayRecord of sync.giveaways) {
    const creatorId = upsertMemberFromSync({
      username: giveawayRecord.creatorUsername,
      steamProfile: sync.memberSteamProfiles[giveawayRecord.creatorUsername] || "",
      isActiveMember: sync.memberActivity[giveawayRecord.creatorUsername],
    });
    upsertGiveawayFromSync(giveawayRecord, creatorId);

    for (const winner of giveawayRecord.winners) {
      const memberId = upsertMemberFromSync({
        username: winner.username,
        steamProfile: sync.memberSteamProfiles[winner.username] || "",
        isActiveMember: sync.memberActivity[winner.username],
      });
      const gameId = upsertGameFromSync(giveawayRecord);
      upsertWinFromSync(giveawayRecord, winner, memberId, gameId);
    }
  }

  applyManualOverrides();

  if (options.persist !== false) {
    persistAndRender();
  } else {
    render();
  }
}

function applySteamProgress(payload) {
  const progressItems = payload?.progress || [];
  const hltbItems = payload?.hltb || [];
  const progressByKey = new Map(
    progressItems.map((item) => [`${item.steamProfile}|${item.appId}`, item]),
  );
  const hltbByAppId = new Map(
    hltbItems
      .filter((item) => item?.appId && item?.hltbHours)
      .map((item) => [Number(item.appId), Number(item.hltbHours)]),
  );
  const hltbByTitle = new Map(
    hltbItems
      .filter((item) => item?.title && item?.hltbHours)
      .map((item) => [item.title, Number(item.hltbHours)]),
  );

  state.wins = state.wins.map((win) => {
    const member = findById("members", win.memberId);
    const game = findById("games", win.gameId);
    if (!member?.steamProfile || !game?.appId) {
      return win;
    }

    const progress = progressByKey.get(`${member.steamProfile}|${game.appId}`);
    if (!progress) {
      return win;
    }

    const nextWin = { ...win };
    nextWin.currentHours =
      progress.playtimeHours !== null && progress.playtimeHours !== undefined
        ? progress.playtimeHours
        : nextWin.currentHours;
    nextWin.earnedAchievements = progress.earnedAchievements ?? nextWin.earnedAchievements;
    nextWin.proofProvided = progress.visible;
    nextWin.evidenceNotes = progress.progressUrl
      ? `Steam sync: ${progress.progressUrl}`
      : nextWin.evidenceNotes;
    return nextWin;
  });

  state.games = state.games.map((game) => {
    const progress = progressItems.find((item) => Number(item.appId) === Number(game.appId));
    if (!progress) {
      return game;
    }
    return {
      ...game,
      hltbHours:
        hltbByAppId.get(Number(game.appId)) || hltbByTitle.get(game.title) || Number(game.hltbHours || 0),
      achievementsTotal:
        progress.totalAchievements > 0 ? progress.totalAchievements : game.achievementsTotal,
    };
  });

  applyManualOverrides();

  state.sync = {
    ...state.sync,
    steamProgressUpdatedAt: payload?.updatedAt || new Date().toISOString(),
    lastProgressStats: payload?.stats || null,
    lastLibraryStats: payload?.libraryStats || state.sync?.lastLibraryStats || null,
  };

  persistAndRender();
}

function getSteamMediaUrls(appId) {
  const numericAppId = Number(appId || 0);
  if (!numericAppId) {
    return {
      headerImageUrl: "",
      capsuleImageUrl: "",
      capsuleSmallUrl: "",
    };
  }

  return {
    headerImageUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${numericAppId}/header.jpg`,
    capsuleImageUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${numericAppId}/capsule_616x353.jpg`,
    capsuleSmallUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${numericAppId}/capsule_184x69.jpg`,
  };
}

function hasMediaUrls(item) {
  return Boolean(item?.headerImageUrl || item?.capsuleImageUrl || item?.capsuleSmallUrl);
}

function mergeSteamMediaResults(results = []) {
  if (!results.length) {
    return null;
  }

  const mediaByAppId = new Map();
  for (const item of results) {
    const appId = Number(item?.appId || 0);
    if (!appId) {
      continue;
    }
    attemptedMediaAppIds.add(appId);
    if (hasMediaUrls(item)) {
      loadedMediaAppIds.add(appId);
    }
    mediaByAppId.set(appId, item);
  }

  if (!mediaByAppId.size) {
    return null;
  }

  state.games = state.games.map((game) => {
    const media = mediaByAppId.get(Number(game?.appId || 0));
    if (!media) {
      return game;
    }
    return {
      ...game,
      headerImageUrl: media.headerImageUrl || game.headerImageUrl || "",
      capsuleImageUrl: media.capsuleImageUrl || game.capsuleImageUrl || "",
      capsuleSmallUrl: media.capsuleSmallUrl || game.capsuleSmallUrl || "",
      releaseDate: media.releaseDate || game.releaseDate || "",
      comingSoon: typeof media.comingSoon === "boolean" ? media.comingSoon : Boolean(game.comingSoon),
    };
  });

  if (state.sync?.dashboard?.recentGiveaways?.length) {
    state.sync = {
      ...state.sync,
      dashboard: {
        ...state.sync.dashboard,
        recentGiveaways: state.sync.dashboard.recentGiveaways.map((giveaway) => {
          const media = mediaByAppId.get(Number(giveaway?.appId || 0));
          return media
            ? {
                ...giveaway,
                ...media,
                releaseDate: media.releaseDate || giveaway.releaseDate || "",
                comingSoon:
                  typeof media.comingSoon === "boolean" ? media.comingSoon : Boolean(giveaway.comingSoon),
              }
            : giveaway;
        }),
      },
    };
  }

  persistAndRender();
  return mediaByAppId;
}

function normalizeGiveawayMedia(giveaway) {
  const fallback = getSteamMediaUrls(giveaway?.appId);
  return {
    ...giveaway,
    headerImageUrl: giveaway?.headerImageUrl || fallback.headerImageUrl,
    capsuleImageUrl: giveaway?.capsuleImageUrl || fallback.capsuleImageUrl,
    capsuleSmallUrl: giveaway?.capsuleSmallUrl || fallback.capsuleSmallUrl,
    releaseDate: giveaway?.releaseDate || "",
    comingSoon: Boolean(giveaway?.comingSoon),
  };
}

function getVisibleMediaAppIds() {
  const appIds = new Set();
  const months = getAvailableMonths();
  const selectedMonth =
    months.includes(elements.monthlyFilter?.value || "") ? elements.monthlyFilter.value : months[0] || "";
  const monthlyWins = selectedMonth ? state.wins.filter((win) => getWinPlayMonth(win) === selectedMonth) : [];
  for (const win of monthlyWins) {
    const game = findById("games", win.gameId);
    const appId = Number(game?.appId || 0);
    if (appId) {
      appIds.add(appId);
    }
  }

  for (const giveaway of state.sync?.dashboard?.recentGiveaways || []) {
    const appId = Number(giveaway?.appId || 0);
    if (appId) {
      appIds.add(appId);
    }
  }

  return Array.from(appIds);
}

async function loadVisibleGameMedia(options = {}) {
  if (runtime.staticApi) {
    return;
  }

  const appIds = getVisibleMediaAppIds().filter((appId) => !attemptedMediaAppIds.has(appId));
  if (!appIds.length) {
    return;
  }

  try {
    const { payload } = await fetchApiJson(`./api/steam-media?appIds=${encodeURIComponent(appIds.join(","))}`);
    mergeSteamMediaResults(Object.values(payload?.results || {}));
  } catch (error) {
    if (!options.silent) {
      window.alert("Could not load Steam media fallbacks.");
    }
  }
}

async function fetchSteamMediaForApp(appId) {
  const numericAppId = Number(appId || 0);
  if (!numericAppId || runtime.staticApi) {
    return null;
  }
  if (pendingMediaRequests.has(numericAppId)) {
    return pendingMediaRequests.get(numericAppId);
  }

  const request = fetchApiJson(`./api/steam-media?appIds=${encodeURIComponent(String(numericAppId))}`)
    .then((payload) => {
      const mediaByAppId = mergeSteamMediaResults(Object.values(payload?.payload?.results || {}));
      return mediaByAppId?.get(numericAppId) || null;
    })
    .catch(() => null)
    .finally(() => {
      pendingMediaRequests.delete(numericAppId);
    });

  pendingMediaRequests.set(numericAppId, request);
  return request;
}

function normalizeSteamGiftsSync(payload) {
  const members = payload.members || [];
  const giveaways = (payload.giveaways || []).map((giveaway) =>
    normalizeGiveawaySyncRecord(normalizeGiveawayMedia(giveaway)),
  );
  const memberSteamProfiles = Object.fromEntries(
    members
      .filter((member) => member.username)
      .map((member) => [member.username, member.steamProfile || ""]),
  );
  const memberActivity = Object.fromEntries(
    members
      .filter((member) => member.username)
      .map((member) => [member.username, Boolean(member.isActiveMember)]),
  );
  const derivedWins = giveaways.flatMap((giveaway) =>
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
  const winsByKey = new Map();

  for (const win of payload.wins || []) {
    const key = `${String(win?.giveawayCode || "")}::${String(win?.winnerUsername || "")}`;
    if (!String(win?.giveawayCode || "") || !String(win?.winnerUsername || "")) {
      continue;
    }
    winsByKey.set(key, win);
  }

  for (const win of derivedWins) {
    const key = `${win.giveawayCode}::${win.winnerUsername}`;
    winsByKey.set(key, {
      ...(winsByKey.get(key) || {}),
      ...win,
    });
  }

  return {
    ...payload,
    members,
    giveaways,
    wins: Array.from(winsByKey.values()),
    memberSteamProfiles,
    memberActivity,
  };
}

function normalizeGiveawaySyncRecord(giveaway) {
  const winners = normalizeGiveawaySyncWinners(giveaway);
  const entryUsers = Array.from(
    new Set(
      (Array.isArray(giveaway?.entryUsers) ? giveaway.entryUsers : [])
        .map((username) => String(username || "").trim())
        .filter(Boolean),
    ),
  );
  const giveawayKind = normalizeGiveawayKindValue(giveaway?.giveawayKind, giveaway);
  return {
    ...giveaway,
    giveawayKind,
    winners,
    entryUsers,
    giveawayMonthOverride: giveawayKind === "cycle" ? normalizeGiveawayMonthOverrideValue(giveaway?.giveawayMonthOverride) : "",
    entriesFinalized: Boolean(giveaway?.entriesFinalized),
    entriesSnapshotAt: giveaway?.entriesSnapshotAt || "",
  };
}

function normalizeGiveawaySyncWinners(giveaway) {
  const winners = Array.isArray(giveaway?.winners) ? giveaway.winners.filter((winner) => winner?.username) : [];
  if (winners.length || String(giveaway?.resultStatus || "").toLowerCase() !== "won") {
    return winners;
  }

  return parseWinnerUsernamesFromResultLabel(giveaway.resultLabel).map((username) => ({
    username,
    profileUrl: "",
    status: "Won",
  }));
}

function parseWinnerUsernamesFromResultLabel(resultLabel) {
  const text = String(resultLabel || "").trim();
  if (!text || /^(open|awaiting feedback|no winners?)$/i.test(text)) {
    return [];
  }

  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function upsertMemberFromSync(memberRecord) {
  if (!memberRecord?.username) {
    return "";
  }

  let member = state.members.find(
    (item) => item.steamgiftsUsername === memberRecord.username || item.name === memberRecord.username,
  );

  if (!member) {
    member = {
      id: uid("member"),
      name: memberRecord.username,
      steamProfile: memberRecord.steamProfile || "",
      steamgiftsUsername: memberRecord.username,
      isActiveMember: Boolean(memberRecord.isActiveMember),
      joinDate: state.settings.currentDate,
    };
    state.members.unshift(member);
    return member.id;
  }

  member.steamgiftsUsername = memberRecord.username;
  if (!member.steamProfile && memberRecord.steamProfile) {
    member.steamProfile = memberRecord.steamProfile;
  }
  if (typeof memberRecord.isActiveMember === "boolean") {
    member.isActiveMember = memberRecord.isActiveMember;
  }
  return member.id;
}

function upsertGameFromSync(giveawayRecord) {
  const appId = Number(giveawayRecord.appId || 0);
  let game = state.games.find((item) =>
    appId ? Number(item.appId) === appId : item.title === giveawayRecord.title,
  );
  const media = normalizeGiveawayMedia(giveawayRecord);

  if (!game) {
    game = {
      id: uid("game"),
      title: giveawayRecord.title,
      appId,
      hltbHours: Number(giveawayRecord.hltbHours || 0),
      achievementsTotal: Number(giveawayRecord.totalAchievements || 0),
      steamAppUrl: giveawayRecord.steamAppUrl || "",
      releaseDate: giveawayRecord.releaseDate || "",
      comingSoon: Boolean(giveawayRecord.comingSoon),
      headerImageUrl: media.headerImageUrl,
      capsuleImageUrl: media.capsuleImageUrl,
      capsuleSmallUrl: media.capsuleSmallUrl,
    };
    state.games.unshift(game);
    return game.id;
  }

  if (!game.appId && appId) {
    game.appId = appId;
  }
  if (!game.hltbHours && giveawayRecord.hltbHours) {
    game.hltbHours = Number(giveawayRecord.hltbHours);
  }
  if (!game.achievementsTotal && giveawayRecord.totalAchievements) {
    game.achievementsTotal = Number(giveawayRecord.totalAchievements);
  }
  if (!game.steamAppUrl && giveawayRecord.steamAppUrl) {
    game.steamAppUrl = giveawayRecord.steamAppUrl;
  }
  if (giveawayRecord.releaseDate && game.releaseDate !== giveawayRecord.releaseDate) {
    game.releaseDate = giveawayRecord.releaseDate;
  }
  if (typeof giveawayRecord.comingSoon === "boolean" && game.comingSoon !== giveawayRecord.comingSoon) {
    game.comingSoon = Boolean(giveawayRecord.comingSoon);
  }
  if (!game.headerImageUrl && media.headerImageUrl) {
    game.headerImageUrl = media.headerImageUrl;
  }
  if (!game.capsuleImageUrl && media.capsuleImageUrl) {
    game.capsuleImageUrl = media.capsuleImageUrl;
  }
  if (!game.capsuleSmallUrl && media.capsuleSmallUrl) {
    game.capsuleSmallUrl = media.capsuleSmallUrl;
  }
  return game.id;
}

function upsertGiveawayFromSync(giveawayRecord, creatorId) {
  const sourceId = `sg-${giveawayRecord.code}`;
  const existing = state.giveaways.find((item) => item.sourceId === sourceId);
  const normalizedKind = normalizeGiveawayKindValue(giveawayRecord.giveawayKind, giveawayRecord);
  const payload = {
    id: existing?.id || uid("giveaway"),
    sourceId,
    creatorId,
    title: giveawayRecord.title,
    type: "sync",
    createdAt: giveawayRecord.startDate || giveawayRecord.endDate || state.settings.currentDate,
    valuePoints: Number(giveawayRecord.points || 0),
    entriesCount: Number(giveawayRecord.entriesCount || 0),
    regionLocked: Boolean(giveawayRecord.regionRestricted),
    bundled: false,
    notes: giveawayRecord.url || "",
    giveawayKind: normalizedKind,
    giveawayMonthOverride: normalizedKind === "cycle" ? normalizeGiveawayMonthOverrideValue(giveawayRecord.giveawayMonthOverride) : "",
    penaltyForCode: String(giveawayRecord.penaltyForCode || existing?.penaltyForCode || "").trim(),
    giveawayKindChecked: Boolean(giveawayRecord.giveawayKindChecked),
    creatorUsername: giveawayRecord.creatorUsername || existing?.creatorUsername || "",
    entryUsers: Array.isArray(giveawayRecord.entryUsers) ? giveawayRecord.entryUsers.slice() : existing?.entryUsers || [],
    entriesFinalized: Boolean(giveawayRecord.entriesFinalized),
    entriesSnapshotAt: giveawayRecord.entriesSnapshotAt || existing?.entriesSnapshotAt || "",
    resultStatus: String(giveawayRecord.resultStatus || "").toLowerCase(),
    resultLabel: giveawayRecord.resultLabel || "",
    appId: Number(giveawayRecord.appId || 0) || existing?.appId || null,
    steamAppUrl: giveawayRecord.steamAppUrl || existing?.steamAppUrl || "",
    headerImageUrl: giveawayRecord.headerImageUrl || existing?.headerImageUrl || "",
    capsuleImageUrl: giveawayRecord.capsuleImageUrl || existing?.capsuleImageUrl || "",
    capsuleSmallUrl: giveawayRecord.capsuleSmallUrl || existing?.capsuleSmallUrl || "",
    startDate: giveawayRecord.startDate || existing?.startDate || "",
    endDate: giveawayRecord.endDate || existing?.endDate || "",
  };

  if (!existing) {
    state.giveaways.unshift(payload);
  } else {
    Object.assign(existing, payload);
  }
}

function upsertWinFromSync(giveawayRecord, winnerRecord, memberId, gameId) {
  const sourceId = `sg-win-${giveawayRecord.code}-${winnerRecord.username}`;
  const existing = state.wins.find((item) => item.sourceId === sourceId);
  const payload = {
    id: existing?.id || uid("win"),
    sourceId,
    giveawaySourceId: `sg-${giveawayRecord.code}`,
    memberId,
    gameId,
    creatorUsername: giveawayRecord.creatorUsername || existing?.creatorUsername || "",
    giveawayUrl: giveawayRecord.url || existing?.giveawayUrl || "",
    winDate: giveawayRecord.endDate || state.settings.currentDate,
    ruleMode: "standard-25",
    currentHours: Number(existing?.currentHours ?? giveawayRecord.currentHours ?? 0),
    earnedAchievements: Number(existing?.earnedAchievements ?? giveawayRecord.earnedAchievements ?? 0),
    proofProvided: Boolean(existing?.proofProvided ?? giveawayRecord.proofProvided ?? giveawayRecord.earnedAchievements > 0),
    evidenceNotes:
      existing?.evidenceNotes ||
      giveawayRecord.notes ||
      (giveawayRecord.url ? `SteamGifts sync: ${giveawayRecord.url}` : ""),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  if (!existing) {
    state.wins.unshift(payload);
  } else {
      Object.assign(existing, {
        ...payload,
        currentHours: existing.currentHours,
        earnedAchievements: existing.earnedAchievements,
        proofProvided: existing.proofProvided,
        giveawayUrl: existing.giveawayUrl || payload.giveawayUrl,
        evidenceNotes: existing.evidenceNotes || payload.evidenceNotes,
      });
  }
}

function buildAlerts() {
  const evaluations = state.wins.map(evaluateWin);
  const overdue = evaluations.filter((evaluation) => evaluation.state === "overdue");
  const dueSoon = evaluations.filter((evaluation) => evaluation.state === "due-soon");
  const penaltyMembers = new Map();
  overdue.forEach((evaluation) => {
    penaltyMembers.set(evaluation.member.name, (penaltyMembers.get(evaluation.member.name) || 0) + 1);
  });

  const cycleAlerts = state.members
    .map((member) => {
      const memberMetrics = computeMemberMetrics(member.id);
      return { member, ...memberMetrics };
    })
    .filter((item) => item.cycleAlert);

  const invalidGiveaways = state.giveaways
    .map((giveaway) => ({ giveaway, validation: evaluateGiveaway(giveaway) }))
    .filter((item) => item.validation.issues.length);

  const alerts = [];

  if (overdue.length) {
    alerts.push({
      level: "danger",
      title: "Wins past the 4-month deadline",
      html: `<ul>${overdue
        .slice(0, 6)
        .map(
          (evaluation) =>
            `<li><strong>${escapeHtml(evaluation.member.name)}</strong> must resolve <strong>${escapeHtml(evaluation.game.title)}</strong> (${evaluation.penaltyText.toLowerCase()}).</li>`,
        )
        .join("")}</ul>`,
    });
  }

  if (penaltyMembers.size) {
    alerts.push({
      level: "warning",
      title: "Extra giveaways owed as penalties",
      html: `<ul>${Array.from(penaltyMembers.entries())
        .map(([name, count]) => `<li><strong>${escapeHtml(name)}</strong> owes ${count} penalty giveaway(s).</li>`)
        .join("")}</ul>`,
    });
  }

  if (dueSoon.length) {
    alerts.push({
      level: "info",
      title: "Wins due within the next 30 days",
      html: `<ul>${dueSoon
        .slice(0, 6)
        .map(
          (evaluation) =>
            `<li><strong>${escapeHtml(evaluation.member.name)}</strong> needs to make progress in <strong>${escapeHtml(evaluation.game.title)}</strong> by ${formatDate(evaluation.deadline)}.</li>`,
        )
        .join("")}</ul>`,
    });
  }

  if (cycleAlerts.length) {
    alerts.push({
      level: "warning",
      title: "Current cycle status",
      html: `<ul>${cycleAlerts
        .slice(0, 8)
        .map((item) => `<li><strong>${escapeHtml(item.member.name)}</strong>: ${item.cycleAlert}</li>`)
        .join("")}</ul>`,
    });
  }

  if (invalidGiveaways.length) {
    alerts.push({
      level: "warning",
      title: "Giveaways with issues",
      html: `<ul>${invalidGiveaways
        .slice(0, 6)
        .map(
          ({ giveaway, validation }) =>
            `<li><strong>${escapeHtml(giveaway.title)}</strong>: ${escapeHtml(validation.issues.join(", "))}</li>`,
        )
        .join("")}</ul>`,
    });
  }

  return alerts;
}

function computeMetrics() {
  const winEvaluations = state.wins.map(evaluateWin);
  const cycleWinCounts = new Map();

  state.members.forEach((member) => {
    cycleWinCounts.set(member.id, computeCycleWinsForMember(member.id));
  });

  return {
    overdueWins: winEvaluations.filter((item) => item.state === "overdue").length,
    dueSoonWins: winEvaluations.filter((item) => item.state === "due-soon").length,
    penaltyGiveawaysOwed: winEvaluations.filter((item) => item.penaltyOwed).length,
    membersOverWinCap: Array.from(cycleWinCounts.values()).filter((wins) => wins > 8).length,
    minimumEntriesRequired: computeMinimumEntriesRequired(),
  };
}

function computeMemberMetrics(memberId) {
  const currentMonth = monthKey(state.settings.currentDate);
  const cycleWins = computeCycleWinsForMember(memberId);
  const penalties = state.wins
    .map(evaluateWin)
    .filter((evaluation) => evaluation.member.id === memberId && evaluation.penaltyOwed).length;
  const period = getPeriodInfo(state.settings.currentDate);
  const paused = period.kind === "cycle" && getCycleMemberStatus(memberId, currentMonth) === "paused";
  const rule9Carryover = period.kind === "cycle" ? getRule9CarryoverForCycle(period) : null;
  const monthThreeWinsBeforeCurrentMonth =
    period.kind === "cycle" && period.monthPosition === 3 && currentMonth
      ? computeCycleWinsForMemberInMonth(memberId, currentMonth, { beforeSelectedMonth: true })
      : cycleWins;
  const monthThreeLuckStatus = getCycleMonthThreeLuckStatus(monthThreeWinsBeforeCurrentMonth);

  let cycleAlert = "";
  if (paused) {
    cycleAlert = "paused for this cycle: excluded from joins and mandatory giveaways.";
  } else if (period.kind === "cycle" && period.monthPosition === 1 && isRule9CarryoverWinner(rule9Carryover, memberId)) {
    cycleAlert = `Rule 9 winner of ${rule9Carryover.previousCycle.label}: exempt from the regular monthly mandatory giveaway in ${formatMonthKey(rule9Carryover.monthKey)}.`;
  } else if (period.kind === "cycle" && period.monthPosition === 3) {
    cycleAlert = monthThreeLuckStatus.alert;
  }

  if (cycleWins > 8) {
    const extra = cycleWins - 8;
    cycleAlert = `${cycleAlert ? `${cycleAlert} ` : ""}above the cycle limit by ${extra} win(s).`;
  }

  const soonestOverdue = state.wins
    .map(evaluateWin)
    .filter((evaluation) => evaluation.member.id === memberId && evaluation.state !== "compliant")
    .sort((a, b) => parseDate(a.deadline) - parseDate(b.deadline))[0];

  const nextAction = soonestOverdue
    ? `${soonestOverdue.state === "overdue" ? "Resolve overdue" : "Monitor"} ${soonestOverdue.game.title}`
    : cycleAlert || "No immediate action";

  return { cycleWins, penalties, nextAction, cycleAlert };
}

function computeCycleWinsForMember(memberId) {
  const currentMonth = monthKey(state.settings.currentDate);
  if (!currentMonth) {
    return 0;
  }
  return computeCycleWinsForMemberInMonth(memberId, currentMonth);
}

function evaluateWin(win) {
  const member = findById("members", win.memberId) || { id: "", name: "Membro removido" };
  const game =
    findById("games", win.gameId) || {
      id: "",
      title: "Jogo removido",
      hltbHours: 0,
      achievementsTotal: 0,
      releaseDate: "",
      comingSoon: false,
    };

  const deadlineBase = getDeadlineBaseDate(win.winDate, game.releaseDate);
  const deadline = addMonths(deadlineBase, 4);
  const now = parseDate(state.settings.currentDate);
  const daysLeft = differenceInDays(deadline, now);

  const requiredHours = getRequiredHours(getGameHltbHours(game), win.ruleMode);
  const requiredAchievements =
    win.ruleMode === "standard-25" && getGameAchievementsTotal(game) > 0
      ? getRequiredAchievementsTarget(win, game)
      : 0;

  const hoursOk = win.ruleMode === "true-100" ? true : win.currentHours >= requiredHours;
  const achievementsOk =
    requiredAchievements > 0
      ? win.earnedAchievements >= requiredAchievements
      : getGameAchievementsTotal(game) === 0
        ? win.proofProvided
        : true;
  const proofOk =
    win.ruleMode === "standard-25"
      ? getGameAchievementsTotal(game) > 0
        ? achievementsOk
        : win.proofProvided
      : win.proofProvided;

  const canEvaluateHours = win.ruleMode === "true-100" || requiredHours > 0;
  const canEvaluateAchievements = getGameAchievementsTotal(game) > 0 || win.proofProvided;
  const hasEnoughSignals = canEvaluateHours || canEvaluateAchievements;

  if (!hasEnoughSignals) {
    return {
      member,
      game,
      deadline,
      deadlineBase,
      state: "unknown",
      statusLabel: "Awaiting data",
      statusBadge: "info",
      penaltyOwed: false,
      penaltyText: "Fill HLTB data or run Steam sync",
      targetLabel: "Needs automatic data or manual parameters",
      progressLabel: "Not enough data to verify the rule",
    };
  }

  const compliant =
    win.ruleMode === "true-100"
      ? proofOk
      : (canEvaluateHours ? hoursOk : true) && (canEvaluateAchievements ? achievementsOk : true) && proofOk;

  let stateLabel = "due-soon";
  let statusLabel = "Monitor";
  let statusBadge = "warning";
  if (compliant) {
    stateLabel = "compliant";
    statusLabel = "Compliant";
    statusBadge = "success";
  } else if (daysLeft < 0) {
    stateLabel = "overdue";
    statusLabel = "Overdue";
    statusBadge = "danger";
  } else if (daysLeft > 30) {
    stateLabel = "monitoring";
    statusLabel = "Monitoring";
    statusBadge = "warning";
  }

  return {
    member,
    game,
    deadline,
    deadlineBase,
    state: stateLabel,
    statusLabel,
    statusBadge,
    penaltyOwed: !compliant && daysLeft < 0,
    penaltyText: !compliant && daysLeft < 0 ? "1 extra giveaway owed" : "None",
    targetLabel: describeTarget(win.ruleMode, requiredHours, requiredAchievements),
    progressLabel: describeProgress(win, game, requiredHours, requiredAchievements, compliant),
  };
}

function getDeadlineBaseDate(winDate, releaseDate) {
  if (!releaseDate) {
    return winDate;
  }
  const winMonth = monthKey(winDate);
  const releaseMonth = getReleaseMonthKey(releaseDate);
  if (!releaseMonth || releaseMonth <= winMonth) {
    return winDate;
  }
  const [year, month] = releaseMonth.split("-").map(Number);
  return formatISODateLocal(new Date(year, month - 1, 1, 12));
}

function getEffectiveMonthKey(baseDate, releaseDate) {
  const baseMonth = monthKey(baseDate);
  const releaseMonth = getReleaseMonthKey(releaseDate);
  if (!releaseMonth || releaseMonth <= baseMonth) {
    return baseMonth;
  }
  return releaseMonth;
}

function getWinReleaseDate(win, game) {
  if (game?.releaseDate) {
    return game.releaseDate;
  }
  const syncGiveaways = state.sync?.steamgifts?.giveaways || [];
  const giveawayByUrl = syncGiveaways.find((giveaway) => giveaway?.url && giveaway.url === win.giveawayUrl);
  if (giveawayByUrl?.releaseDate) {
    return giveawayByUrl.releaseDate;
  }
  const giveawayByGame = syncGiveaways.find(
    (giveaway) =>
      (Number(giveaway?.appId || 0) && Number(giveaway?.appId || 0) === Number(game?.appId || 0)) ||
      (giveaway?.title && giveaway.title === game?.title),
  );
  return giveawayByGame?.releaseDate || "";
}

function getRenderableCycleMonths(cycle) {
  const months = Array.isArray(cycle?.months) ? cycle.months : [];
  const currentMonth = monthKey(state.settings.currentDate || "");
  const visibleMonths = months.filter((month) => !currentMonth || month <= currentMonth);
  return visibleMonths.length ? visibleMonths : months;
}

function getAvailableCycles() {
  const cyclesByKey = new Map();

  for (const month of getAvailableMonths()) {
    const period = getPeriodInfo(`${month}-01`);
    if (period.kind !== "cycle") {
      continue;
    }

    const key = getCycleKey(period);
    if (!key || cyclesByKey.has(key)) {
      continue;
    }

    cyclesByKey.set(key, {
      ...period,
      key,
      months: getCycleMonthKeys(period),
    });
  }

  return Array.from(cyclesByKey.values()).sort((left, right) => right.year - left.year || right.cycleNumber - left.cycleNumber);
}

function buildCycleBestGifterAward(selectedCycle, cycleMonths, cycleGiveaways) {
  const cycleOnlyGiveaways = cycleGiveaways.filter(
    (giveaway) => getGiveawayKind(giveaway) === "cycle" && doesGiveawayCountForCycleMath(giveaway),
  );
  const grouped = new Map();

  for (const giveaway of cycleOnlyGiveaways) {
    if (!grouped.has(giveaway.creatorId)) {
      grouped.set(giveaway.creatorId, []);
    }
    grouped.get(giveaway.creatorId).push(Number(giveaway.entriesCount || 0));
  }

  const candidates = Array.from(grouped.entries())
    .map(([memberId, entries]) => {
      const member = findById("members", memberId);
      const totalEntries = entries.reduce((sum, value) => sum + value, 0);
      return {
        memberId,
        name: member?.name || "Unknown member",
        giveawayCount: entries.length,
        totalEntries,
        averageEntries: entries.length ? totalEntries / entries.length : 0,
        bestSingleEntries: entries.length ? Math.max(...entries) : 0,
      };
    })
    .filter((candidate) => candidate.giveawayCount >= 2)
    .sort(
      (left, right) =>
        right.averageEntries - left.averageEntries ||
        right.bestSingleEntries - left.bestSingleEntries ||
        left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }),
    );

  if (!candidates.length) {
    return {
      eligibleCount: 0,
      tieMembers: [],
      isComplete: cycleMonths.length === selectedCycle.months.length,
    };
  }

  const leader = candidates[0];
  const tieMembers = candidates
    .filter(
      (candidate) =>
        Math.abs(candidate.averageEntries - leader.averageEntries) < 0.001 &&
        candidate.bestSingleEntries === leader.bestSingleEntries,
    )
    .map((candidate) => candidate.name);

  return {
    eligibleCount: candidates.length,
    memberId: leader.memberId,
    winnerName: leader.name,
    giveawayCount: leader.giveawayCount,
    averageEntries: leader.averageEntries,
    bestSingleEntries: leader.bestSingleEntries,
    tieMembers,
    isComplete: cycleMonths.length === selectedCycle.months.length,
  };
}

function getWinTrackKind(win) {
  const giveaway = findGiveawayForWin(win);
  return giveaway ? getGiveawayKind(giveaway) : "cycle";
}

function computeCycleWinsForMemberInMonth(memberId, selectedMonth, options = {}) {
  const period = getPeriodInfo(`${selectedMonth}-01`);
  if (period.kind !== "cycle") {
    return 0;
  }

  const cycleMonths = new Set(getCycleMonthKeys(period));
  return state.wins.filter((win) => {
    if (win.memberId !== memberId || !isCycleWin(win)) {
      return false;
    }

    const effectiveMonth = getEffectiveWinMonth(win);
    if (!cycleMonths.has(effectiveMonth)) {
      return false;
    }

    if (options.beforeSelectedMonth) {
      return effectiveMonth < selectedMonth;
    }
    return effectiveMonth <= selectedMonth;
  }).length;
}

function countMemberGiveawaysForMonth(memberId, selectedMonth, kind) {
  return getGiveawaysForMonth(selectedMonth).filter((giveaway) => {
    if (giveaway.creatorId !== memberId) {
      return false;
    }
    return getGiveawayKind(giveaway) === kind && doesGiveawayCountForCycleMath(giveaway);
  }).length;
}

function getCyclePeriodInfo(periodOrMonth) {
  const period = typeof periodOrMonth === "string" ? getPeriodInfo(`${periodOrMonth}-01`) : periodOrMonth;
  if (!period || period.kind !== "cycle") {
    return null;
  }

  return {
    ...period,
    key: getCycleKey(period),
    months: getCycleMonthKeys(period),
  };
}

function getRecentRule9CycleKeys() {
  return new Set(getAvailableCycles().slice(0, 4).map((cycle) => cycle.key));
}

function getCycleGiveawaysForMonths(cycleMonths) {
  return cycleMonths.flatMap((month) => getGiveawaysForMonth(month));
}

function getRule9CarryoverForCycle(periodOrMonth) {
  const cycle = getCyclePeriodInfo(periodOrMonth);
  if (!cycle || !getRecentRule9CycleKeys().has(cycle.key)) {
    return null;
  }

  const previousCyclePeriod = getPreviousCyclePeriod(cycle);
  const previousCycle = getCyclePeriodInfo(previousCyclePeriod);
  if (!previousCycle) {
    return null;
  }

  const availableMonths = new Set(getAvailableMonths());
  if (!previousCycle.months.every((month) => availableMonths.has(month))) {
    return null;
  }

  const award = buildCycleBestGifterAward(previousCycle, previousCycle.months, getCycleGiveawaysForMonths(previousCycle.months));
  const monthKeyValue = cycle.months[0] || "";
  if (!award.eligibleCount) {
    return {
      status: "none",
      cycle,
      previousCycle,
      monthKey: monthKeyValue,
    };
  }

  if (award.tieMembers.length > 1) {
    return {
      status: "tie",
      cycle,
      previousCycle,
      monthKey: monthKeyValue,
      tieMembers: award.tieMembers,
    };
  }

  return {
    status: "winner",
    cycle,
    previousCycle,
    monthKey: monthKeyValue,
    memberId: award.memberId,
    memberName: award.winnerName,
  };
}

function isRule9CarryoverWinner(rule9Carryover, memberId) {
  return Boolean(rule9Carryover && rule9Carryover.status === "winner" && rule9Carryover.memberId === memberId);
}

function getRequiredCycleGiveawaysForMember(memberId, selectedMonth, options = {}) {
  const period = getPeriodInfo(`${selectedMonth}-01`);
  if (period.kind !== "cycle") {
    return 0;
  }

  if (period.monthPosition < 3) {
    const rule9Carryover = options.rule9Carryover === undefined ? getRule9CarryoverForCycle(period) : options.rule9Carryover;
    if (period.monthPosition === 1 && isRule9CarryoverWinner(rule9Carryover, memberId)) {
      return 0;
    }
    return 1;
  }

  const winsBeforeMonth = computeCycleWinsForMemberInMonth(memberId, selectedMonth, { beforeSelectedMonth: true });
  if (winsBeforeMonth < 2) {
    return 0;
  }
  if (winsBeforeMonth > 2) {
    return 2;
  }
  return 1;
}

function getRequiredCycleGiveawaysForCycle(memberId, cycleMonths, options = {}) {
  return cycleMonths.reduce(
    (total, month) => total + getRequiredCycleGiveawaysForMember(memberId, month, options),
    0,
  );
}

function buildCycleStatus({
  period,
  winsBeforeMonth,
  cycleWinsToDate,
  cycleGiveawaysThisMonth,
  requiredGiveaways,
  rule9Carryover,
  paused,
}) {
  if (paused) {
    return {
      level: "info",
      label: "Paused",
      note: "Paused in this cycle. The member is excluded from joining and from giveaway obligations.",
    };
  }

  const noteParts = [];
  if (period.monthPosition === 1 && rule9Carryover) {
    noteParts.push(`Rule 9 carryover: month 1 is waived after winning ${rule9Carryover.previousCycle.label}.`);
  } else if (period.monthPosition === 3) {
    noteParts.push(getCycleMonthThreeLuckStatus(winsBeforeMonth).note);
  } else {
    noteParts.push("Regular month: one cycle giveaway is required.");
  }

  let level = "success";
  let label = "On track";
  if (cycleGiveawaysThisMonth < requiredGiveaways) {
    level = "danger";
    label = `Needs ${requiredGiveaways - cycleGiveawaysThisMonth} more`;
  } else if (cycleGiveawaysThisMonth > requiredGiveaways) {
    level = "info";
    label = `${cycleGiveawaysThisMonth - requiredGiveaways} extra logged`;
  }

  if (cycleWinsToDate > 8) {
    level = level === "danger" ? "danger" : "warning";
    noteParts.push(`Above the 8-win cycle cap by ${cycleWinsToDate - 8}.`);
  }

  const memberTag = period.monthPosition === 3 ? getCycleMonthThreeLuckStatus(winsBeforeMonth) : null;

  return {
    level,
    label,
    note: noteParts.join(" "),
    memberTagLabel: memberTag?.badgeLabel || "",
    memberTagLevel: memberTag?.badgeLevel || "",
  };
}

function buildCycleHistoryStatus({
  cycleMonths,
  winsBeforeMonthThree,
  cycleWinsTotal,
  cycleGiveawaysTotal,
  requiredGiveaways,
  rule9Carryover,
  paused,
}) {
  if (paused) {
    return {
      level: "info",
      label: "Paused",
      note: "Paused in this cycle. The member is excluded from joins and mandatory giveaways.",
    };
  }

  const lastMonth = cycleMonths[cycleMonths.length - 1] || "";
  const lastPeriod = lastMonth ? getPeriodInfo(`${lastMonth}-01`) : null;
  const noteParts = [];

  if (rule9Carryover) {
    noteParts.push(`Month 1 Rule 9 carryover applied after winning ${rule9Carryover.previousCycle.label}.`);
  }

  if (lastPeriod?.kind === "cycle" && lastPeriod.monthPosition === 3) {
    noteParts.push(getCycleMonthThreeLuckStatus(winsBeforeMonthThree).historyNote);
  }

  if (!noteParts.length) {
    noteParts.push(lastMonth ? `Compact cycle totals through ${formatMonthKey(lastMonth)}.` : "Compact cycle totals.");
  }

  let level = "success";
  let label = "On track";
  if (cycleGiveawaysTotal < requiredGiveaways) {
    level = "danger";
    label = `Needs ${requiredGiveaways - cycleGiveawaysTotal} more`;
  } else if (cycleGiveawaysTotal > requiredGiveaways) {
    level = "info";
    label = `${cycleGiveawaysTotal - requiredGiveaways} extra logged`;
  }

  if (cycleWinsTotal > 8) {
    level = level === "danger" ? "danger" : "warning";
    noteParts.push(`Above the 8-win cycle cap by ${cycleWinsTotal - 8}.`);
  }

  const memberTag = lastPeriod?.kind === "cycle" && lastPeriod.monthPosition === 3
    ? getCycleMonthThreeLuckStatus(winsBeforeMonthThree)
    : null;

  return {
    level,
    label,
    note: noteParts.join(" "),
    memberTagLabel: memberTag?.badgeLabel || "",
    memberTagLevel: memberTag?.badgeLevel || "",
  };
}

function buildPrereleaseMonthNote(win, game) {
  const releaseDate = getWinReleaseDate(win, game);
  const winMonth = monthKey(win.winDate);
  const releaseMonth = getReleaseMonthKey(releaseDate);
  if (!releaseMonth || releaseMonth <= winMonth) {
    return "";
  }
  return `Won in ${formatMonthKey(winMonth)}, released ${formatDate(releaseDate)}`;
}

function getReleaseMonthKey(releaseDate) {
  const raw = String(releaseDate || "").trim();
  if (!raw) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw.slice(0, 7);
  }
  const normalized = raw.replace(/,/g, "");
  const dayMonthYear = normalized.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const monthYear = normalized.match(/^([A-Za-z]+)\s+(\d{4})$/);
  const monthLookup = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const match = dayMonthYear || monthYear;
  if (!match) {
    return "";
  }
  const [, monthName, year] = dayMonthYear
    ? [match[0], match[2], match[3]]
    : [match[0], match[1], match[2]];
  const month = monthLookup[String(monthName).toLowerCase()];
  if (!month) {
    return "";
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function evaluateGiveaway(giveaway) {
  const issues = [];
  const threshold = computeMinimumEntriesRequired();
  const kind = getGiveawayKind(giveaway);
  const appliesStandardRules = kind !== "extra";

  if (appliesStandardRules && giveaway.valuePoints < state.settings.minimumValuePoints) {
    issues.push(`below ${state.settings.minimumValuePoints}P`);
  }
  if (appliesStandardRules && parseDate(giveaway.createdAt).getDate() > 15) {
    issues.push("created after the 15th");
  }
  if (appliesStandardRules && giveaway.regionLocked) {
    issues.push("region locked");
  }
  if (appliesStandardRules && giveaway.bundled) {
    issues.push("invalid bundled game");
  }
  if (appliesStandardRules && giveaway.entriesCount < threshold) {
    issues.push("did not reach the threshold");
  }

  return {
    issues,
    label: issues.length ? "Review" : kind === "extra" ? "Extra" : "Valid",
    level: issues.length ? "warning" : kind === "extra" ? "info" : "success",
  };
}

function describeTarget(ruleMode, requiredHours, requiredAchievements) {
  const hoursLabel =
    ruleMode === "true-100"
      ? "Complete the game and provide proof"
      : `${formatHours(requiredHours)} required`;

  if (ruleMode === "standard-25") {
    if (!requiredHours && requiredAchievements) {
      return `${requiredAchievements} achievement(s)`;
    }
    return requiredAchievements
      ? `${hoursLabel} + ${requiredAchievements} achievement(s)`
      : `${hoursLabel} + proof`;
  }

  if (!requiredHours) {
    return "Proof required";
  }

  return `${hoursLabel} + proof`;
}

function describeProgress(win, game, requiredHours, requiredAchievements, compliant) {
  if (compliant) {
    return "Target met";
  }

  const progressBits = [];
  if (win.ruleMode !== "true-100") {
    progressBits.push(`${formatHours(win.currentHours)} / ${formatHours(requiredHours)}`);
  }
  if (requiredAchievements > 0) {
    progressBits.push(`${win.earnedAchievements} / ${requiredAchievements} achievements`);
  } else if (game.achievementsTotal === 0 || win.ruleMode !== "standard-25") {
    progressBits.push(win.proofProvided ? "proof attached" : "no proof");
  }
  return progressBits.join(" • ");
}

function buildEvidenceNoteMarkup(note) {
  const value = String(note || "").trim();
  if (!value) {
    return "";
  }

  const steamSyncMatch = value.match(/^Steam sync:\s*(https?:\/\/\S+)$/i);
  if (steamSyncMatch) {
    return `<span class="meta-line">Steam sync: <a class="linked-title" href="${escapeHtml(steamSyncMatch[1])}" target="_blank" rel="noreferrer">Open achievements page</a></span>`;
  }

  const urlOnlyMatch = value.match(/^(https?:\/\/\S+)$/i);
  if (urlOnlyMatch) {
    return `<span class="meta-line"><a class="linked-title" href="${escapeHtml(urlOnlyMatch[1])}" target="_blank" rel="noreferrer">Open evidence link</a></span>`;
  }

  return `<span class="meta-line">${escapeHtml(value)}</span>`;
}

function computeMinimumEntriesRequired() {
  return Math.max(1, Math.floor(Number(state.settings.activeMembers) * 0.1));
}

function exportData() {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "akatsuki-monitor-data.json";
  link.click();
  URL.revokeObjectURL(url);
}

function importData(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (imported?.source === "akatsuki-steamgifts-sync") {
        importSteamGiftsSync(imported);
      } else {
        state = {
          ...cloneState(defaultState),
          ...imported,
        };
        persistAndRender();
      }
    } catch (error) {
      window.alert("Could not import the JSON file.");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function seedDemoData() {
  state = {
    settings: {
      groupName: "Akatsuki",
      activeMembers: 34,
      minimumValuePoints: 15,
      currentDate: todayISO(),
    },
    sync: {
      steamgifts: null,
      steamProgressUpdatedAt: null,
    },
    members: [
      {
        id: "member-alice",
        name: "Alice",
        steamProfile: "https://steamcommunity.com/id/alice",
        joinDate: "2025-01-04",
      },
      {
        id: "member-bruno",
        name: "Bruno",
        steamProfile: "https://steamcommunity.com/id/bruno",
        joinDate: "2024-08-11",
      },
      {
        id: "member-carol",
        name: "Carol",
        steamProfile: "https://steamcommunity.com/id/carol",
        joinDate: "2023-03-20",
      },
    ],
    games: [
      {
        id: "game-hades",
        title: "Hades",
        appId: 1145360,
        hltbHours: 22,
        achievementsTotal: 49,
      },
      {
        id: "game-celeste",
        title: "Celeste",
        appId: 504230,
        hltbHours: 8,
        achievementsTotal: 31,
      },
      {
        id: "game-dorfromantik",
        title: "Dorfromantik",
        appId: 1455840,
        hltbHours: 12,
        achievementsTotal: 0,
      },
    ],
    wins: [
      {
        id: "win-1",
        memberId: "member-alice",
        gameId: "game-hades",
        winDate: shiftDate(todayISO(), -150),
        ruleMode: "standard-25",
        currentHours: 2,
        earnedAchievements: 1,
        proofProvided: false,
        evidenceNotes: "",
      },
      {
        id: "win-2",
        memberId: "member-bruno",
        gameId: "game-celeste",
        winDate: shiftDate(todayISO(), -100),
        ruleMode: "custom-50",
        currentHours: 3,
        earnedAchievements: 5,
        proofProvided: false,
        evidenceNotes: "",
      },
      {
        id: "win-3",
        memberId: "member-carol",
        gameId: "game-dorfromantik",
        winDate: shiftDate(todayISO(), -35),
        ruleMode: "standard-25",
        currentHours: 4,
        earnedAchievements: 0,
        proofProvided: true,
        evidenceNotes: "Screenshot validated by admin",
      },
      {
        id: "win-4",
        memberId: "member-bruno",
        gameId: "game-hades",
        winDate: shiftDate(todayISO(), -15),
        ruleMode: "standard-25",
        currentHours: 0,
        earnedAchievements: 0,
        proofProvided: false,
        evidenceNotes: "",
      },
      {
        id: "win-5",
        memberId: "member-bruno",
        gameId: "game-dorfromantik",
        winDate: shiftDate(todayISO(), -8),
        ruleMode: "standard-25",
        currentHours: 0,
        earnedAchievements: 0,
        proofProvided: false,
        evidenceNotes: "",
      },
    ],
    giveaways: [
      {
        id: "ga-1",
        creatorId: "member-alice",
        title: "Hollow Knight",
        type: "mandatory",
        createdAt: startOfCurrentMonth(),
        valuePoints: 15,
        entriesCount: 4,
        regionLocked: false,
        bundled: false,
        notes: "",
      },
      {
        id: "ga-2",
        creatorId: "member-bruno",
        title: "Mystery bundle key",
        type: "mandatory",
        createdAt: setDayOfCurrentMonth(18),
        valuePoints: 7,
        entriesCount: 2,
        regionLocked: true,
        bundled: true,
        notes: "",
      },
    ],
  };

  persistAndRender();
}

function resetData() {
  if (!window.confirm("This will erase all data saved in this browser. Continue?")) {
    return;
  }

  clearStoredSyncState({ persist: true, resetSettings: true });
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return normalizeLoadedState();
    }
    return normalizeLoadedState(JSON.parse(raw));
  } catch (error) {
    return normalizeLoadedState();
  }
}

function persistAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildPersistedState()));
  render();
}

function buildPersistedState() {
  const hasServerSync = state.sync?.steamgifts?.source === "akatsuki-steamgifts-sync";
  if (!hasServerSync) {
    return {
      ...state,
      sharedOverrides: undefined,
      overrides: normalizeOverrideState(state.overrides),
    };
  }

  return {
    ...cloneState(defaultState),
    settings: { ...state.settings },
    sync: {
      steamgifts: null,
      steamProgressUpdatedAt: state.sync?.steamProgressUpdatedAt || null,
    },
    sharedOverrides: undefined,
    overrides: normalizeOverrideState(state.overrides),
  };
}

function normalizeLoadedState(rawState = {}) {
  return {
    ...cloneState(defaultState),
    ...rawState,
    sync: {
      ...cloneState(defaultState).sync,
      ...(rawState.sync || {}),
    },
    overrides: normalizeOverrideState(rawState.overrides),
  };
}

function normalizeOverrideState(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  return {
    games: { ...(source.games || {}) },
    wins: { ...(source.wins || {}) },
    giveaways: { ...(source.giveaways || {}) },
    cycleMembers: { ...(source.cycleMembers || {}) },
    members: { ...(source.members || {}) },
  };
}

function normalizeSharedOverridePayload(payload = {}) {
  const rawOverrides = payload?.overrides && typeof payload.overrides === "object" ? payload.overrides : payload;
  const normalized = normalizeOverrideState(rawOverrides);
  return {
    ...normalized,
    cycleMembers: sanitizeCycleMemberOverrides(normalized.cycleMembers),
  };
}

function mergeOverrideStates(baseOverrides = {}, overridingOverrides = {}) {
  const base = normalizeOverrideState(baseOverrides);
  const overriding = normalizeOverrideState(overridingOverrides);
  return {
    games: { ...base.games, ...overriding.games },
    wins: { ...base.wins, ...overriding.wins },
    giveaways: { ...base.giveaways, ...overriding.giveaways },
    cycleMembers: { ...base.cycleMembers, ...overriding.cycleMembers },
    members: { ...base.members, ...overriding.members },
  };
}

function getEffectiveOverrideState() {
  return mergeOverrideStates(runtime.sharedOverrides, state.overrides);
}

function getPublishableOverrideState() {
  const overrides = getEffectiveOverrideState();
  return {
    ...overrides,
    cycleMembers: sanitizeCycleMemberOverrides(overrides.cycleMembers),
  };
}

function sanitizeCycleMemberOverrides(cycleMembers = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(cycleMembers || {})) {
    const normalizedKey = normalizeCycleMemberOverrideEntryKey(key);
    if (!normalizedKey) {
      continue;
    }
    sanitized[normalizedKey] = { ...(value || {}) };
  }
  return sanitized;
}

function normalizeCycleMemberOverrideEntryKey(key) {
  const rawKey = String(key || "").trim();
  const separatorIndex = rawKey.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === rawKey.length - 1) {
    return "";
  }

  const cycleKey = rawKey.slice(0, separatorIndex);
  const memberKey = rawKey.slice(separatorIndex + 1);
  if (!memberKey.startsWith("member-")) {
    return `${cycleKey}:${memberKey}`;
  }

  const member = findById("members", memberKey);
  const stableKey = getStableCycleMemberKey(member);
  return stableKey ? `${cycleKey}:${stableKey}` : "";
}

function applyManualOverrides() {
  const overrides = getEffectiveOverrideState();
  runtime.sharedOverrides = normalizeOverrideState(runtime.sharedOverrides);
  state.overrides = normalizeOverrideState(state.overrides);

  state.games = state.games.map((game) => {
    const key = getGameOverrideKey(game);
    const nextGame = stripOverrideFields(game, GAME_OVERRIDE_FIELDS);
    return {
      ...nextGame,
      ...(key ? overrides.games[key] || {} : {}),
    };
  });

  state.wins = state.wins.map((win) => {
    const key = getWinOverrideKey(win);
    const nextWin = stripOverrideFields(win, WIN_OVERRIDE_FIELDS);
    return {
      ...nextWin,
      ...(key ? overrides.wins[key] || {} : {}),
    };
  });

  state.giveaways = state.giveaways.map((giveaway) => {
    const key = getGiveawayOverrideKey(giveaway);
    const nextGiveaway = stripOverrideFields(giveaway, GIVEAWAY_OVERRIDE_FIELDS);
    return {
      ...nextGiveaway,
      ...(key ? overrides.giveaways[key] || {} : {}),
    };
  });

  // Manual membership override: forces a member active/inactive and survives every
  // future sync (re-applied here on top of the freshly synced isActiveMember).
  state.members = state.members.map((member) => {
    const key = getMemberOverrideKey(member);
    const nextMember = stripOverrideFields(member, MEMBER_OVERRIDE_FIELDS);
    const status = key ? String(overrides.members[key]?.membershipStatus || "").toLowerCase() : "";
    if (status === "inactive") {
      return { ...nextMember, isActiveMember: false };
    }
    if (status === "active") {
      return { ...nextMember, isActiveMember: true };
    }
    return nextMember;
  });

  reconcileManualWinnerWins(overrides);
}

function getMemberOverrideKey(member) {
  return getStableCycleMemberKey(member);
}

function getMemberMembershipStatus(member) {
  const key = getMemberOverrideKey(member);
  const status = key ? String(getEffectiveOverrideState().members[key]?.membershipStatus || "").toLowerCase() : "";
  if (status === "active" || status === "inactive") {
    return status;
  }
  return member?.isActiveMember ? "active" : "inactive";
}

// Manual winners are stored as a giveaway override but must also count in every
// statistic that reads state.wins. Here we turn each manual winner into a win
// record that is identical to a normal synced win (same sourceId shape, real
// resolved game, naturally-derived month) so every stat treats it the same,
// while keeping a `manualWinner` tag for the badge. It replaces whatever the
// sync recorded for that giveaway.
function reconcileManualWinnerWins(overrides) {
  // Drop any previously synthesized manual wins so this is fully idempotent.
  state.wins = state.wins.filter((win) => !win.manualWinner);

  const syncGiveaways = state.sync?.steamgifts?.giveaways || [];

  for (const [key, entry] of Object.entries(overrides.giveaways || {})) {
    const manualWinners = Array.isArray(entry?.manualWinners) ? entry.manualWinners : [];
    if (!manualWinners.length) {
      continue;
    }

    const giveaway = state.giveaways.find((item) => getGiveawayCodeKey(item) === key);
    if (!giveaway?.sourceId) {
      continue;
    }

    // A manual winner overrides whatever the sync recorded for this giveaway.
    state.wins = state.wins.filter((win) => String(win.giveawaySourceId || "") !== giveaway.sourceId);

    const code = giveaway.sourceId.replace(/^sg-/, "");
    const syncGiveaway = syncGiveaways.find((item) => String(item.code) === code) || null;
    const gameId = syncGiveaway
      ? upsertGameFromSync(syncGiveaway)
      : state.games.find((game) => game.title === giveaway.title)?.id || null;

    for (const winnerInfo of manualWinners) {
      const member = findMemberByUsername(winnerInfo.username);
      if (!member) {
        continue;
      }
      // Same shape as upsertWinFromSync, plus the manualWinner tag.
      state.wins.unshift({
        id: uid("win"),
        sourceId: `sg-win-${code}-${winnerInfo.username}`,
        giveawaySourceId: giveaway.sourceId,
        memberId: member.id,
        gameId,
        manualWinner: true,
        creatorUsername: giveaway.creatorUsername || "",
        giveawayUrl: String(giveaway.notes || "").trim(),
        winDate: giveaway.createdAt || state.settings.currentDate,
        ruleMode: "standard-25",
        currentHours: 0,
        earnedAchievements: 0,
        proofProvided: false,
        evidenceNotes: "Manual winner set in the dashboard.",
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function stripOverrideFields(item, fields) {
  const nextItem = { ...item };
  for (const field of fields) {
    delete nextItem[field];
  }
  return nextItem;
}

function getGameOverrideKey(game) {
  const appId = Number(game?.appId || 0);
  if (appId) {
    return `app:${appId}`;
  }
  const normalizedTitle = normalizeGameTitle(game?.title || "");
  if (normalizedTitle) {
    return `title:${normalizedTitle}`;
  }
  return String(game?.id || "");
}

function getWinOverrideKey(win) {
  return String(win?.sourceId || win?.id || "");
}

function getGiveawayOverrideKey(giveaway) {
  return String(giveaway?.sourceId || giveaway?.id || "");
}

// Stable key shared by both data models: cycle giveaways expose `sourceId`
// (`sg-<code>`) while summer-event sync records expose the raw `code`.
function getGiveawayCodeKey(giveaway) {
  const code = String(giveaway?.code || "").trim();
  if (code) {
    return `sg-${code}`;
  }
  const sourceId = String(giveaway?.sourceId || "").trim();
  if (sourceId) {
    return sourceId;
  }
  return String(giveaway?.id || "").trim();
}

function getGiveawayManualWinners(giveaway) {
  const key = getGiveawayCodeKey(giveaway);
  if (!key) {
    return [];
  }
  const overrides = getEffectiveOverrideState();
  const list = overrides.giveaways?.[key]?.manualWinners;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => ({
      username: String(entry?.username || "").trim(),
      displayName: String(entry?.displayName || "").trim(),
    }))
    .filter((entry) => entry.username);
}

function hasManualWinners(giveaway) {
  return getGiveawayManualWinners(giveaway).length > 0;
}

// A giveaway with no entries (neither tracked nor counted) can never have a
// winner, so the manual-winner control is hidden for it.
function giveawayHasAnyEntries(giveaway) {
  const counted = Number(giveaway?.entriesCount || 0);
  const tracked = Array.isArray(giveaway?.entryUsers) ? giveaway.entryUsers.length : 0;
  return counted > 0 || tracked > 0;
}

function canEditGiveawayWinner(giveaway) {
  // Allow clearing an existing manual winner even on a 0-entry giveaway.
  return giveawayHasAnyEntries(giveaway) || hasManualWinners(giveaway);
}

function findMemberByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (
    state.members.find((member) => {
      const sg = String(member?.steamgiftsUsername || "").trim().toLowerCase();
      const name = String(member?.name || "").trim().toLowerCase();
      return (sg && sg === normalized) || (name && name === normalized);
    }) || null
  );
}

function buildManualWinnerMarkup(winner) {
  const member = findMemberByUsername(winner.username);
  if (member) {
    return buildWinnerMarkup(member);
  }
  const label = winner.displayName || winner.username;
  const profileUrl = `https://www.steamgifts.com/user/${encodeURIComponent(winner.username)}`;
  return `<a class="linked-title" href="${escapeHtml(profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function getActiveMemberWinnerOptions() {
  return Array.from(getSummerEventMemberIndex().values())
    .filter((member) => member.isActiveMember)
    .map((member) => member.username)
    .sort((left, right) => left.localeCompare(right, "en-US", { sensitivity: "base" }));
}

function resolveActiveMemberWinner(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  for (const member of getSummerEventMemberIndex().values()) {
    if (member.isActiveMember && member.username.toLowerCase() === normalized) {
      return member;
    }
  }
  return null;
}

function openWinnerEditModal(key, currentWinners) {
  if (!key) {
    return;
  }
  openEditModal({
    title: "Set giveaway winner",
    description:
      "Pick one or more active members (comma-separated for multiple). Only active members can be set as a winner. A manual winner is locked and will not be overwritten by future syncs. Leave empty to clear and fall back to the synced winner.",
    label: "Winner (active members)",
    initialValue: currentWinners || "",
    inputType: "text",
    inputAttributes: { placeholder: "active member username" },
    datalistOptions: getActiveMemberWinnerOptions(),
    parse: (raw) => {
      const usernames = Array.from(
        new Set(
          String(raw || "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      );
      if (!usernames.length) {
        return { error: "Enter at least one active member, or use Clear to remove the manual winner." };
      }
      const winners = [];
      for (const username of usernames) {
        const member = resolveActiveMemberWinner(username);
        if (!member) {
          return { error: `"${username}" is not an active member. Pick a name from the active-member list.` };
        }
        winners.push({ username: member.username, displayName: member.displayName || "" });
      }
      return { value: winners };
    },
    onSave: (value) => {
      updateOverrideField("giveaways", key, "manualWinners", value && value.length ? value : null);
    },
  });
}

function getBaseGameHltbHours(game) {
  return Number(game?.hltbHours || 0);
}

function getGameHltbHours(game) {
  if (game?.hltbHoursOverride !== undefined && game?.hltbHoursOverride !== null && game.hltbHoursOverride !== "") {
    return Number(game.hltbHoursOverride || 0);
  }
  return getBaseGameHltbHours(game);
}

function getGameAchievementsTotal(game) {
  return Number(game?.achievementsTotal || 0);
}

function getBaseRequiredAchievementsTarget(win, game) {
  const totalAchievements = getGameAchievementsTotal(game);
  // Round 10% down (33 achievements -> 3, not 4), but still require at least 1.
  return totalAchievements > 0 ? Math.max(1, Math.floor(totalAchievements * 0.1)) : 0;
}

function hasGameAchievementTargetOverride(game) {
  return (
    game?.achievementTargetOverride !== undefined &&
    game?.achievementTargetOverride !== null &&
    game.achievementTargetOverride !== ""
  );
}

function hasWinAchievementTargetOverride(win) {
  return (
    win?.requiredAchievementsOverride !== undefined &&
    win?.requiredAchievementsOverride !== null &&
    win.requiredAchievementsOverride !== ""
  );
}

function getRequiredAchievementsTarget(win, game) {
  // A game-level override applies to every win/giveaway of that game; a legacy
  // per-win override is still honored as a fallback where no game override exists.
  if (hasGameAchievementTargetOverride(game)) {
    return Number(game.achievementTargetOverride || 0);
  }
  if (hasWinAchievementTargetOverride(win)) {
    return Number(win.requiredAchievementsOverride || 0);
  }
  return getBaseRequiredAchievementsTarget(win, game);
}

function getBaseEffectiveWinMonth(win) {
  // A win is always counted in the month the giveaway belongs to: the month
  // listed in its description (giveawayMonthOverride) when the creator backdated
  // it, otherwise the giveaway's creation/end date. The game's release date only
  // affects the play-by deadline, never which cycle month the win counts in.
  const giveaway = findGiveawayForWin(win);
  if (giveaway) {
    return getGiveawayMonth(giveaway);
  }
  return monthKey(win.winDate || "");
}

function getEffectiveWinMonth(win) {
  const overrideMonth = String(win?.monthOverride || "").trim();
  if (overrideMonth) {
    return overrideMonth;
  }
  return getBaseEffectiveWinMonth(win);
}

// Play-or-Pay month: the month a won game can actually be played in. It is the
// win's cycle month, but pushed forward to the game's release month when the
// game releases later (e.g. a May giveaway for a game that releases in June is
// tracked under June on the PoP page). Only games with a known later release
// date are affected; everything else stays in its cycle month. The cycle
// (lucky/unlucky) math keeps using getEffectiveWinMonth and is unaffected.
function getWinPlayMonth(win) {
  const baseMonth = getEffectiveWinMonth(win);
  const game = findById("games", win.gameId);
  const releaseMonth = getReleaseMonthKey(getWinReleaseDate(win, game));
  return releaseMonth && releaseMonth > baseMonth ? releaseMonth : baseMonth;
}

function getGiveawayMonth(giveaway) {
  // Admin-set cycle month wins over everything (used when a giveaway can't be
  // auto-placed, e.g. two same-game giveaways ending the same day).
  const manualMonth = normalizeGiveawayMonthOverrideValue(giveaway?.cycleMonthOverride);
  if (manualMonth) {
    return manualMonth;
  }
  const overrideMonth = normalizeGiveawayMonthOverrideValue(giveaway?.giveawayMonthOverride);
  if (overrideMonth && getGiveawayKind(giveaway) === "cycle") {
    return overrideMonth;
  }
  return monthKey(giveaway?.createdAt || "");
}

function getBaseGiveawayKind(giveaway) {
  const kind = String(giveaway?.giveawayKind || giveaway?.type || "").toLowerCase();
  const penaltyText = `${String(giveaway?.title || "")} ${String(giveaway?.notes || "")}`;
  if (kind === "summer_event" || kind === "summer-event") {
    return "summer_event";
  }
  if (kind === "extra" || /\bpenalty\b/i.test(penaltyText)) {
    return "extra";
  }
  if (/\bsummer event\b/i.test(penaltyText)) {
    return "summer_event";
  }
  return "cycle";
}

function getGiveawayKind(giveaway) {
  const rawOverrideKind = String(giveaway?.giveawayKindOverride || "").trim();
  if (rawOverrideKind) {
    return normalizeGiveawayKindValue(rawOverrideKind, giveaway);
  }
  return normalizeGiveawayKindValue(getBaseGiveawayKind(giveaway), giveaway);
}

function normalizeGiveawayKindValue(kind, giveaway = null) {
  const value = String(kind || "").trim().toLowerCase();
  if (value === "extra") {
    return "extra";
  }
  if (value === "penalty") {
    return "penalty";
  }
  if (value === "pop_free" || value === "pop-free" || value === "pop free") {
    return "pop_free";
  }
  if (value === "summer_event" || value === "summer-event" || value === "summer event") {
    return "summer_event";
  }
  if (giveaway && /\bsummer event\b/i.test(`${String(giveaway.title || "")} ${String(giveaway.notes || "")}`)) {
    return "summer_event";
  }
  return "cycle";
}

function getGiveawayKindLabel(kind) {
  switch (kind) {
    case "extra":
      return "Extra";
    case "penalty":
      return "Penalty";
    case "pop_free":
      return "PoP Free";
    case "summer_event":
      return "Summer event";
    default:
      return "Cycle";
  }
}

function getGiveawayKindBadgeLevel(kind) {
  switch (kind) {
    case "extra":
      return "info";
    case "penalty":
      return "danger";
    case "pop_free":
      return "info";
    case "summer_event":
      return "warning";
    default:
      return "success";
  }
}

function describeGiveawayKind(kind) {
  switch (kind) {
    case "extra":
      return "Excluded from cycle requirements and standard rule checks.";
    case "summer_event":
      return "Tracked for the summer event point system and excluded from cycle requirements.";
    default:
      return "Counts toward Rule 9 and cycle obligations.";
  }
}

function getCycleMemberOverrideKey(memberId, selectedMonth) {
  const cycleKey = getCycleKey(selectedMonth);
  const memberKey = getStableCycleMemberKey(memberId);
  if (!cycleKey || !memberKey) {
    return "";
  }
  return `${cycleKey}:${memberKey}`;
}

function getStableCycleMemberKey(memberId) {
  const member = typeof memberId === "string" ? findById("members", memberId) : memberId;
  const rawKey = String(member?.steamgiftsUsername || member?.name || member?.id || memberId || "").trim();
  return rawKey ? normalizeGameTitle(rawKey).replace(/\s+/g, "-") : "";
}

function getCycleMemberStatus(memberId, selectedMonth) {
  const key = getCycleMemberOverrideKey(memberId, selectedMonth);
  if (!key) {
    return "active";
  }
  return getEffectiveOverrideState().cycleMembers[key]?.status === "paused" ? "paused" : "active";
}

function getGiveawaysForMonth(monthValue) {
  return state.giveaways.filter((giveaway) => getGiveawayMonth(giveaway) === monthValue);
}

function findGiveawayForWin(win) {
  if (!win) {
    return null;
  }

  const sourceId = String(win.giveawaySourceId || "").trim();
  if (sourceId) {
    const bySourceId = state.giveaways.find((giveaway) => giveaway.sourceId === sourceId);
    if (bySourceId) {
      return bySourceId;
    }
  }

  const giveawayUrl = getGiveawayUrl(win);
  if (giveawayUrl) {
    const byUrl = state.giveaways.find((giveaway) => String(giveaway.notes || "").trim() === giveawayUrl);
    if (byUrl) {
      return byUrl;
    }
  }

  const sourceMatch = String(win.sourceId || "").match(/^sg-win-([^-]+)-/);
  if (sourceMatch) {
    return state.giveaways.find((giveaway) => giveaway.sourceId === `sg-${sourceMatch[1]}`) || null;
  }

  return null;
}

function findWinsForGiveaway(giveaway) {
  if (!giveaway) {
    return [];
  }

  const sourceId = String(giveaway.sourceId || "").trim();
  if (sourceId) {
    const winsBySourceId = state.wins.filter((win) => String(win.giveawaySourceId || "").trim() === sourceId);
    if (winsBySourceId.length) {
      return winsBySourceId;
    }
  }

  const giveawayUrl = String(giveaway.notes || "").trim();
  if (giveawayUrl) {
    const winsByUrl = state.wins.filter((win) => getGiveawayUrl(win) === giveawayUrl);
    if (winsByUrl.length) {
      return winsByUrl;
    }
  }

  return [];
}

function findSyncGiveawayRecord(giveaway) {
  if (!giveaway) {
    return null;
  }

  const syncGiveaways = state.sync?.steamgifts?.giveaways || [];
  const sourceId = String(giveaway.sourceId || "").trim();
  const sourceMatch = sourceId.match(/^sg-(.+)$/);
  if (sourceMatch) {
    const byCode = syncGiveaways.find((item) => item?.code === sourceMatch[1]);
    if (byCode) {
      return byCode;
    }
  }

  const giveawayUrl = String(giveaway.notes || "").trim();
  if (giveawayUrl) {
    const byUrl = syncGiveaways.find((item) => item?.url === giveawayUrl);
    if (byUrl) {
      return byUrl;
    }
  }

  return null;
}

function getGiveawayResultStatus(giveaway) {
  const localStatus = String(giveaway?.resultStatus || "").trim().toLowerCase();
  if (localStatus) {
    return localStatus;
  }

  return String(findSyncGiveawayRecord(giveaway)?.resultStatus || "").trim().toLowerCase();
}

function doesGiveawayCountForCycleMath(giveaway) {
  return getGiveawayResultStatus(giveaway) !== "no_winners";
}

function isCycleWin(win) {
  const giveaway = findGiveawayForWin(win);
  return giveaway ? getGiveawayKind(giveaway) === "cycle" : true;
}

function handleEditAction(button) {
  const action = button.dataset.editAction;

  if (action === "winner") {
    openWinnerEditModal(button.dataset.giveawayKey || "", button.dataset.currentWinners || "");
    return;
  }

  if (action === "summer-base-points") {
    const key = button.dataset.giveawayKey || "";
    if (!key) {
      return;
    }
    openEditModal({
      title: `Edit base points for ${button.dataset.giveawayTitle || "this giveaway"}`,
      description:
        "Manual base (creation) points for this summer-event giveaway. Entry points still come from tracked entrants. Leave empty to clear and fall back to the Steam price or point cost.",
      label: "Base points",
      initialValue: button.dataset.currentBase || "",
      inputType: "number",
      inputAttributes: { min: "0", step: "1" },
      parse: (raw) => parseNumericOverrideInput(raw, { integer: true }),
      onSave: (nextValue) => {
        updateOverrideField("giveaways", key, "summerBasePointsOverride", nextValue);
      },
    });
    return;
  }

  if (action === "giveaway-month") {
    const giveaway = findById("giveaways", button.dataset.giveawayId);
    if (!giveaway) {
      return;
    }
    openEditModal({
      title: `Edit cycle month for ${giveaway.title}`,
      description: "Use the YYYY-MM format. This sets which cycle month the giveaway (and any win on it) counts in. Leave empty to clear and fall back to the description/end date.",
      label: "Cycle month",
      initialValue: getGiveawayMonth(giveaway),
      inputType: "text",
      inputAttributes: { placeholder: "YYYY-MM" },
      parse: parseMonthOverrideInput,
      onSave: (nextValue) => {
        updateOverrideField("giveaways", getGiveawayOverrideKey(giveaway), "cycleMonthOverride", nextValue);
      },
    });
    return;
  }

  if (action === "hltb") {
    const game = findById("games", button.dataset.gameId);
    if (!game) {
      return;
    }
    openEditModal({
      title: `Edit HLTB for ${game.title}`,
      description: "Leave the field empty to clear the manual override and fall back to synced data.",
      label: "HLTB hours",
      initialValue: game.hltbHoursOverride ?? getGameHltbHours(game),
      inputType: "number",
      inputAttributes: { min: "0", step: "0.1" },
      parse: (raw) => parseNumericOverrideInput(raw, { integer: false }),
      onSave: (nextValue) => {
        const baseValue = getBaseGameHltbHours(game);
        updateOverrideField(
          "games",
          getGameOverrideKey(game),
          "hltbHoursOverride",
          nextValue === null || nextValue === baseValue ? null : nextValue,
        );
      },
    });
    return;
  }

  if (action === "achievement-target") {
    const win = findById("wins", button.dataset.winId);
    const game = win ? findById("games", win.gameId) : null;
    if (!win || !game) {
      return;
    }
    openEditModal({
      title: `Edit 10% target for ${game.title}`,
      description: "Applies to every giveaway of this game. Leave empty to clear the override and return to the synced 10% requirement.",
      label: "Required achievements",
      initialValue: game.achievementTargetOverride ?? getRequiredAchievementsTarget(win, game),
      inputType: "number",
      inputAttributes: { min: "0", step: "1" },
      parse: (raw) => parseNumericOverrideInput(raw, { integer: true }),
      onSave: (nextValue) => {
        const baseValue = getBaseRequiredAchievementsTarget(win, game);
        updateOverrideField(
          "games",
          getGameOverrideKey(game),
          "achievementTargetOverride",
          nextValue === null || nextValue === baseValue ? null : nextValue,
        );
      },
    });
    return;
  }

  if (action === "month") {
    const win = findById("wins", button.dataset.winId);
    if (!win) {
      return;
    }
    openEditModal({
      title: "Edit counted month",
      description: "Use the YYYY-MM format. Leave the field empty to clear the manual override.",
      label: "Count this win in month",
      initialValue: win.monthOverride || getEffectiveWinMonth(win),
      inputType: "text",
      inputAttributes: { placeholder: "YYYY-MM" },
      parse: parseMonthOverrideInput,
      onSave: (nextValue) => {
        const baseValue = getBaseEffectiveWinMonth(win);
        updateOverrideField(
          "wins",
          getWinOverrideKey(win),
          "monthOverride",
          nextValue === null || nextValue === baseValue ? null : nextValue,
        );
      },
    });
  }
}

function handleGiveawayKindChange(select) {
  const giveaway = findById("giveaways", select.dataset.giveawayId);
  if (!giveaway) {
    return;
  }
  const selectedKind = normalizeGiveawayKindValue(select.value, giveaway);
  const baseKind = getBaseGiveawayKind(giveaway);
  updateOverrideField(
    "giveaways",
    getGiveawayOverrideKey(giveaway),
    "giveawayKindOverride",
    selectedKind === baseKind ? null : selectedKind,
  );
}

function handleCycleMemberStatusChange(select) {
  const overrideKey = String(select.dataset.cycleMemberKey || "");
  if (!overrideKey) {
    return;
  }

  const selectedStatus = String(select.value || "active").toLowerCase() === "paused" ? "paused" : "active";
  updateOverrideField(
    "cycleMembers",
    overrideKey,
    "status",
    selectedStatus === "active" ? null : selectedStatus,
  );
}

function handleMemberStatusChange(select) {
  const overrideKey = String(select.dataset.memberKey || "");
  if (!overrideKey) {
    return;
  }
  // "active" clears the override (member follows the sync); "inactive" forces the
  // member out and keeps them out across future syncs.
  const inactive = String(select.value || "active").toLowerCase() === "inactive";
  updateOverrideField("members", overrideKey, "membershipStatus", inactive ? "inactive" : null);
}

function handleReactivateMember(button) {
  const overrideKey = String(button.dataset.reactivateMember || "");
  if (!overrideKey) {
    return;
  }
  // Force the member active (survives future syncs) so they reappear in the
  // directory even if the synced data still lists them as inactive.
  updateOverrideField("members", overrideKey, "membershipStatus", "active");
}

function ensureEditModal() {
  if (runtime.editModal) {
    return runtime.editModal;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="override-edit-modal" class="modal-backdrop" hidden>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="override-edit-title">
        <h2 id="override-edit-title"></h2>
        <p id="override-edit-copy" class="modal-copy"></p>
        <p id="override-edit-error" class="modal-error" hidden></p>
        <label class="modal-field">
          <span id="override-edit-label"></span>
          <input id="override-edit-input" list="" />
          <datalist id="override-edit-datalist"></datalist>
        </label>
        <div class="modal-actions">
          <button type="button" class="button secondary" data-modal-clear="true">Clear override</button>
          <button type="button" class="button secondary" data-modal-cancel="true">Cancel</button>
          <button type="button" class="button primary" data-modal-save="true">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.append(wrapper.firstElementChild);

  const root = document.querySelector("#override-edit-modal");
  const modal = {
    root,
    title: root.querySelector("#override-edit-title"),
    copy: root.querySelector("#override-edit-copy"),
    error: root.querySelector("#override-edit-error"),
    label: root.querySelector("#override-edit-label"),
    input: root.querySelector("#override-edit-input"),
    datalist: root.querySelector("#override-edit-datalist"),
    clearButton: root.querySelector("[data-modal-clear]"),
    cancelButton: root.querySelector("[data-modal-cancel]"),
    saveButton: root.querySelector("[data-modal-save]"),
  };

  modal.clearButton.addEventListener("click", () => saveEditModal(true));
  modal.cancelButton.addEventListener("click", closeEditModal);
  modal.saveButton.addEventListener("click", () => saveEditModal(false));
  modal.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveEditModal(false);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditModal();
    }
  });
  modal.root.addEventListener("click", (event) => {
    if (event.target === modal.root) {
      closeEditModal();
    }
  });

  runtime.editModal = modal;
  return modal;
}

function openEditModal(config) {
  const modal = ensureEditModal();
  runtime.editModalState = config;
  modal.title.textContent = config.title;
  modal.copy.textContent = config.description;
  modal.label.textContent = config.label;
  modal.error.hidden = true;
  modal.error.textContent = "";
  modal.input.type = config.inputType || "text";
  modal.input.value = config.initialValue === null || config.initialValue === undefined ? "" : String(config.initialValue);
  modal.input.placeholder = config.inputAttributes?.placeholder || "";
  if (Array.isArray(config.datalistOptions) && config.datalistOptions.length) {
    modal.datalist.innerHTML = config.datalistOptions
      .map((option) => `<option value="${escapeHtml(String(option))}"></option>`)
      .join("");
    modal.input.setAttribute("list", "override-edit-datalist");
  } else {
    modal.datalist.innerHTML = "";
    modal.input.removeAttribute("list");
  }
  if (config.inputAttributes) {
    for (const [attribute, value] of Object.entries(config.inputAttributes)) {
      if (value === null || value === undefined) {
        modal.input.removeAttribute(attribute);
      } else {
        modal.input.setAttribute(attribute, value);
      }
    }
  }
  modal.root.hidden = false;
  modal.input.focus();
  modal.input.select();
}

function closeEditModal() {
  const modal = ensureEditModal();
  runtime.editModalState = null;
  modal.root.hidden = true;
  modal.error.hidden = true;
  modal.error.textContent = "";
}

function saveEditModal(clearOverride) {
  const modal = ensureEditModal();
  const config = runtime.editModalState;
  if (!config) {
    return;
  }

  if (clearOverride) {
    config.onSave(null);
    closeEditModal();
    return;
  }

  const rawValue = modal.input.value.trim();
  if (!rawValue) {
    config.onSave(null);
    closeEditModal();
    return;
  }

  const parsed = config.parse(rawValue);
  if (parsed.error) {
    modal.error.hidden = false;
    modal.error.textContent = parsed.error;
    return;
  }

  config.onSave(parsed.value);
  closeEditModal();
}

function parseNumericOverrideInput(rawValue, options = {}) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || (options.integer && !Number.isInteger(value))) {
    return {
      error: options.integer ? "Enter a whole number or leave the field empty." : "Enter a valid number or leave the field empty.",
    };
  }
  return { value };
}

function parseMonthOverrideInput(rawValue) {
  if (!/^\d{4}-\d{2}$/.test(rawValue)) {
    return { error: "Use the YYYY-MM format or leave the field empty." };
  }
  const [year, month] = rawValue.split("-").map(Number);
  if (!year || month < 1 || month > 12) {
    return { error: "Use a valid month in the YYYY-MM format." };
  }
  return { value: rawValue };
}

function normalizeGiveawayMonthOverrideValue(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  const parsed = parseMonthOverrideInput(value);
  return parsed.error ? "" : parsed.value;
}

function updateOverrideField(bucketName, key, fieldName, value) {
  if (!key) {
    return;
  }

  // Base the new entry on the EFFECTIVE (shared + local) state so that editing
  // one field preserves sibling fields, and clearing a field actually removes
  // it even when the current value comes from a published (shared) override.
  const effective = getEffectiveOverrideState();
  const entry = { ...(effective[bucketName]?.[key] || {}) };
  if (value === null || value === undefined || value === "") {
    delete entry[fieldName];
  } else {
    entry[fieldName] = value;
  }

  const overrides = normalizeOverrideState(state.overrides);
  const sharedEntry = runtime.sharedOverrides?.[bucketName]?.[key];
  if (Object.keys(entry).length) {
    overrides[bucketName][key] = entry;
  } else if (sharedEntry && Object.keys(sharedEntry).length) {
    // Keep an empty local entry as a tombstone so the merge clears the shared
    // override instead of falling back to it.
    overrides[bucketName][key] = {};
  } else {
    delete overrides[bucketName][key];
  }

  state.overrides = overrides;
  applyManualOverrides();
  persistAndRender();
}

function clearStoredSyncState(options = {}) {
  const resetSettings = options.resetSettings === true;
  state = {
    ...cloneState(defaultState),
    settings: resetSettings
      ? cloneState(defaultState).settings
      : {
          ...cloneState(defaultState).settings,
          currentDate: state.settings.currentDate,
        },
  };
  if (options.persist === false) {
    render();
    return;
  }
  persistAndRender();
}

function isEmptySyncPayload(payload) {
  return !payload || (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0);
}

function findById(collection, id) {
  return state[collection].find((item) => item.id === id);
}

function buildOptions(items, placeholder, labelGetter) {
  return [
    `<option value="">${placeholder}</option>`,
    ...items.map(
      (item) =>
        `<option value="${item.id}">${escapeHtml(labelGetter(item))}</option>`,
    ),
  ].join("");
}

function buildBadge(level, label) {
  return `<span class="badge ${level}">${label}</span>`;
}

function getCycleMonthThreeLuckStatus(winsBeforeMonth) {
  if (winsBeforeMonth < 2) {
    return {
      badgeLabel: "UNLUCKY",
      badgeLevel: "info",
      note: "Unlucky month: regular cycle giveaway is waived.",
      historyNote: "Month 3 waiver applied: under 2 cycle wins before month 3.",
      alert: "unlucky member: exempt from the regular monthly mandatory giveaway in month 3.",
    };
  }
  if (winsBeforeMonth > 2) {
    return {
      badgeLabel: "LUCKY",
      badgeLevel: "warning",
      note: "Lucky month: two cycle giveaways are required.",
      historyNote: "Month 3 lucky-member rule applied: 2 cycle giveaways required in month 3.",
      alert: "lucky member: owes one extra giveaway in addition to the regular mandatory one.",
    };
  }
  return {
    badgeLabel: "",
    badgeLevel: "",
    note: "Balanced month: one cycle giveaway is required.",
    historyNote: "Month 3 balanced rule applied: 1 cycle giveaway required in month 3.",
    alert: "balanced member: regular mandatory giveaway only.",
  };
}

function buildEmptyRow(colspan) {
  return `<tr><td colspan="${colspan}">${elements.emptyStateTemplate.innerHTML}</td></tr>`;
}

function buildMessageRow(colspan, title, description) {
  return `<tr><td colspan="${colspan}"><div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div></td></tr>`;
}

function getAvailableMonths() {
  return Array.from(
    new Set([
      ...state.wins.map((win) => getEffectiveWinMonth(win)).filter(Boolean),
      ...state.wins.map((win) => getWinPlayMonth(win)).filter(Boolean),
      ...state.giveaways.map((giveaway) => getGiveawayMonth(giveaway)).filter(Boolean),
    ]),
  )
    .sort()
    .reverse();
}

function compareMemberBucketRows(left, right, sortMode) {
  switch (sortMode) {
    case "name":
      return String(left.name || "").localeCompare(String(right.name || ""), "pt-BR", {
        sensitivity: "base",
      });
    case "playtime":
      return right.totalPlaytime - left.totalPlaytime || right.totalWins - left.totalWins || compareMemberBucketRows(left, right, "name");
    case "achievements":
      return (
        (right.averageAchievements ?? -1) - (left.averageAchievements ?? -1) ||
        right.totalWins - left.totalWins ||
        compareMemberBucketRows(left, right, "name")
      );
    case "threshold":
      return (
        right.thresholdMet - left.thresholdMet ||
        right.totalWins - left.totalWins ||
        compareMemberBucketRows(left, right, "name")
      );
    case "wins":
    default:
      return right.totalWins - left.totalWins || right.totalPlaytime - left.totalPlaytime || compareMemberBucketRows(left, right, "name");
  }
}

function buildPlaytimeSourceLabel(progress) {
  if (!progress) {
    return "";
  }
  if (progress.playtimeSource === "steam-web-api") {
    return "Playtime source: Steam library snapshot";
  }
  if (progress.playtimeVisible === false) {
    return "Playtime hidden on Steam";
  }
  if (progress.gamesVisible === false) {
    return "Games list hidden on Steam";
  }
  return "";
}

