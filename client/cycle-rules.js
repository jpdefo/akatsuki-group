import { formatISODateLocal, formatMonthKey, parseDate } from "./utils.js";

export function getRequiredHours(hltbHours, ruleMode) {
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

export function getPeriodInfo(dateInput) {
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

export function getCycleMonthKeys(period) {
  if (!period || period.kind !== "cycle") {
    return [];
  }

  if (period.cycleNumber === 1) {
    return [1, 2, 3].map((month) => `${period.year}-${String(month).padStart(2, "0")}`);
  }
  if (period.cycleNumber === 2) {
    return [4, 5, 6].map((month) => `${period.year}-${String(month).padStart(2, "0")}`);
  }
  return [9, 10, 11].map((month) => `${period.year}-${String(month).padStart(2, "0")}`);
}

export function getNextCycleExemptionInfo(cycleMonths) {
  const lastMonth = cycleMonths[cycleMonths.length - 1];
  if (!lastMonth) {
    return {
      key: "",
      label: "the next month",
      hasMandatoryGiveaway: false,
    };
  }

  const [year, month] = lastMonth.split("-").map(Number);
  const nextMonth = formatISODateLocal(new Date(year, month, 1, 12)).slice(0, 7);
  const nextPeriod = getPeriodInfo(`${nextMonth}-01`);
  return {
    key: nextMonth,
    label: nextPeriod.kind === "cycle" ? formatMonthKey(nextMonth) : nextPeriod.label,
    hasMandatoryGiveaway: nextPeriod.kind === "cycle",
  };
}

export function getCycleKey(selectedMonth) {
  if (typeof selectedMonth === "string" && /^\d{4}-cycle-[1-3]$/.test(selectedMonth)) {
    return selectedMonth;
  }
  const period = typeof selectedMonth === "string" ? getPeriodInfo(`${selectedMonth}-01`) : selectedMonth;
  if (!period || period.kind !== "cycle") {
    return "";
  }
  return `${period.year}-cycle-${period.cycleNumber}`;
}