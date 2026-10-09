/**
 * Off-Peak Indicator Extension
 *
 * Shows two footer items with provider billing states.
 *
 * DeepSeek: peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday,
 * excluding Chinese public holidays. In Beijing time (UTC+8, no DST) that is
 * 09:00-12:00 and 14:00-18:00 on weekdays. All other hours are off-peak,
 * including weekends and holidays in full.
 *
 * Ollama: peak hours are 12:00-18:00 UTC on weekdays. All other hours are
 * off-peak, including weekends in full. Ollama has no holiday calendar, so its
 * state is purely time-based and never "unknown".
 *
 * DeepSeek holiday data comes from NateScarlet/holiday-cn
 * (https://github.com/NateScarlet/holiday-cn), fetched once per process launch
 * and cached in <agentDir>/deepseek-offpeak.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY_DEEPSEEK = "deepseek";
const STATUS_KEY_OLLAMA = "ollama";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** Peak windows as half-open [start, end) minute-of-day ranges, Beijing time. */
const PEAK_WINDOWS: ReadonlyArray<readonly [start: number, end: number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];
/** Moments where the DeepSeek state can flip: window edges plus Beijing midnight. */
const BOUNDARY_MINUTES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60];
/** Peak window as half-open [start, end) minute-of-day ranges, UTC. */
const OLLAMA_PEAK_WINDOWS: ReadonlyArray<readonly [start: number, end: number]> = [[12 * 60, 18 * 60]];
/** Moments where the Ollama state can flip: window edges plus UTC midnight. */
const OLLAMA_BOUNDARY_MINUTES = [0, 12 * 60, 18 * 60];
const FETCH_TIMEOUT_MS = 5000;
const STATE_PATH = join(getAgentDir(), "deepseek-offpeak.json");
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const holidayUrl = (year: number): string =>
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;

export type PeakState = "offpeak" | "peak" | "unknown";

