import type { AutomationSchedule } from "../client-huaanwork/rpc-types.ts";

/**
 * 调度数学纯函数模块（Phase 1）：
 * - {@link nextFireAfter}：八种 schedule kind 的下一次触发时刻（本地墙钟语义，与旧 daily 分支一致）；
 * - {@link parseCron}：5 字段 cron 解析（仅 `*`、`N`、`*／N`、`N-M`、`N,M`；全角斜杠仅文案，实际用半角），抛中文错误即非法；
 * - {@link humanizeCron}：cron 的中文展示文案（dom/dow 并集如实描述为「或」）；
 * - {@link periodOf}：触发周期推导（coalescedCount 用）。
 *
 * 明确不做：时区 picker（一律系统本地时区）、抖动、7 天自动过期（见 spec 2026-09-02）。
 */

/** cron 五字段的展开结果；`dom`/`dow` 保留 `"*"` 哨兵以区分 Vixie 并集语义。 */
export type CronFields = {
  minute: number[];
  hour: number[];
  dom: number[] | "*";
  month: number[];
  dow: number[] | "*";
};

const DAY_MS = 24 * 3600_000;
/** 搜索上限：4 年 + 1 天。`0 0 29 2 *` 这类闰年 cron 最远约 4 年后触发，366 天上限会误报「永不触发」。 */
const MAX_SEARCH_DAYS = 1462;

const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 字段范围（dow 允许 0-7，展开时把 7 归一化为 0）。 */
const FIELD_LIMITS = {
  minute: { min: 0, max: 59, label: "分钟" },
  hour: { min: 0, max: 23, label: "小时" },
  dom: { min: 1, max: 31, label: "日期" },
  month: { min: 1, max: 12, label: "月份" },
  dow: { min: 0, max: 7, label: "星期" },
} as const;

/**
 * 解析 5 字段 cron 表达式（minute hour dom month dow）。
 * 仅支持 `*`、`N`、`*／N`（步进，全角斜杠仅文案）、`N-M`、`N,M,...`；`L`/`W`/`?`/名称别名/秒字段直接抛中文错误。
 */
