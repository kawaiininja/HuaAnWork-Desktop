import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { describeScheduleText } from "../../src/client-huaanwork/logic/scheduleText.ts";
import type { AutomationSchedule } from "../../src/client-huaanwork/logic/projects.ts";

const describeSchedule = describeScheduleText;

/** 与实现共用同一时间格式化，避免时区导致断言漂移。 */
function fmt(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("describeSchedule（8 种 kind 文案 + 兜底）", () => {
  it("manual → 手动运行", () => {
    assert.equal(describeSchedule({ kind: "manual" }), "手动运行");
  });

  it("interval → 每 N 分钟", () => {
    assert.equal(describeSchedule({ kind: "interval", minutes: 30 }), "每 30 分钟");
  });

  it("daily → 每天 HH:MM", () => {
    assert.equal(describeSchedule({ kind: "daily", time: "09:00" }), "每天 09:00");
  });

  it("hourly → 每小时的第 M 分钟", () => {
    assert.equal(describeSchedule({ kind: "hourly", minute: 30 }), "每小时的第 30 分钟");
  });

  it("weekly → 每周X、Y HH:MM（多日顿号、每周只冠首项）", () => {
    assert.equal(describeSchedule({ kind: "weekly", days: [1, 4], time: "09:00" }), "每周一、周四 09:00");
    assert.equal(describeSchedule({ kind: "weekly", days: [0, 6], time: "22:30" }), "每周日、周六 22:30");
    // 与 sidecar 一致：7 归一化为周日（展示层防御，正常数据已由后端归一化）。
    assert.equal(describeSchedule({ kind: "weekly", days: [7], time: "08:00" }), "每周日 08:00");
  });

  it("monthly → 每月 D 日 HH:MM", () => {
    assert.equal(describeSchedule({ kind: "monthly", dates: [1, 15], time: "09:00" }), "每月 1、15 日 09:00");
  });

  it("once → 仅一次 · 完整日期时间", () => {
    const at = new Date(2026, 8, 10, 9, 30).getTime(); // 本地墙钟
    assert.equal(describeSchedule({ kind: "once", at }), `仅一次 · ${fmt(new Date(at))}`);
  });

  it("cron → 简化中文 humanizer（只做展示、不做调度数学）", () => {
    assert.equal(describeSchedule({ kind: "cron", expr: "0 9 * * 1,4" }), "每周一、周四 09:00");
    assert.equal(describeSchedule({ kind: "cron", expr: "* * * * *" }), "每分钟");
    assert.equal(describeSchedule({ kind: "cron", expr: "0 9 13 * 5" }), "每月 13 日或每周五 09:00");
    assert.equal(describeSchedule({ kind: "cron", expr: "*/15 * * * *" }), "每 15 分钟");
    assert.equal(describeSchedule({ kind: "cron", expr: "0 0 1 1 *" }), "每年 1 月 1 日 00:00");
  });

  it("cron 非法表达式 → 原样兜底，不抛错", () => {
    assert.equal(describeSchedule({ kind: "cron", expr: "" }), "cron ");
    assert.equal(describeSchedule({ kind: "cron", expr: "not a cron" }), "cron not a cron");
  });

  it("未知 kind → kind 字符串兜底", () => {
    assert.equal(describeSchedule({ kind: "weird" } as unknown as AutomationSchedule), "weird");
  });
});
