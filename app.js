import {
  addMonths,
  cloneState,
  differenceInDays,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatDurationSeconds,
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
  getRequiredHours,
} from "./client/cycle-rules.js";

const STORAGE_KEY = "akatsuki-monitor-state-v1";

const defaultState = {
  settings: {
    groupName: "Akatsuki",
    activeMembers: 30,
    minimumValuePoints: 15,
    currentDate: todayISO(),
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
  },
};

let state = loadState();
const loadedMediaAppIds = new Set();
const attemptedMediaAppIds = new Set();
const pendingMediaRequests = new Map();
const runtime = {
  staticApi: false,
  editModal: null,
  editModalState: null,
  sharedOverrides: normalizeOverrideState(),
};
const GAME_OVERRIDE_FIELDS = ["hltbHoursOverride"];
const WIN_OVERRIDE_FIELDS = ["requiredAchievementsOverride", "monthOverride"];
const GIVEAWAY_OVERRIDE_FIELDS = ["giveawayKindOverride"];

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
  monthlySort: document.querySelector("#monthly-sort"),
  monthlyProgressTable: document.querySelector("#monthly-progress-table"),
  cycleFilter: document.querySelector("#cycle-filter"),
  cycleSummary: document.querySelector("#cycle-summary"),
  cycleBestGifterWarning: document.querySelector("#cycle-best-gifter-warning"),
  cycleTable: document.querySelector("#cycle-table"),
  cycleGiveawaysTable: document.querySelector("#cycle-giveaways-table"),
  cycleWinsTable: document.querySelector("#cycle-wins-table"),
  activeUsersTable: document.querySelector("#active-users-table"),
  activeUsersSort: document.querySelector("#active-users-sort"),
  inactiveUsersTable: document.querySelector("#inactive-users-table"),
  totalProgressTable: document.querySelector("#total-progress-table"),
  seedDemoButton: document.querySelector("#seed-demo"),
  exportButton: document.querySelector("#export-data"),
  publishOverridesButton: document.querySelector("#publish-overrides"),
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
  render();
  refreshRemoteSync({ silent: true })
    .then(() => loadStoredSteamProgress({ silent: true }))
    .then(() => loadSharedOverrides({ silent: true }))
    .then(() => loadDashboardData({ silent: true }))
    .then(() => loadVisibleGameMedia({ silent: true }));
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
  elements.activeUsersSort?.addEventListener("change", () => renderMemberBuckets());

  document.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-action]");
    if (editButton) {
      handleEditAction(editButton);
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
  renderSettings();
  renderSyncStatus();
  renderServerViews();
  renderProgressViews();
  renderCycleHistoryPage();
  renderMemberBuckets();
}

