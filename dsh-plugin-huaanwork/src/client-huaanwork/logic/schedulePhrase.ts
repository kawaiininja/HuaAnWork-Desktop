import type { AutomationSchedule } from "./projects.ts";

/** parseSchedulePhrase 的成功结果：识别出的调度 + 短语中剩余的文本（若有，作为任务 prompt 草稿）。 */
export type ParsedSchedulePhrase = {
  schedule: AutomationSchedule;
  remainder?: string;
};

/** 中文星期字符 → 0-6（0 = 周日），与 AutomationSchedule.weekly.days 语义一致。 */
const WEEKDAY_CHARS: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 在字符串开头尝试解析一个时间片段（"8:30" / "8点半" / "8点30分" / "8点"），返回 HH:MM 与解析后剩余的字符串。 */
function parseTimeAt(text: string): { time: string; rest: string } | undefined {
  const colon = text.match(/^(\d{1,2}):(\d{2})\b/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour <= 23 && minute <= 59) {
      return { time: `${pad2(hour)}:${pad2(minute)}`, rest: text.slice(colon[0].length) };
    }
  }

  const half = text.match(/^(\d{1,2})\s*点\s*半/);
  if (half) {
    const hour = Number(half[1]);
    if (hour <= 23) {
      return { time: `${pad2(hour)}:30`, rest: text.slice(half[0].length) };
    }
  }

  const withMinute = text.match(/^(\d{1,2})\s*点\s*(\d{1,2})\s*分?/);
  if (withMinute) {
    const hour = Number(withMinute[1]);
    const minute = Number(withMinute[2]);
    if (hour <= 23 && minute <= 59) {
      return { time: `${pad2(hour)}:${pad2(minute)}`, rest: text.slice(withMinute[0].length) };
    }
  }

  const hourOnly = text.match(/^(\d{1,2})\s*点/);
  if (hourOnly) {
    const hour = Number(hourOnly[1]);
    if (hour <= 23) {
      return { time: `${pad2(hour)}:00`, rest: text.slice(hourOnly[0].length) };
    }
  }

  return undefined;
}

/**
 * 把自然语言短语解析为一个 AutomationSchedule 草稿（供 composer 命中后预填创建表单，人工确认后才真正创建）。
 * 只认几条固定模式，不做通用 NLP：
 *   - 「每天 8 点半」→ daily 08:30
 *   - 「每周一 10:00」→ weekly [1] 10:00（周日=0）
 *   - 「每 3 小时」→ interval 180 分钟（当前 schedule kind 里没有「每 N 小时」，interval 是等价物）
 *   - `/schedule ...` → 剥前缀后递归解析剩余文本
 * 无法识别返回 undefined，绝不抛异常。
 */
export function parseSchedulePhrase(text: string): ParsedSchedulePhrase | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const scheduleCmd = trimmed.match(/^\/schedule(.*)$/s);
  if (scheduleCmd) {
    const rest = scheduleCmd[1].trim();
    if (!rest) return undefined;
    return parseSchedulePhrase(rest);
  }

  const daily = trimmed.match(/^每天\s*(.*)$/s);
  if (daily) {
    const parsedTime = parseTimeAt(daily[1].trimStart());
    if (parsedTime) {
      const remainder = parsedTime.rest.trim();
      return {
        schedule: { kind: "daily", time: parsedTime.time },
        ...(remainder ? { remainder } : {}),
      };
    }
  }

  const weekly = trimmed.match(/^每周([一二三四五六日天])\s*(.*)$/s);
  if (weekly) {
    const day = WEEKDAY_CHARS[weekly[1]];
    const parsedTime = parseTimeAt(weekly[2].trimStart());
    if (parsedTime) {
      const remainder = parsedTime.rest.trim();
      return {
        schedule: { kind: "weekly", days: [day], time: parsedTime.time },
        ...(remainder ? { remainder } : {}),
      };
    }
  }

  const interval = trimmed.match(/^每\s*(\d+)\s*小时\s*(.*)$/s);
  if (interval) {
    const hours = Number(interval[1]);
    if (hours > 0) {
      const remainder = interval[2].trim();
      return {
        schedule: { kind: "interval", minutes: hours * 60 },
        ...(remainder ? { remainder } : {}),
      };
    }
  }

  return undefined;
}
