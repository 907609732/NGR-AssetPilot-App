import { dateRange, inPeriod, weekPeriod } from "../shared/report";
import type { Period } from "../shared/types";

/** TAPD groups are disjoint, in this precedence: week, month, year, other. */
export function groupMayIntersect(name: string, period: Period, today: string) {
  const canonical = name === "本年" ? "今年" : name;
  if (!["本周", "本月", "今年", "其他"].includes(canonical)) return true;
  const week = weekPeriod(today);
  return dateRange(period.start, period.end).some((date) => {
    if (date > today) return false;
    const bucket = inPeriod(date, week)
      ? "本周"
      : date.slice(0, 7) === today.slice(0, 7)
        ? "本月"
        : date.slice(0, 4) === today.slice(0, 4)
          ? "今年"
          : "其他";
    return bucket === canonical;
  });
}

export function hasDescendingDates(dates: string[]) {
  return dates.every((date, index) => index === 0 || dates[index - 1] >= date);
}