function renderSettings() {
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
  const cards = [
    ["Group", state.settings.groupName],
    ["Active members", dashboardSummary?.activeMembers ?? state.settings.activeMembers],
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
  const progressStats = dashboardSummary?.progressStats || state.sync?.lastProgressStats || {};
  const libraryStats = dashboardSummary?.libraryStats || state.sync?.lastLibraryStats || {};

  if (!sync) {
    elements.syncStatus.innerHTML = `
      <article class="alert-card info">
        <h3>No SteamGifts sync loaded</h3>
        <p>Open the Admin tools page to import a SteamGifts JSON file, or start the local server and run the collector/bookmarklet from the group page.</p>
      </article>
    `;
    return;
  }

  const memberCount = sync.members?.length || 0;
  const giveawayCount = sync.giveaways?.length || 0;
  const winCount = sync.wins?.length || 0;

  if (elements.syncRefreshButton) {
    elements.syncRefreshButton.hidden = runtime.staticApi;
  }
  if (elements.steamRefreshButton) {
    elements.steamRefreshButton.hidden = runtime.staticApi;
  }
  if (elements.steamRefreshAllButton) {
    elements.steamRefreshAllButton.hidden = runtime.staticApi;
  }

  elements.syncStatus.innerHTML = `
      <article class="alert-card success">
      <h3>SteamGifts synced</h3>
      <p>
        Last sync: <strong>${formatDateTime(sync.syncedAt)}</strong><br />
        ${escapeHtml(sync.group?.name || "Group")} • ${memberCount} member(s) • ${giveawayCount} giveaway(s) • ${winCount} win(s)
        ${runtime.staticApi ? `<br /><span class="meta-line">GitHub Pages snapshot mode: data changes only after a new publish.</span>` : ""}
      </p>
    </article>
    <article class="alert-card info">
      <h3>Steam progress</h3>
      <p>${
        progressUpdatedAt
          ? `Last refresh: <strong>${formatDateTime(progressUpdatedAt)}</strong>${buildProgressStatsMarkup(progressStats)}`
          : "Steam progress has not been refreshed yet."
      }</p>
    </article>
    <article class="alert-card ${librarySummary?.libraryApiEnabled ? "success" : "warning"}">
      <h3>Playtime library snapshot</h3>
      <p>${
        librarySummary?.libraryUpdatedAt
          ? `Last library sync: <strong>${formatDateTime(librarySummary.libraryUpdatedAt)}</strong><br />${librarySummary.libraryProfiles || 0} tracked profile(s) cached for total playtime, with ${librarySummary.libraryFreshProfiles || 0} still fresh for incremental month refreshes (${librarySummary.librarySnapshotTtlHours || 48}h cache window).${buildLibraryStatsMarkup(libraryStats)}`
          : librarySummary?.libraryApiEnabled
            ? "Library playtime is enabled, but no snapshot has been stored yet."
            : "Configure STEAM_WEB_API_KEY to source total playtime from Steam per-user library snapshots."
      }</p>
    </article>
  `;
}

function renderServerViews() {
  renderMemberOverview();
  renderRecentGiveaways();
}

function renderMemberOverview() {
  if (!elements.memberOverview) {
    return;
  }

  const activeMembers = state.sync?.dashboard?.members?.active || [];
  if (!activeMembers.length) {
    elements.memberOverview.innerHTML = buildEmptyPanel(
      "No tracked members yet.",
      "Run the SteamGifts sync to populate the server-backed member directory.",
    );
    return;
  }

  elements.memberOverview.innerHTML = activeMembers.slice(0, 12).map(buildMemberCard).join("");
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
  const currentSelection = elements.monthlyFilter.value;
  const selectedMonth = months.includes(currentSelection) ? currentSelection : months[0] || "";
  const monthlyWins = selectedMonth ? state.wins.filter((win) => getEffectiveWinMonth(win) === selectedMonth) : [];
  const monthlyGiveaways = selectedMonth ? getGiveawaysForMonth(selectedMonth) : [];
  const period = selectedMonth ? getPeriodInfo(`${selectedMonth}-01`) : null;

  elements.monthlyFilter.innerHTML = months.length
    ? months
        .map(
          (month) =>
            `<option value="${month}" ${month === selectedMonth ? "selected" : ""}>${formatMonthKey(month)}</option>`,
        )
        .join("")
    : `<option value="">No wins</option>`;

  if (elements.periodSummary) {
    elements.periodSummary.textContent = selectedMonth
      ? `${formatMonthKey(selectedMonth)} • ${monthlyWins.length} tracked win(s) • ${monthlyGiveaways.length} giveaway(s) • ${period.kind === "cycle" ? `${period.label}, month ${period.monthPosition} of 3` : period.label}`
      : "Waiting for synced wins.";
  }

  renderMonthlyDetailsTable(elements.monthlyProgressTable, monthlyWins);
  renderCycleViews(selectedMonth);
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
    const cycleRows = state.members
      .filter((member) => member?.isActiveMember !== false)
      .map((member) => {
        const memberCycleStatus = getCycleMemberStatus(member, selectedMonth);
        const paused = memberCycleStatus === "paused";
        const winsBeforeMonth = computeCycleWinsForMemberInMonth(member.id, selectedMonth, { beforeSelectedMonth: true });
        const cycleWinsToDate = computeCycleWinsForMemberInMonth(member.id, selectedMonth);
        const cycleGiveawaysThisMonth = countMemberGiveawaysForMonth(member.id, selectedMonth, "cycle");
        const extraGiveawaysThisMonth = countMemberGiveawaysForMonth(member.id, selectedMonth, "extra");
        const requiredGiveaways = paused ? 0 : getRequiredCycleGiveawaysForMember(member.id, selectedMonth);
        const status = buildCycleStatus({
          period,
          winsBeforeMonth,
          cycleWinsToDate,
          cycleGiveawaysThisMonth,
          requiredGiveaways,
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
                ${buildBadge(status.level, status.label)}
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
                  </select>
                </label>
                <span class="meta-line">${kind === "extra" ? "Excluded from cycle requirements and standard rule checks." : "Counts toward cycle requirements for this month."}</span>
              </td>
              <td>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")}</td>
              <td>${buildBadge(kind === "extra" ? "info" : "success", kind === "extra" ? "Extra" : "Cycle")}</td>
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
    .filter((giveaway) => cycleMonths.includes(getGiveawayMonth(giveaway)))
    .sort((left, right) => parseDate(right.createdAt) - parseDate(left.createdAt));
  const cycleOnlyWins = cycleWins.filter((win) => getWinTrackKind(win) === "cycle");
  const cycleGiveawayCount = cycleGiveaways.filter((giveaway) => getGiveawayKind(giveaway) === "cycle").length;
  const extraGiveawayCount = cycleGiveaways.filter((giveaway) => getGiveawayKind(giveaway) === "extra").length;
  const bestGifterAward = buildCycleBestGifterAward(selectedCycle, cycleMonths, cycleGiveaways);

  elements.cycleSummary.textContent = `${selectedCycle.label} • ${cycleMonths.map(formatMonthKey).join(" • ")} • ${cycleOnlyWins.length} cycle win(s) • ${cycleGiveawayCount} cycle giveaway(s) • ${extraGiveawayCount} extra giveaway(s)`;
  renderCycleBestGifterWarning(bestGifterAward, selectedCycle, cycleMonths);

  renderCycleHistoryMembersTable(selectedCycle, cycleMonths, cycleWins, cycleGiveaways);
  renderCycleHistoryResultsTable(cycleGiveaways);
}

function renderCycleBestGifterWarning(bestGifterAward, selectedCycle, cycleMonths) {
  if (!elements.cycleBestGifterWarning) {
    return;
  }

  if (!bestGifterAward.eligibleCount) {
    elements.cycleBestGifterWarning.innerHTML = `
      <article class="alert-card info compact-alert">
        <h3>Best gifter not decided yet</h3>
        <p>Rule 9 needs at least 2 cycle giveaways from a member before someone can take the exemption lead in ${escapeHtml(selectedCycle.label)}.</p>
      </article>
    `;
    return;
  }

  const nextMonthInfo = getNextCycleExemptionInfo(selectedCycle.months);
  if (bestGifterAward.tieMembers.length > 1) {
    elements.cycleBestGifterWarning.innerHTML = `
      <article class="alert-card warning compact-alert">
        <h3>Best gifter tie</h3>
        <p>${escapeHtml(bestGifterAward.tieMembers.join(", "))} are tied on average entries in ${escapeHtml(selectedCycle.label)}. Highest single giveaway entries are also tied, so this still needs an admin tie-break.</p>
      </article>
    `;
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
  elements.cycleBestGifterWarning.innerHTML = `
    <article class="alert-card warning compact-alert">
      <h3>${escapeHtml(gifterLabel)}</h3>
      <p>
        <strong>${escapeHtml(bestGifterAward.winnerName)}</strong> averages ${bestGifterAward.averageEntries.toFixed(1)} entries across ${bestGifterAward.giveawayCount} cycle giveaway(s), with a best single result of ${bestGifterAward.bestSingleEntries.toLocaleString("en-US")} entries.<br />
        ${escapeHtml(exemptionText)}
      </p>
    </article>
  `;
}

function renderCycleHistoryMembersTable(selectedCycle, cycleMonths, cycleWins, cycleGiveaways) {
  const participantIds = new Set([
    ...cycleWins.map((win) => win.memberId).filter(Boolean),
    ...cycleGiveaways.map((giveaway) => giveaway.creatorId).filter(Boolean),
  ]);

  const rows = state.members
    .filter((member) => participantIds.has(member.id) || getCycleMemberStatus(member, selectedCycle.key) === "paused")
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
        (giveaway) => giveaway.creatorId === member.id && getGiveawayKind(giveaway) === "cycle",
      ).length;
      const extraGiveawaysTotal = cycleGiveaways.filter(
        (giveaway) => giveaway.creatorId === member.id && getGiveawayKind(giveaway) === "extra",
      ).length;
      const cycleEntries = cycleGiveaways
        .filter((giveaway) => giveaway.creatorId === member.id && getGiveawayKind(giveaway) === "cycle")
        .map((giveaway) => Number(giveaway.entriesCount || 0));
      const averageEntries = cycleEntries.length
        ? cycleEntries.reduce((sum, value) => sum + value, 0) / cycleEntries.length
        : null;
      const bestEntries = cycleEntries.length ? Math.max(...cycleEntries) : 0;
      const requiredGiveaways = paused ? 0 : getRequiredCycleGiveawaysForCycle(member.id, cycleMonths);
      const status = buildCycleHistoryStatus({
        cycleMonths,
        winsBeforeMonthThree,
        cycleWinsTotal,
        cycleGiveawaysTotal,
        requiredGiveaways,
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
              ${buildBadge(status.level, status.label)}
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

function renderCycleHistoryResultsTable(cycleGiveaways) {
  elements.cycleGiveawaysTable.innerHTML = cycleGiveaways.length
    ? cycleGiveaways
        .map((giveaway) => {
          const creator = findById("members", giveaway.creatorId);
          const giveawayWins = findWinsForGiveaway(giveaway);
          const winnerMarkup = giveawayWins.length
            ? giveawayWins.map((win) => buildWinnerMarkup(findById("members", win.memberId))).join(", ")
            : "-";
          const giveawayUrl = String(giveaway.notes || "").trim();
          const kind = getGiveawayKind(giveaway);
          const giveawayMonth = getGiveawayMonth(giveaway);
          return `
            <tr>
              <td>${giveawayMonth ? formatMonthKey(giveawayMonth) : "-"}</td>
              <td>${escapeHtml(creator?.name || "Unknown member")}</td>
              <td>
                <strong>${giveawayUrl ? `<a class="linked-title" href="${escapeHtml(giveawayUrl)}" target="_blank" rel="noreferrer">${escapeHtml(giveaway.title)}</a>` : escapeHtml(giveaway.title)}</strong>
                <span class="meta-line">${formatDate(giveaway.createdAt)}</span>
              </td>
              <td>${winnerMarkup}</td>
              <td>${Number(giveaway.entriesCount || 0).toLocaleString("en-US")}</td>
              <td>
                <label class="inline-select-wrap compact-select-wrap">
                  <select class="inline-select" data-giveaway-kind-select="true" data-giveaway-id="${giveaway.id}">
                    <option value="cycle" ${kind === "cycle" ? "selected" : ""}>Cycle</option>
                    <option value="extra" ${kind === "extra" ? "selected" : ""}>Extra</option>
                  </select>
                </label>
                <span class="meta-line compact-meta-line">${kind === "extra" ? "Excluded from cycle requirements." : "Counts toward Rule 9 and cycle obligations."}</span>
              </td>
            </tr>
          `;
        })
        .join("")
    : buildMessageRow(6, "No giveaways in this cycle.", "Giveaways from the selected cycle will appear here.");
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
    target.innerHTML = buildEmptyRow(5);
    return;
  }

  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${row.totalWins}</td>
          <td>${formatHours(row.totalPlaytime)}</td>
          <td>${row.averageAchievements === null ? "-" : `${row.averageAchievements}%`}</td>
          <td>${row.thresholdMet}/${row.totalWins}</td>
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

  return `
    <article class="member-card">
      ${buildBadge(member.isActiveMember ? "success" : "info", member.isActiveMember ? "Active" : "Inactive")}
      <h3>${usernameMarkup}</h3>
      <span class="meta-line">${member.winsCount || 0} tracked win(s)</span>
      <strong>${member.lastWinDate ? formatDate(member.lastWinDate) : "No wins yet"}</strong>
      <span class="meta-line">${member.profileUrl ? `<a class="linked-title" href="${escapeHtml(member.profileUrl)}" target="_blank" rel="noreferrer">Open SteamGifts profile</a>` : "SteamGifts profile unavailable"}</span>
    </article>
  `;
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
      return {
        name: member.name,
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

function renderMonthlyDetailsTable(target, winsSubset) {
  if (!winsSubset.length) {
    target.innerHTML = buildEmptyRow(9);
    return;
  }

  const sortMode = elements.monthlySort?.value || "winner";
  const sortedWins = [...winsSubset].sort((left, right) => compareMonthlyWins(left, right, sortMode));

  target.innerHTML = sortedWins
    .map((win) => {
      const member = findById("members", win.memberId);
      const game = findById("games", win.gameId);
      const progress = evaluateMonthlyProgress(win);
      const prereleaseNote = buildPrereleaseMonthNote(win, game);
      const hltbHours = getGameHltbHours(game);
      const totalAchievements = getGameAchievementsTotal(game);
      const effectiveMonth = getEffectiveWinMonth(win);

      return `
        <tr class="progress-row ${progress.badge}">
          <td>${buildGiveawayCreatorMarkup(win)}</td>
          <td>${buildGameCell(game, win)}</td>
          <td>${buildWinnerMarkup(member)}</td>
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
              ${win?.requiredAchievementsOverride !== undefined && win?.requiredAchievementsOverride !== null ? `<span class="meta-line override-note">Manual override</span>` : ""}
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

  if (sortMode === "hours") {
    const hoursCompare = Number(right.currentHours || 0) - Number(left.currentHours || 0);
    if (hoursCompare !== 0) {
      return hoursCompare;
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
  return [path, `./${normalized}.json`];
}

async function fetchApiJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  let lastError = null;

  for (const candidate of getApiCandidates(path, method)) {
    try {
      const response = await fetch(candidate, options);
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
    const { payload } = await fetchApiJson("./api/steamgifts-sync");
    if (payload?.source === "akatsuki-steamgifts-sync") {
      importSteamGiftsSync(payload, { persist: true });
    } else if (isEmptySyncPayload(payload)) {
      clearStoredSyncState({ persist: true });
    } else if (!options.silent) {
      window.alert("The server responded, but there is no SteamGifts sync stored yet.");
    }
    await loadDashboardData({ silent: true });
  } catch (error) {
    if (!options.silent) {
      window.alert("Could not load automatic sync. Start the local server with python server.py.");
    }
  }
}

async function loadDashboardData(options = {}) {
  try {
    const { payload } = await fetchApiJson("./api/dashboard");
    state.sync = {
      ...state.sync,
      dashboard: payload,
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
    const { payload } = await fetchApiJson("./api/overrides");
    runtime.sharedOverrides = normalizeSharedOverridePayload(payload);
    applyManualOverrides();
    render();
  } catch (error) {
    runtime.sharedOverrides = normalizeOverrideState();
    if (!options.silent) {
      window.alert("Could not load published overrides.");
    }
  }
}

async function publishSharedOverrides() {
  const button = elements.publishOverridesButton;
  const originalLabel = button?.textContent;

  try {
    if (runtime.staticApi) {
      throw new Error("GitHub Pages is read-only. Save shared overrides through the local server, then run publish-snapshot.cmd.");
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
    window.alert("Overrides saved to data/overrides.json. Run publish-snapshot.cmd to publish them to GitHub Pages.");
  } catch (error) {
    window.alert(error?.message || "Could not save published overrides.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || "Save current overrides for publish";
    }
  }
}

async function refreshSteamProgress(options = {}) {
  const fullRefresh = options.fullRefresh === true;
  const month = fullRefresh ? null : elements.monthlyFilter?.value || getAvailableMonths()[0] || null;
  const primaryButton = fullRefresh ? elements.steamRefreshAllButton : elements.steamRefreshButton;
  const secondaryButton = fullRefresh ? elements.steamRefreshButton : elements.steamRefreshAllButton;
  const primaryLabel = primaryButton?.textContent;
  const secondaryLabel = secondaryButton?.textContent;

  try {
    if (runtime.staticApi) {
      throw new Error("GitHub Pages is read-only. Refresh cached data through GitHub Actions or the local server.");
    }
    if (primaryButton) {
      primaryButton.disabled = true;
      primaryButton.textContent = fullRefresh ? "Refreshing all..." : "Refreshing month...";
    }
    if (secondaryButton) {
      secondaryButton.disabled = true;
    }
    const response = await fetch("./api/refresh-steam-progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ month, fullRefresh }),
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
    if (primaryButton) {
      primaryButton.disabled = false;
      primaryButton.textContent =
        primaryLabel || (fullRefresh ? "Full active refresh" : "Refresh selected month");
    }
    if (secondaryButton) {
      secondaryButton.disabled = false;
      secondaryButton.textContent =
        secondaryLabel || (fullRefresh ? "Refresh selected month" : "Full active refresh");
    }
  }
}

async function loadStoredSteamProgress(options = {}) {
  try {
    const { payload } = await fetchApiJson("./api/steam-progress");
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
  const monthlyWins = selectedMonth ? state.wins.filter((win) => getEffectiveWinMonth(win) === selectedMonth) : [];
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
  const giveaways = (payload.giveaways || []).map(normalizeGiveawayMedia);
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

  return {
    ...payload,
    members,
    giveaways,
    wins:
      payload.wins ||
      giveaways.flatMap((giveaway) =>
        (giveaway.winners || []).map((winner) => ({
          giveawayCode: giveaway.code,
          title: giveaway.title,
          appId: giveaway.appId || null,
          winnerUsername: winner.username,
          creatorUsername: giveaway.creatorUsername,
          entriesCount: giveaway.entriesCount || 0,
          winDate: giveaway.endDate || payload.syncedAt,
        })),
      ),
    memberSteamProfiles,
    memberActivity,
  };
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
  const payload = {
    id: existing?.id || uid("giveaway"),
    sourceId,
    creatorId,
    title: giveawayRecord.title,
    type: "sync",
    createdAt: giveawayRecord.endDate || state.settings.currentDate,
    valuePoints: Number(giveawayRecord.points || 0),
    entriesCount: Number(giveawayRecord.entriesCount || 0),
    regionLocked: Boolean(giveawayRecord.regionRestricted),
    bundled: false,
    notes: giveawayRecord.url || "",
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
  const cycleWins = computeCycleWinsForMember(memberId);
  const penalties = state.wins
    .map(evaluateWin)
    .filter((evaluation) => evaluation.member.id === memberId && evaluation.penaltyOwed).length;
  const period = getPeriodInfo(state.settings.currentDate);
  const paused = period.kind === "cycle" && getCycleMemberStatus(memberId, monthKey(state.settings.currentDate)) === "paused";

  let cycleAlert = "";
  if (paused) {
    cycleAlert = "paused for this cycle: excluded from joins and mandatory giveaways.";
  } else if (period.kind === "cycle" && period.monthPosition === 3) {
    if (cycleWins < 2) {
      cycleAlert = "unlucky member: exempt from the regular monthly mandatory giveaway in month 3.";
    } else if (cycleWins > 2) {
      cycleAlert = "lucky member: owes one extra giveaway in addition to the regular mandatory one.";
    } else {
      cycleAlert = "balanced member: regular mandatory giveaway only.";
    }
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
  const cycleOnlyGiveaways = cycleGiveaways.filter((giveaway) => getGiveawayKind(giveaway) === "cycle");
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
    return getGiveawayKind(giveaway) === kind;
  }).length;
}

function getRequiredCycleGiveawaysForMember(memberId, selectedMonth) {
  const period = getPeriodInfo(`${selectedMonth}-01`);
  if (period.kind !== "cycle") {
    return 0;
  }

  if (period.monthPosition < 3) {
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

function getRequiredCycleGiveawaysForCycle(memberId, cycleMonths) {
  return cycleMonths.reduce((total, month) => total + getRequiredCycleGiveawaysForMember(memberId, month), 0);
}

function buildCycleStatus({ period, winsBeforeMonth, cycleWinsToDate, cycleGiveawaysThisMonth, requiredGiveaways, paused }) {
  if (paused) {
    return {
      level: "info",
      label: "Paused",
      note: "Paused in this cycle. The member is excluded from joining and from giveaway obligations.",
    };
  }

  let note = "Regular month: one cycle giveaway is required.";
  if (period.monthPosition === 3) {
    if (winsBeforeMonth < 2) {
      note = "Unlucky month: regular cycle giveaway is waived.";
    } else if (winsBeforeMonth > 2) {
      note = "Lucky month: two cycle giveaways are required.";
    } else {
      note = "Balanced month: one cycle giveaway is required.";
    }
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
    note = `${note} Above the 8-win cycle cap by ${cycleWinsToDate - 8}.`;
  }

  return { level, label, note };
}

function buildCycleHistoryStatus({ cycleMonths, winsBeforeMonthThree, cycleWinsTotal, cycleGiveawaysTotal, requiredGiveaways, paused }) {
  if (paused) {
    return {
      level: "info",
      label: "Paused",
      note: "Paused in this cycle. The member is excluded from joins and mandatory giveaways.",
    };
  }

  const lastMonth = cycleMonths[cycleMonths.length - 1] || "";
  const lastPeriod = lastMonth ? getPeriodInfo(`${lastMonth}-01`) : null;
  let note = lastMonth ? `Compact cycle totals through ${formatMonthKey(lastMonth)}.` : "Compact cycle totals.";

  if (lastPeriod?.kind === "cycle" && lastPeriod.monthPosition === 3) {
    if (winsBeforeMonthThree < 2) {
      note = "Month 3 waiver applied: under 2 cycle wins before month 3.";
    } else if (winsBeforeMonthThree > 2) {
      note = "Month 3 lucky-member rule applied: 2 cycle giveaways required in month 3.";
    } else {
      note = "Month 3 balanced rule applied: 1 cycle giveaway required in month 3.";
    }
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
    note = `${note} Above the 8-win cycle cap by ${cycleWinsTotal - 8}.`;
  }

  return { level, label, note };
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
  return totalAchievements > 0 ? Math.max(1, Math.ceil(totalAchievements * 0.1)) : 0;
}

function getRequiredAchievementsTarget(win, game) {
  if (
    win?.requiredAchievementsOverride !== undefined &&
    win?.requiredAchievementsOverride !== null &&
    win.requiredAchievementsOverride !== ""
  ) {
    return Number(win.requiredAchievementsOverride || 0);
  }
  return getBaseRequiredAchievementsTarget(win, game);
}

function getBaseEffectiveWinMonth(win) {
  const game = findById("games", win.gameId);
  return getEffectiveMonthKey(win.winDate, getWinReleaseDate(win, game));
}

function getEffectiveWinMonth(win) {
  const overrideMonth = String(win?.monthOverride || "").trim();
  if (overrideMonth) {
    return overrideMonth;
  }
  return getBaseEffectiveWinMonth(win);
}

function getGiveawayMonth(giveaway) {
  return monthKey(giveaway?.createdAt || "");
}

function getBaseGiveawayKind(giveaway) {
  const kind = String(giveaway?.giveawayKind || giveaway?.type || "").toLowerCase();
  return kind === "extra" ? "extra" : "cycle";
}

function getGiveawayKind(giveaway) {
  const overrideKind = String(giveaway?.giveawayKindOverride || "").toLowerCase();
  if (overrideKind === "cycle" || overrideKind === "extra") {
    return overrideKind;
  }
  return getBaseGiveawayKind(giveaway);
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

function isCycleWin(win) {
  const giveaway = findGiveawayForWin(win);
  return giveaway ? getGiveawayKind(giveaway) !== "extra" : true;
}

function handleEditAction(button) {
  const action = button.dataset.editAction;

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
      description: "Leave the field empty to clear the manual override and return to the synced 10% requirement.",
      label: "Required achievements",
      initialValue: win.requiredAchievementsOverride ?? getRequiredAchievementsTarget(win, game),
      inputType: "number",
      inputAttributes: { min: "0", step: "1" },
      parse: (raw) => parseNumericOverrideInput(raw, { integer: true }),
      onSave: (nextValue) => {
        const baseValue = getBaseRequiredAchievementsTarget(win, game);
        updateOverrideField(
          "wins",
          getWinOverrideKey(win),
          "requiredAchievementsOverride",
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
  const selectedKind = String(select.value || "cycle").toLowerCase() === "extra" ? "extra" : "cycle";
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
          <input id="override-edit-input" />
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

function updateOverrideField(bucketName, key, fieldName, value) {
  if (!key) {
    return;
  }

  const overrides = normalizeOverrideState(state.overrides);
  const entry = { ...(overrides[bucketName][key] || {}) };
  if (value === null || value === undefined || value === "") {
    delete entry[fieldName];
  } else {
    entry[fieldName] = value;
  }

  if (Object.keys(entry).length) {
    overrides[bucketName][key] = entry;
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

function buildProgressStatsMarkup(stats = {}) {
  if (!stats || !stats.uniqueProgressTargets) {
    return "";
  }

  const bits = [];
  if (stats.durationSeconds || stats.durationSeconds === 0) {
    bits.push(`Completed in <strong>${formatDurationSeconds(stats.durationSeconds)}</strong>`);
  }
  bits.push(
    `${stats.uniqueProgressTargets || 0} game profile(s) checked across ${stats.targetWins || 0} tracked win(s)`,
  );
  if (stats.libraryPlaytimeHits || stats.libraryPlaytimeHits === 0) {
    bits.push(`${stats.libraryPlaytimeHits || 0} used cached library playtime`);
  }
  if (stats.achievementErrors) {
    bits.push(`${stats.achievementErrors} achievement request error(s)`);
  }
  return `<br />${bits.join(" • ")}`;
}

function buildLibraryStatsMarkup(stats = {}) {
  if (!stats || !stats.targetProfiles) {
    return "";
  }

  const bits = [];
  if (stats.durationSeconds || stats.durationSeconds === 0) {
    bits.push(`Last run: <strong>${formatDurationSeconds(stats.durationSeconds)}</strong>`);
  }
  bits.push(`${stats.targetProfiles || 0} targeted profile(s)`);
  bits.push(`${stats.reusedProfiles || 0} reused`);
  bits.push(`${stats.refreshedProfiles || 0} fetched from Steam`);
  if (stats.errorProfiles) {
    bits.push(`${stats.errorProfiles} error(s)`);
  }
  if (stats.totalPlaytimeRows || stats.totalPlaytimeRows === 0) {
    bits.push(`${Number(stats.totalPlaytimeRows || 0).toLocaleString("en-US")} cached app rows`);
  }
  return `<br />${bits.join(" • ")}`;
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

