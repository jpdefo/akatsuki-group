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
};

let state = loadState();
const loadedMediaAppIds = new Set();
const attemptedMediaAppIds = new Set();
const pendingMediaRequests = new Map();
const runtime = {
  staticApi: false,
};

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
  monthlyProgressTable: document.querySelector("#monthly-progress-table"),
  activeUsersTable: document.querySelector("#active-users-table"),
  inactiveUsersTable: document.querySelector("#inactive-users-table"),
  totalProgressTable: document.querySelector("#total-progress-table"),
  seedDemoButton: document.querySelector("#seed-demo"),
  exportButton: document.querySelector("#export-data"),
  importInput: document.querySelector("#import-data"),
  resetButton: document.querySelector("#reset-data"),
  syncRefreshButton: document.querySelector("#sync-refresh"),
  steamRefreshButton: document.querySelector("#steam-refresh"),
  steamRefreshAllButton: document.querySelector("#steam-refresh-all"),
  emptyStateTemplate: document.querySelector("#empty-state-template"),
};

bootstrap();

function bootstrap() {
  bindEvents();
  render();
  refreshRemoteSync({ silent: true })
    .then(() => loadStoredSteamProgress({ silent: true }))
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
  elements.importInput?.addEventListener("change", importData);
  elements.resetButton?.addEventListener("click", resetData);
  elements.syncRefreshButton?.addEventListener("click", () => refreshRemoteSync());
  elements.steamRefreshButton?.addEventListener("click", () => refreshSteamProgress());
  elements.steamRefreshAllButton?.addEventListener("click", () => refreshSteamProgress({ fullRefresh: true }));
  elements.monthlyFilter?.addEventListener("change", () => {
    renderProgressViews();
    void loadVisibleGameMedia({ silent: true });
  });

  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-type]");
    if (!deleteButton) {
      return;
    }

    const { deleteType, deleteId } = deleteButton.dataset;
    state[deleteType] = state[deleteType].filter((item) => item.id !== deleteId);
    persistAndRender();
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
        <p>Start the local server and run the collector from the group page to import members, giveaways, wins and Steam profile links automatically.</p>
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
  const monthlyWins = selectedMonth ? state.wins.filter((win) => monthKey(win.winDate) === selectedMonth) : [];

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
      ? `${formatMonthKey(selectedMonth)} • ${monthlyWins.length} tracked win(s)`
      : "Waiting for synced wins.";
  }

  renderMonthlyDetailsTable(elements.monthlyProgressTable, monthlyWins);
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
  const primaryProgress = giveaway.primaryProgress;
  const playtime = primaryProgress?.playtimeHours;
  const achievements = primaryProgress?.totalAchievements
    ? `${primaryProgress.earnedAchievements}/${primaryProgress.totalAchievements} achievements`
    : primaryProgress?.earnedAchievements
      ? `${primaryProgress.earnedAchievements} achievements`
      : "No synced achievement data";
  const playtimeSource = buildPlaytimeSourceLabel(primaryProgress);
  const compactPlaytime = playtime || playtime === 0 ? formatHours(playtime) : "Playtime unavailable";
  const compactAchievements =
    primaryProgress?.totalAchievements || primaryProgress?.earnedAchievements
      ? `${primaryProgress?.earnedAchievements || 0}/${primaryProgress?.totalAchievements || "?"} ach`
      : "No achievement data";
  const compactWinner = giveaway.winners?.length ? `Winner: ${escapeHtml(giveaway.winners.join(", "))}` : "No winner";

  return `
    <article class="giveaway-card">
      ${giveaway.steamAppUrl ? `<a href="${escapeHtml(giveaway.steamAppUrl)}" target="_blank" rel="noreferrer">${image}</a>` : image}
      <div class="giveaway-card-body">
        <h3 class="giveaway-title">
          ${giveaway.url ? `<a href="${escapeHtml(giveaway.url)}" target="_blank" rel="noreferrer">${title}</a>` : title}
        </h3>
        <span class="meta-line">Created by ${escapeHtml(giveaway.creatorUsername || "-")} • ${giveaway.endDate ? formatDate(giveaway.endDate) : "No end date"}</span>
        <span class="meta-line">${compactWinner} • ${giveaway.resultLabel ? escapeHtml(giveaway.resultLabel) : escapeHtml(giveaway.resultStatus || "Unknown status")}</span>
        ${primaryProgress?.playtimeCheckedAt ? `<span class="meta-line">Playtime snapshot: ${escapeHtml(formatDateTime(primaryProgress.playtimeCheckedAt))}</span>` : ""}
        ${playtimeSource ? `<span class="meta-line">${escapeHtml(playtimeSource)}</span>` : ""}
        <div class="giveaway-meta-line">
          <span>${Number(giveaway.entriesCount || 0).toLocaleString("pt-BR")} entries</span>
          <span>${giveaway.winnerCount || 0} winner(s)</span>
          <span>${compactPlaytime}</span>
          <span>${escapeHtml(compactAchievements)}</span>
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

function computeMemberBucketRows(isActiveMember) {
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
    .sort((left, right) => right.totalWins - left.totalWins || right.totalPlaytime - left.totalPlaytime);
}

function renderMonthlyDetailsTable(target, winsSubset) {
  if (!winsSubset.length) {
    target.innerHTML = buildEmptyRow(9);
    return;
  }

  target.innerHTML = winsSubset
    .map((win) => {
      const member = findById("members", win.memberId);
      const game = findById("games", win.gameId);
      const progress = evaluateMonthlyProgress(win);
      const hltbHours = Number(game?.hltbHours || 0);
      const totalAchievements = Number(game?.achievementsTotal || 0);

      return `
        <tr class="progress-row ${progress.badge}">
          <td>${buildGiveawayCreatorMarkup(win)}</td>
          <td>${buildGameCell(game)}</td>
          <td>${buildWinnerMarkup(member)}</td>
          <td>${hltbHours ? formatHours(hltbHours) : "-"}</td>
          <td>${progress.requiredHours ? formatHours(progress.requiredHours) : "-"}</td>
          <td>${formatHours(win.currentHours || 0)}</td>
          <td>${buildAchievementCell(win, totalAchievements)}</td>
          <td>${progress.requiredAchievements || 0}</td>
          <td>
            ${buildBadge(progress.badge, progress.label)}
            <span class="meta-line">${escapeHtml(progress.note)}</span>
            ${buildEvidenceNoteMarkup(win.evidenceNotes)}
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildGameCell(game) {
  const title = escapeHtml(game?.title || "Unknown game");
  const image = buildImageMarkup({
    className: "game-thumb",
    alt: title,
    appId: game?.appId,
    sources: [game?.capsuleSmallUrl, game?.headerImageUrl, game?.capsuleImageUrl],
    placeholder: "No art",
  });
  const titleMarkup = game?.steamAppUrl
    ? `<a class="linked-title" href="${escapeHtml(game.steamAppUrl)}" target="_blank" rel="noreferrer">${title}</a>`
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
  const hltbHours = Number(game.hltbHours || 0);
  const totalAchievements = Number(game.achievementsTotal || 0);
  const currentHours = Number(win.currentHours || 0);
  const currentAchievements = Number(win.earnedAchievements || 0);
  const requiredHours = hltbHours > 0 ? getRequiredHours(hltbHours, "standard-25") : 0;
  const requiredAchievements = totalAchievements > 0 ? Math.max(1, Math.ceil(totalAchievements * 0.1)) : 0;
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
    };
  });

  if (state.sync?.dashboard?.recentGiveaways?.length) {
    state.sync = {
      ...state.sync,
      dashboard: {
        ...state.sync.dashboard,
        recentGiveaways: state.sync.dashboard.recentGiveaways.map((giveaway) => {
          const media = mediaByAppId.get(Number(giveaway?.appId || 0));
          return media ? { ...giveaway, ...media } : giveaway;
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
  };
}

function getVisibleMediaAppIds() {
  const appIds = new Set();
  const months = getAvailableMonths();
  const selectedMonth =
    months.includes(elements.monthlyFilter?.value || "") ? elements.monthlyFilter.value : months[0] || "";
  const monthlyWins = selectedMonth ? state.wins.filter((win) => monthKey(win.winDate) === selectedMonth) : [];
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

  let cycleAlert = "";
  if (period.kind === "cycle" && period.monthPosition === 3) {
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
  const currentPeriod = getPeriodInfo(state.settings.currentDate);
  if (currentPeriod.kind !== "cycle") {
    return 0;
  }

  return state.wins.filter((win) => {
    if (win.memberId !== memberId) {
      return false;
    }
    const period = getPeriodInfo(win.winDate);
    return (
      period.kind === "cycle" &&
      period.cycleNumber === currentPeriod.cycleNumber &&
      period.year === currentPeriod.year
    );
  }).length;
}

function evaluateWin(win) {
  const member = findById("members", win.memberId) || { id: "", name: "Membro removido" };
  const game =
    findById("games", win.gameId) || {
      id: "",
      title: "Jogo removido",
      hltbHours: 0,
      achievementsTotal: 0,
    };

  const deadline = addMonths(win.winDate, 4);
  const now = parseDate(state.settings.currentDate);
  const daysLeft = differenceInDays(deadline, now);

  const requiredHours = getRequiredHours(game.hltbHours, win.ruleMode);
  const requiredAchievements =
    win.ruleMode === "standard-25" && game.achievementsTotal > 0
      ? Math.max(1, Math.ceil(game.achievementsTotal * 0.1))
      : 0;

  const hoursOk = win.ruleMode === "true-100" ? true : win.currentHours >= requiredHours;
  const achievementsOk =
    requiredAchievements > 0
      ? win.earnedAchievements >= requiredAchievements
      : game.achievementsTotal === 0
        ? win.proofProvided
        : true;
  const proofOk =
    win.ruleMode === "standard-25"
      ? game.achievementsTotal > 0
        ? achievementsOk
        : win.proofProvided
      : win.proofProvided;

  const canEvaluateHours = win.ruleMode === "true-100" || requiredHours > 0;
  const canEvaluateAchievements = game.achievementsTotal > 0 || win.proofProvided;
  const hasEnoughSignals = canEvaluateHours || canEvaluateAchievements;

  if (!hasEnoughSignals) {
    return {
      member,
      game,
      deadline,
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
    state: stateLabel,
    statusLabel,
    statusBadge,
    penaltyOwed: !compliant && daysLeft < 0,
    penaltyText: !compliant && daysLeft < 0 ? "1 extra giveaway owed" : "None",
    targetLabel: describeTarget(win.ruleMode, requiredHours, requiredAchievements),
    progressLabel: describeProgress(win, game, requiredHours, requiredAchievements, compliant),
  };
}

function evaluateGiveaway(giveaway) {
  const issues = [];
  const threshold = computeMinimumEntriesRequired();
  const appliesStandardRules = giveaway.type !== "extra" && giveaway.type !== "sync";

  if (appliesStandardRules && giveaway.valuePoints < state.settings.minimumValuePoints) {
    issues.push(`below ${state.settings.minimumValuePoints}P`);
  }
  if (appliesStandardRules && parseDate(giveaway.createdAt).getDate() > 15) {
    issues.push("created after the 15th");
  }
  if (giveaway.regionLocked) {
    issues.push("region locked");
  }
  if (giveaway.bundled && giveaway.type !== "extra") {
    issues.push("invalid bundled game");
  }
  if (appliesStandardRules && giveaway.entriesCount < threshold) {
    issues.push("did not reach the threshold");
  }

  return {
    issues,
    label: issues.length ? "Review" : "Valid",
    level: issues.length ? "warning" : "success",
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

function getRequiredHours(hltbHours, ruleMode) {
  switch (ruleMode) {
    case "custom-50":
      return hltbHours * 0.5;
    case "custom-75":
      return hltbHours * 0.75;
    case "custom-100":
      return hltbHours;
    case "standard-25":
    default:
      return hltbHours * 0.25;
  }
}

function getPeriodInfo(dateInput) {
  const date = parseDate(dateInput);
  const month = date.getMonth();
  const year = date.getFullYear();

  if (month <= 2) {
    return {
      kind: "cycle",
      label: `Cycle 1 (${year})`,
      cycleNumber: 1,
      monthPosition: month + 1,
      year,
    };
  }

  if (month >= 3 && month <= 5) {
    return {
      kind: "cycle",
      label: `Cycle 2 (${year})`,
      cycleNumber: 2,
      monthPosition: month - 2,
      year,
    };
  }

  if (month === 6) {
    return { kind: "special", label: `Summer event (${year})`, year };
  }

  if (month === 7) {
    return { kind: "special", label: `Pause (${year})`, year };
  }

  if (month >= 8 && month <= 10) {
    return {
      kind: "cycle",
      label: `Cycle 3 (${year})`,
      cycleNumber: 3,
      monthPosition: month - 7,
      year,
    };
  }

  return { kind: "special", label: `Secret Santa (${year})`, year };
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
      return cloneState(defaultState);
    }
    return {
      ...cloneState(defaultState),
      ...JSON.parse(raw),
    };
  } catch (error) {
    return cloneState(defaultState);
  }
}

function persistAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildPersistedState()));
  render();
}

function buildPersistedState() {
  const hasServerSync = state.sync?.steamgifts?.source === "akatsuki-steamgifts-sync";
  if (!hasServerSync) {
    return state;
  }

  return {
    ...cloneState(defaultState),
    settings: { ...state.settings },
    sync: {
      steamgifts: null,
      steamProgressUpdatedAt: state.sync?.steamProgressUpdatedAt || null,
    },
  };
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

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function monthKey(dateInput) {
  return String(dateInput).slice(0, 7);
}

function getAvailableMonths() {
  return Array.from(new Set(state.wins.map((win) => monthKey(win.winDate)))).sort().reverse();
}

function todayISO() {
  return formatISODateLocal(new Date());
}

function startOfCurrentMonth() {
  const date = new Date();
  date.setDate(1);
  return formatISODateLocal(date);
}

function setDayOfCurrentMonth(day) {
  const date = new Date();
  date.setDate(day);
  return formatISODateLocal(date);
}

function shiftDate(dateInput, days) {
  const date = parseDate(dateInput);
  date.setDate(date.getDate() + days);
  return formatISODateLocal(date);
}

function addMonths(dateInput, months) {
  const date = parseDate(dateInput);
  date.setMonth(date.getMonth() + months);
  return formatISODateLocal(date);
}

function differenceInDays(futureDate, baseDate) {
  const future = typeof futureDate === "string" ? parseDate(futureDate) : futureDate;
  const base = typeof baseDate === "string" ? parseDate(baseDate) : baseDate;
  const diff = future.getTime() - base.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatDate(dateInput) {
  return parseDate(dateInput).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(dateInput) {
  if (!dateInput) {
    return "-";
  }
  return new Date(dateInput).toLocaleString("pt-BR");
}

function formatDurationSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1) {
    return `${value.toFixed(2)}s`;
  }
  if (value < 10) {
    return `${value.toFixed(1)}s`;
  }
  return `${Math.round(value)}s`;
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
    bits.push(`${Number(stats.totalPlaytimeRows || 0).toLocaleString("pt-BR")} cached app rows`);
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

function formatMonthKey(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
}

function parseDate(dateInput) {
  if (dateInput instanceof Date) {
    return new Date(dateInput.getFullYear(), dateInput.getMonth(), dateInput.getDate(), 12);
  }

  const raw = String(dateInput);
  if (raw.includes("T")) {
    const parsed = new Date(raw);
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12);
  }

  const [year, month, day] = raw.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatISODateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatHours(hours) {
  return `${Number(hours).toFixed(1)}h`;
}

function getAchievementPercent(win, game) {
  if (!game?.achievementsTotal) {
    return win.proofProvided ? 100 : null;
  }
  return Math.round((Number(win.earnedAchievements || 0) / game.achievementsTotal) * 100);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
