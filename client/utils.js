export function parseSteamAppId(url) {
  const match = String(url || "").match(/\/(?:app|sub)\/(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function normalizeGameTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function monthKey(dateInput) {
  return String(dateInput).slice(0, 7);
}

export function todayISO() {
  return formatISODateLocal(new Date());
}

export function startOfCurrentMonth() {
  const date = new Date();
  date.setDate(1);
  return formatISODateLocal(date);
}

export function setDayOfCurrentMonth(day) {
  const date = new Date();
  date.setDate(day);
  return formatISODateLocal(date);
}

export function shiftDate(dateInput, days) {
  const date = parseDate(dateInput);
  date.setDate(date.getDate() + days);
  return formatISODateLocal(date);
}

export function addMonths(dateInput, months) {
  const date = parseDate(dateInput);
  date.setMonth(date.getMonth() + months);
  return formatISODateLocal(date);
}

export function differenceInDays(futureDate, baseDate) {
  const future = typeof futureDate === "string" ? parseDate(futureDate) : futureDate;
  const base = typeof baseDate === "string" ? parseDate(baseDate) : baseDate;
  const diff = future.getTime() - base.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function formatDate(dateInput) {
  return parseDate(dateInput).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(dateInput) {
  if (!dateInput) {
    return "-";
  }
  return new Date(dateInput).toLocaleString("en-US");
}

export function formatDurationSeconds(seconds) {
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

export function formatMonthKey(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function parseDate(dateInput) {
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

export function formatISODateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

export function formatHours(hours) {
  return `${Number(hours).toFixed(1)}h`;
}

export function getAchievementPercent(win, game) {
  if (!game?.achievementsTotal) {
    return win.proofProvided ? 100 : null;
  }
  return Math.round((Number(win.earnedAchievements || 0) / game.achievementsTotal) * 100);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}