/** "YYYY-MM-DD" of the Beijing-calendar day for an instant. */
export function chinaDayKey(date: Date): string {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** Weekday (0=Sun..6=Sat) and minute-of-day in a UTC-offset-shifted calendar. */
function shiftedParts(date: Date, offsetMs: number): { dayOfWeek: number; minuteOfDay: number } {
  const shifted = new Date(date.getTime() + offsetMs);
  return {
    dayOfWeek: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function inPeakWindow(
  minuteOfDay: number,
  windows: ReadonlyArray<readonly [start: number, end: number]>,
): boolean {
  return windows.some(([start, end]) => minuteOfDay >= start && minuteOfDay < end);
}

/**
 * Billing state for an instant. Weekends are off-peak unconditionally, so they
 * never depend on holiday data. A weekday inside a peak window can only be
 * called "peak" when the holiday calendar for that year is known; otherwise it
 * is "unknown" rather than a false pricing claim.
 */
export function peakState(
  date: Date,
  holidays: ReadonlySet<string>,
  knownYears: ReadonlySet<number>,
): PeakState {
  const { dayOfWeek, minuteOfDay } = shiftedParts(date, BEIJING_OFFSET_MS);
  if (dayOfWeek === 0 || dayOfWeek === 6) return "offpeak";
  const key = chinaDayKey(date);
  if (holidays.has(key)) return "offpeak";
  if (!inPeakWindow(minuteOfDay, PEAK_WINDOWS)) return "offpeak";
  return knownYears.has(Number(key.slice(0, 4))) ? "peak" : "unknown";
}

/**
 * Ollama billing state for an instant: peak on weekdays inside 12:00-18:00
 * UTC, off-peak otherwise. No external data, so never "unknown".
 */
export function ollamaPeakState(date: Date): PeakState {
  const { dayOfWeek, minuteOfDay } = shiftedParts(date, 0);
  if (dayOfWeek === 0 || dayOfWeek === 6) return "offpeak";
  return inPeakWindow(minuteOfDay, OLLAMA_PEAK_WINDOWS) ? "peak" : "offpeak";
}

/** Next instant strictly after `from` where the state can flip. */
export function nextBoundary(
  from: Date,
  boundaries: ReadonlyArray<number>,
  offsetMs: number,
): Date {
  const shifted = new Date(from.getTime() + offsetMs);
  const minuteOfDay =
    shifted.getUTCHours() * 60 +
    shifted.getUTCMinutes() +
    shifted.getUTCSeconds() / 60 +
    shifted.getUTCMilliseconds() / 60_000;
  const dayStartUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  for (const minute of boundaries) {
    if (minute > minuteOfDay) return new Date(dayStartUtcMs + minute * 60_000 - offsetMs);
  }
  return new Date(dayStartUtcMs + 24 * 60 * 60_000 - offsetMs);
}

export type HolidayParseResult = { ok: true; days: string[] } | { ok: false };

/**
 * Extracts holiday dates (isOffDay: true) from one holiday-cn year file. Any
 * malformed entry fails the whole year, so bad data can never enter the cache.
 */
export function parseHolidayDays(data: unknown): HolidayParseResult {
  if (typeof data !== "object" || data === null) return { ok: false };
  const days = (data as { days?: unknown }).days;
  if (!Array.isArray(days)) return { ok: false };
  const out: string[] = [];
  for (const day of days) {
    if (typeof day !== "object" || day === null) return { ok: false };
    const { date, isOffDay } = day as { date?: unknown; isOffDay?: unknown };
    if (typeof date !== "string" || !DAY_PATTERN.test(date) || typeof isOffDay !== "boolean") {
      return { ok: false };
    }
    if (isOffDay) out.push(date);
  }
  return { ok: true, days: out };
}

/**
 * Reads the state file shape `{ years: { "<year>": ["YYYY-MM-DD", ...] } }`.
 * A year is trusted only when every entry is a valid date string; bad years
 * are skipped, never turned into an empty list.
 */
export function parseCache(data: unknown): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (typeof data !== "object" || data === null) return out;
  const years = (data as { years?: unknown }).years;
  if (typeof years !== "object" || years === null) return out;
  for (const [year, days] of Object.entries(years as Record<string, unknown>)) {
    if (!/^\d{4}$/.test(year) || !Array.isArray(days)) continue;
    const valid = days.every((day): day is string => typeof day === "string" && DAY_PATTERN.test(day));
    if (!valid) continue;
    out.set(Number(year), days);
  }
  return out;
}

/**
 * Footer text for one provider's billing state. Off-peak is the good state, so
 * it gets the highlight color; peak is shown dim with a blocked icon.
 */
export function renderStatus(state: PeakState, label: string, theme: { fg: (color: string, text: string) => string }): string {
  switch (state) {
    case "offpeak":
      return theme.fg("success", `${label} 🚗 off-peak`);
    case "peak":
      return theme.fg("dim", `${label} 🚫 peak`);
    case "unknown":
      return theme.fg("dim", `${label} 🚫 peak?`);
  }
}

type StatusTheme = { fg: (color: string, text: string) => string };

export default function deepseekOffpeak(pi: ExtensionAPI) {
  // Per-factory state: a fresh instance owns it after every /reload or session
  // replacement, so the generation counter below is scoped to this closure.
  let yearHolidays = new Map<number, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let abort: AbortController | undefined;

  const holidaySet = (): ReadonlySet<string> => {
    const all = new Set<string>();
    for (const days of yearHolidays.values()) {
      for (const day of days) all.add(day);
    }
    return all;
  };

  const loadCache = (): void => {
    try {
      yearHolidays = parseCache(JSON.parse(readFileSync(STATE_PATH, "utf8")));
    } catch {
      yearHolidays = new Map();
    }
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      const now = new Date();
      const theme = ctx.ui.theme as StatusTheme;
      const deepseek = peakState(now, holidaySet(), new Set(yearHolidays.keys()));
      ctx.ui.setStatus(STATUS_KEY_DEEPSEEK, renderStatus(deepseek, "DeepSeek", theme));
      ctx.ui.setStatus(STATUS_KEY_OLLAMA, renderStatus(ollamaPeakState(now), "Ollama", theme));
    } catch {
      /* a TUI glitch must not break the session */
    }
  };

  const writeStateFile = (): void => {
    try {
      const years: Record<string, string[]> = {};
      for (const year of [...yearHolidays.keys()].sort((a, b) => a - b)) {
        years[String(year)] = yearHolidays.get(year) ?? [];
      }
      writeFileSync(STATE_PATH, `${JSON.stringify({ years }, null, 2)}\n`);
    } catch {
      /* cache write failure is harmless; the fetch succeeds next launch */
    }
  };

  /**
   * Fetches the current and next Beijing-calendar year. A failed year keeps
   * its cached data. `gen` invalidates the run when the session is replaced.
   */
  const refreshHolidays = async (gen: number): Promise<void> => {
    abort = new AbortController();
    const nowYear = Number(chinaDayKey(new Date()).slice(0, 4));
    let changed = false;
    for (const year of [nowYear, nowYear + 1]) {
      if (gen !== generation) return;
      const controller = new AbortController();
      const onSessionAbort = () => controller.abort();
      abort.signal.addEventListener("abort", onSessionAbort, { once: true });
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(holidayUrl(year), { signal: controller.signal });
        if (!res.ok) continue;
        const parsed = parseHolidayDays(await res.json());
        if (!parsed.ok) continue;
        const previous = yearHolidays.get(year);
        if (previous !== undefined && previous.length === parsed.days.length && previous.every((day, i) => day === parsed.days[i])) {
          continue;
        }
        yearHolidays.set(year, parsed.days);
        changed = true;
      } catch {
        /* silent: the cache (or the unknown state) covers fetch failures */
      } finally {
        clearTimeout(timeoutId);
        abort.signal.removeEventListener("abort", onSessionAbort);
      }
    }
    if (gen !== generation) return;
    if (changed) writeStateFile();
  };

  const scheduleNext = (ctx: ExtensionContext, gen: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    const now = Date.now();
    // Slack lands the refresh just past the boundary, not on it.
    const nextDeepseek = nextBoundary(new Date(now), BOUNDARY_MINUTES, BEIJING_OFFSET_MS).getTime();
    const nextOllama = nextBoundary(new Date(now), OLLAMA_BOUNDARY_MINUTES, 0).getTime();
    const delay = Math.max(0, Math.min(nextDeepseek, nextOllama) - now) + 250;
    timer = setTimeout(() => {
      timer = undefined;
      if (gen !== generation) return;
      publish(ctx);
      scheduleNext(ctx, gen);
    }, delay);
  };

  pi.on("session_start", (event, ctx) => {
    const gen = ++generation;
    loadCache();
    publish(ctx);
    scheduleNext(ctx, gen);
    // Fetch once per process launch; later session starts hydrate from cache.
    if (event.reason === "startup") {
      void refreshHolidays(gen)
        .then(() => {
          if (gen === generation) publish(ctx);
        })
        .catch(() => {
          /* never reject out of a fire-and-forget chain */
        });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    abort?.abort();
    abort = undefined;
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus(STATUS_KEY_DEEPSEEK, undefined);
        ctx.ui.setStatus(STATUS_KEY_OLLAMA, undefined);
      } catch {
        /* swallow */
      }
    }
  });
}
