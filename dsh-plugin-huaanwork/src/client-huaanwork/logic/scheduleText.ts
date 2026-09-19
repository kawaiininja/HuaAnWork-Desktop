import type { AutomationSchedule } from "./projects.ts";

/**
 * 触发方式的可读描述（任务行副标题、表单 cron 实时预览共用）。
 *
 * 这是 sidecar `humanizeCron`（packages/sidecar/src/schedule.ts）的**展示层副本**：
 * 只重复中文文案、不重复调度数学（不做 nextFireAfter），与既有约定一致；
 * 文案格式尽量对齐 sidecar，漂移只影响展示、不影响触发。非法 cron 不抛错，
 * 由调用方决定兜底（describeSchedule 回退为原文，提交时由 sidecar 校验报错）。
 */

const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const FIELD_LIMITS = {
  minute: { min: 0, max: 59, label: "分钟" },
  hour: { min: 0, max: 23, label: "小时" },
  dom: { min: 1, max: 31, label: "日期" },
  month: { min: 1, max: 12, label: "月份" },
  dow: { min: 0, max: 7, label: "星期" },
} as const;

type CronFields = {
  minute: number[];
  hour: number[];
  dom: number[] | "*";
  month: number[];
  dow: number[] | "*";
};

/** 展示用 cron 解析（与 sidecar parseCron 同子集：星号、N、星号斜杠 N、N-M、N,M；dow 7 归一化为 0）。非法即抛错。 */
function parseCronFields(expr: string): CronFields {
  const text = expr.trim();
  if (!text) throw new Error("cron 表达式不能为空");
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周），当前为 ${fields.length} 个`);
  }
  return {
    minute: parseList(fields[0], FIELD_LIMITS.minute, false) as number[],
    hour: parseList(fields[1], FIELD_LIMITS.hour, false) as number[],
    dom: parseList(fields[2], FIELD_LIMITS.dom, true),
    month: parseList(fields[3], FIELD_LIMITS.month, false) as number[],
    dow: parseList(fields[4], FIELD_LIMITS.dow, true),
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
    const singleMatch = /^(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step < 1) throw new Error(`cron 的${limit.label}字段步进必须 ≥ 1：${raw}`);
      partValues = expandRange(limit.min, limit.max, step);
    } else if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (from > to) throw new Error(`cron 的${limit.label}字段范围起点大于终点：${raw}`);
      partValues = expandRange(from, to, 1);
    } else if (singleMatch) {
      partValues = [Number(singleMatch[1])];
    } else {
      throw new Error(`cron 的${limit.label}字段格式不支持（仅支持 *、N、*/N、N-M、N,M）：${raw}`);
    }
    for (const value of partValues) {
      if (value < limit.min || value > limit.max) {
        throw new Error(`cron 的${limit.label}字段超出范围 ${limit.min}-${limit.max}：${raw}`);
      }
      values.add(limit.label === "星期" && value === 7 ? 0 : value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function expandRange(from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

/** 集合是否是从 0 开始的等差步进（如 [0,15,30,45] → 15）；是则返回步长。 */
function evenStepFromZero(values: number[]): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined;
  const step = values[1];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] - values[i - 1] !== step) return undefined;
  }
  return step;
}

/** dow 文案：「每」只冠首项（每周一、周二、周三）。 */
function dowPart(days: number[]): string {
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
    return `${pad(fields.hour[0])}:${pad(fields.minute[0])}`;
  }
  if (fields.minute.length === 1) return `${fields.hour.join("、")} 点 ${pad(fields.minute[0])} 分`;
  return `${fields.hour.join("、")} 点，第 ${fields.minute.join("、")} 分钟`;
}

/** sidecar humanizeCron 的展示层副本：非法表达式抛错，调用方自行兜底。 */
export function humanizeCronText(expr: string): string {
  const fields = parseCronFields(expr);
  const parts: string[] = [];
  const monthAll = fields.month.length === 12;

  if (!monthAll) parts.push(`每年 ${fields.month.join("、")} 月`);
  // 小时为 * 时（如 */15 * * * *）时间部分本身就是频率描述，「每天/每周X」前缀是冗余。
  if (fields.hour.length !== 24) {
    if (fields.dom !== "*" && fields.dow !== "*") {
      parts.push(`每月 ${fields.dom.join("、")} 日或${dowPart(fields.dow as number[])}`);
    } else if (fields.dom !== "*") {
      parts.push(monthAll ? `每月 ${fields.dom.join("、")} 日` : `${fields.dom.join("、")} 日`);
    } else if (fields.dow !== "*") {
      parts.push(dowPart(fields.dow as number[]));
    } else {
      parts.push("每天");
    }
  }

  const time = timePart(fields);
  if (time) parts.push(time);
  return parts.join(" ");
}

/** 触发方式的可读描述：8 种 kind 全覆盖；cron 非法时回退原文（不抛错）。 */
export function describeScheduleText(schedule: AutomationSchedule): string {
  if (schedule.kind === "manual") return "手动运行";
  if (schedule.kind === "interval") return `每 ${schedule.minutes} 分钟`;
  if (schedule.kind === "daily") return `每天 ${schedule.time}`;
  if (schedule.kind === "hourly") return `每小时的第 ${schedule.minute} 分钟`;
  if (schedule.kind === "weekly") {
    const days = [...new Set(schedule.days.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
    return `${dowPart(days)} ${schedule.time}`;
  }
  if (schedule.kind === "monthly") return `每月 ${[...schedule.dates].sort((a, b) => a - b).join("、")} 日 ${schedule.time}`;
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `仅一次 · ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (schedule.kind === "cron") {
    try {
      return humanizeCronText(schedule.expr);
    } catch {
      return `cron ${schedule.expr}`;
    }
  }
  // 未知 kind（union 外的脏数据）：原样展示，不抛错。
  return (schedule as { kind: string }).kind;
}