export function parseCron(expr: string): CronFields {
  const text = expr.trim();
  if (!text) throw new Error("cron 表达式不能为空");
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周），当前为 ${fields.length} 个`);
  }
  return {
    minute: parseList(fields[0]!, FIELD_LIMITS.minute, false) as number[],
    hour: parseList(fields[1]!, FIELD_LIMITS.hour, false) as number[],
    dom: parseList(fields[2]!, FIELD_LIMITS.dom, true),
    month: parseList(fields[3]!, FIELD_LIMITS.month, false) as number[],
    dow: parseList(fields[4]!, FIELD_LIMITS.dow, true),
  };
}

function parseList(raw: string, limit: { min: number; max: number; label: string }, keepStar: boolean): number[] | "*" {
  if (raw === "*") return keepStar ? "*" : expandRange(limit.min, limit.max, 1);
  if (/[^0-9*,/-]/.test(raw)) {
    throw new Error(`cron 的${limit.label}字段包含不支持的字符（仅支持 *、N、*/N、N-M、N,M）：${raw}`);
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`cron 的${limit.label}字段存在空的列表项：${raw}`);
    let partValues: number[];
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step < 1) throw new Error(`cron 的${limit.label}字段步进必须不小于 1：${raw}`);
      partValues = expandRange(limit.min, limit.max, step);
    } else if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (lo > hi) throw new Error(`cron 的${limit.label}字段范围起点大于终点：${raw}`);
      partValues = expandRange(lo, hi, 1);
    } else if (/^\d+$/.test(part)) {
      partValues = [Number(part)];
    } else {
      throw new Error(`cron 的${limit.label}字段仅支持 *、N、*/N、N-M、N,M（不支持步进区间 N-M/S）：${raw}`);
    }
    for (const value of partValues) {
      if (value < limit.min || value > limit.max) {
        throw new Error(`cron 的${limit.label}字段超出合法范围（${limit.min}-${limit.max}）：${raw}`);
      }
      // dow 的 7 归一化为 0（周日）。
      values.add(limit.label === "星期" && value === 7 ? 0 : value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function expandRange(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let value = lo; value <= hi; value += step) out.push(value);
  return out;
}

/** dom/dow 组合规则（Vixie 语义）：任一 `*` 只看另一个；两者都非 `*` 取并集。 */
function cronDayMatches(fields: CronFields, year: number, monthIdx: number, day: number): boolean {
  const domOk = fields.dom === "*" || fields.dom.includes(day);
  const dowOk = fields.dow === "*" || fields.dow.includes(new Date(year, monthIdx, day).getDay());
  if (fields.dom === "*" || fields.dow === "*") return domOk && dowOk;
  return domOk || dowOk;
}

/** 计算某时间点之后的下一次触发时刻；manual 与已过期/已触发的 once 返回 undefined。本地墙钟语义。 */
export function nextFireAfter(schedule: AutomationSchedule, from: number): number | undefined {
  switch (schedule.kind) {
    case "manual":
      return undefined;
    case "once":
      // 契约：at <= from 必须返回 undefined，否则 markAutomation 会把过去值写回 nextRunAt，
      // once 跑完下一 tick 即落 missed 分支（「刚跑完就记 missed」回归）。
      return schedule.at > from ? schedule.at : undefined;
    case "interval":
      return from + schedule.minutes * 60_000;
    case "hourly": {
      const next = new Date(from);
      next.setMinutes(schedule.minute, 0, 0);
      while (next.getTime() <= from) next.setHours(next.getHours() + 1);
      return next.getTime();
    }
    case "daily": {
      const [hour, minute] = splitTime(schedule.time);
      const next = new Date(from);
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= from) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    case "weekly": {
      const [hour, minute] = splitTime(schedule.time);
      const wanted = new Set(schedule.days.map((day) => (day === 7 ? 0 : day)));
      const next = new Date(from);
      next.setHours(hour, minute, 0, 0);
      // 最多扫 8 天必覆盖一周；days 为空（上游校验应已拦截）时安全返回 undefined。
      for (let i = 0; i < 8; i += 1) {
        if (wanted.has(next.getDay()) && next.getTime() > from) return next.getTime();
        next.setDate(next.getDate() + 1);
      }
      return undefined;
    }
    case "monthly": {
      const [hour, minute] = splitTime(schedule.time);
      const dates = new Set(schedule.dates);
      const next = new Date(from);
      next.setHours(hour, minute, 0, 0);
      // 当月无此日自然跳过：逐日前进即可。无合法日期时靠上限兜底返回 undefined。
      for (let i = 0; i < 400; i += 1) {
        if (dates.has(next.getDate()) && next.getTime() > from) return next.getTime();
        next.setDate(next.getDate() + 1);
      }
      return undefined;
    }
    case "cron":
      return nextCronAfter(parseCron(schedule.expr), from);
  }
}

/** cron 逐字段进位搜索（不逐分钟遍历）；搜索上限 {@link MAX_SEARCH_DAYS} 天，无匹配返回 undefined。 */
function nextCronAfter(fields: CronFields, from: number): number | undefined {
  const deadline = from + MAX_SEARCH_DAYS * DAY_MS;
  const minutes = fields.minute;
  const hours = fields.hour;
  const fromDate = new Date(from);
  // 从 from + 60s 起、秒归零；逐字段进位：月 → 日 → 时 → 分。
  let cursor = new Date(from + 60_000);
  cursor.setSeconds(0, 0);
  for (;;) {
    if (cursor.getTime() > deadline) return undefined;
    const year = cursor.getFullYear();
    const monthIdx = cursor.getMonth();
    // 月不进位则快进到下一个匹配月的第一天。
    if (!fields.month.includes(monthIdx + 1)) {
      cursor = new Date(year, monthIdx + 1, 1, 0, 0, 0, 0);
      continue;
    }
    // 月内找第一个匹配的日期（dom/dow 组合规则）。
    const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
    let day = cursor.getDate();
    while (day <= daysInMonth && !cronDayMatches(fields, year, monthIdx, day)) day += 1;
    if (day > daysInMonth) {
      cursor = new Date(year, monthIdx + 1, 1, 0, 0, 0, 0);
      continue;
    }
    // 解析出的日期是不是 from 当天：不是当天就直接取当日最早的「时:分」（cursor 此时已不在 from 的时分位置）；
    // 是当天才需要跟 from 的时分做进位比较。
    const fromDay =
      year === fromDate.getFullYear() && monthIdx === fromDate.getMonth() && day === fromDate.getDate();
    if (!fromDay) {
      const candidate = new Date(year, monthIdx, day, hours[0], minutes[0], 0, 0);
      return candidate.getTime() <= deadline ? candidate.getTime() : undefined;
    }
    // 时/分进位：当前小时在列表内，先找同小时不早于 cursor 的分钟（cursor 恒大于 from，
    // 取等号正好覆盖 from 带秒分量、触发分钟即 cursor 所在分钟的情形）；否则找更大的小时；都失败进位到明天。
    if (hours.includes(cursor.getHours())) {
      const nextMinute = minutes.find((minute) => minute >= cursor.getMinutes());
      if (nextMinute !== undefined) {
        const candidate = new Date(year, monthIdx, day, cursor.getHours(), nextMinute, 0, 0);
        return candidate.getTime() <= deadline ? candidate.getTime() : undefined;
      }
    }
    const nextHour = hours.find((hour) => hour > cursor.getHours());
    if (nextHour !== undefined) {
      const candidate = new Date(year, monthIdx, day, nextHour, minutes[0], 0, 0);
      return candidate.getTime() <= deadline ? candidate.getTime() : undefined;
    }
    cursor = new Date(year, monthIdx, day + 1, 0, 0, 0, 0);
  }
}

/**
 * 触发周期推导（coalescedCount 用）：daily=24h、interval=minutes、hourly=1h；
 * weekly/monthly/cron 用连续两次 {@link nextFireAfter} 的差值（weekly 多日固定按 7 天会算错）；
 * once/manual/无法推导返回 undefined。
 */
export function periodOf(schedule: AutomationSchedule): number | undefined {
  switch (schedule.kind) {
    case "daily":
      return DAY_MS;
    case "interval":
      return schedule.minutes * 60_000;
    case "hourly":
      return 3600_000;
    case "once":
    case "manual":
      return undefined;
    case "weekly":
    case "monthly":
    case "cron": {
      // 固定基准（2026-01-05 周一中午）保证结果确定：两次连续触发差值与调用时刻无关。
      const first = nextFireAfter(schedule, PERIOD_BASE_MS);
      if (first === undefined) return undefined;
      const second = nextFireAfter(schedule, first);
      return second === undefined ? undefined : second - first;
    }
  }
}

/** {@link periodOf} 差值法的固定基准：2026-01-05 12:00 本地时间（周一，避开 DST 边界）。 */
const PERIOD_BASE_MS = new Date(2026, 0, 5, 12, 0, 0).getTime();

/** cron 的中文展示文案；dom/dow 并集如实描述为「或」。非法表达式抛中文错误。 */
export function humanizeCron(expr: string): string {
  const fields = parseCron(expr);
  const parts: string[] = [];
  const monthAll = fields.month.length === 12;

  if (!monthAll) parts.push(`每年 ${fields.month.join("、")} 月`);
  // 小时为 * 时（如 */15 * * * *）时间部分本身就是频率描述，「每天/每周X」前缀是冗余。
  if (fields.hour.length !== 24) {
    if (fields.dom !== "*" && fields.dow !== "*") {
      parts.push(`每月 ${fields.dom.join("、")} 日或${dowPart(fields.dow)}`);
    } else if (fields.dom !== "*") {
      parts.push(monthAll ? `每月 ${fields.dom.join("、")} 日` : `${fields.dom.join("、")} 日`);
    } else if (fields.dow !== "*") {
      parts.push(dowPart(fields.dow));
    } else {
      parts.push("每天");
    }
  }

  const time = timePart(fields);
  if (time) parts.push(time);
  return parts.join(" ");
}

function dowPart(days: number[]): string {
  // 「每」只冠首项：每周一、周二、周三（而不是 每周周一、每周周二）。
  return `每${days.map((day) => DOW_NAMES[day]).join("、")}`;
}

function timePart(fields: CronFields): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hourAll = fields.hour.length === 24;
  const minuteAll = fields.minute.length === 60;
  if (hourAll && minuteAll) return "每分钟";
  if (hourAll) {
    if (fields.minute.length === 1) return `每小时的第 ${fields.minute[0]} 分钟`;
    const step = evenStepFromZero(fields.minute);
    if (step !== undefined) return `每 ${step} 分钟`;
    return `每小时的第 ${fields.minute.join("、")} 分钟`;
  }
  if (fields.hour.length === 1 && fields.minute.length === 1) {
    return `${pad(fields.hour[0]!)}:${pad(fields.minute[0]!)}`;
  }
  if (fields.minute.length === 1) return `${fields.hour.join("、")} 点 ${pad(fields.minute[0]!)} 分`;
  return `${fields.hour.join("、")} 点，第 ${fields.minute.join("、")} 分钟`;
}

/** 集合是否是从 0 开始的等差步进（如 [0,15,30,45] → 15）；是则返回步长。 */
function evenStepFromZero(values: number[]): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined;
  const step = values[1];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! - values[i - 1]! !== step) return undefined;
  }
  return step;
}

function splitTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) throw new Error(`调度时间必须是 HH:MM：${time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`调度时间超出合法范围：${time}`);
  return [hour, minute];
}
