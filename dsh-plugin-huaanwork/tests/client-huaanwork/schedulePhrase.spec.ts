import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseSchedulePhrase } from "../../src/client-huaanwork/logic/schedulePhrase.ts";

describe("parseSchedulePhrase（自然语言 → 调度草稿，spec L610 强制用例）", () => {
  it("「每天 8 点半」→ daily 08:30", () => {
    assert.deepEqual(parseSchedulePhrase("每天 8 点半"), {
      schedule: { kind: "daily", time: "08:30" },
    });
  });

  it("「每周一 10:00」→ weekly [1] 10:00（周一=1）", () => {
    assert.deepEqual(parseSchedulePhrase("每周一 10:00"), {
      schedule: { kind: "weekly", days: [1], time: "10:00" },
    });
  });

  it("「每 3 小时」→ interval 180 分钟（无「每 N 小时」kind，interval 是等价物）", () => {
    assert.deepEqual(parseSchedulePhrase("每 3 小时"), {
      schedule: { kind: "interval", minutes: 180 },
    });
  });

  it("/schedule <phrase> → 剥前缀后解析剩余文本", () => {
    assert.deepEqual(parseSchedulePhrase("/schedule 每天 8 点半"), {
      schedule: { kind: "daily", time: "08:30" },
    });
  });

  it("/schedule 后紧跟短语（无空格）也能解析", () => {
    assert.deepEqual(parseSchedulePhrase("/schedule每天8点半"), {
      schedule: { kind: "daily", time: "08:30" },
    });
  });

  it("/schedule 剩余文本无法识别 → undefined", () => {
    assert.equal(parseSchedulePhrase("/schedule 随便说点什么"), undefined);
  });

  it("/schedule 后为空 → undefined，不抛异常", () => {
    assert.equal(parseSchedulePhrase("/schedule"), undefined);
    assert.equal(parseSchedulePhrase("/schedule   "), undefined);
  });

  it("无法识别的字符串 → undefined，不抛异常", () => {
    assert.equal(parseSchedulePhrase("帮我写一份周报"), undefined);
    assert.equal(parseSchedulePhrase(""), undefined);
    assert.equal(parseSchedulePhrase("   "), undefined);
  });

  it("紧凑变体：「每天8点半」（无空格）", () => {
    assert.deepEqual(parseSchedulePhrase("每天8点半"), {
      schedule: { kind: "daily", time: "08:30" },
    });
  });

  it("每天 + 冒号时间「每天 8:05」", () => {
    assert.deepEqual(parseSchedulePhrase("每天 8:05"), {
      schedule: { kind: "daily", time: "08:05" },
    });
  });

  it("每天 + 点N分「每天9点5分」", () => {
    assert.deepEqual(parseSchedulePhrase("每天9点5分"), {
      schedule: { kind: "daily", time: "09:05" },
    });
  });

  it("每天 + 整点「每天9点」→ 09:00", () => {
    assert.deepEqual(parseSchedulePhrase("每天9点"), {
      schedule: { kind: "daily", time: "09:00" },
    });
  });

  it("每周日/每周天 都映射到 days: [0]", () => {
    assert.deepEqual(parseSchedulePhrase("每周日 09:00"), {
      schedule: { kind: "weekly", days: [0], time: "09:00" },
    });
    assert.deepEqual(parseSchedulePhrase("每周天 09:00"), {
      schedule: { kind: "weekly", days: [0], time: "09:00" },
    });
  });

  it("短语后附带的多余文本作为 remainder（供预填 prompt）", () => {
    assert.deepEqual(parseSchedulePhrase("每天8点半 生成今日投研早报"), {
      schedule: { kind: "daily", time: "08:30" },
      remainder: "生成今日投研早报",
    });
  });

  it("每天缺少时间 → undefined（不猜测默认时间）", () => {
    assert.equal(parseSchedulePhrase("每天"), undefined);
  });

  it("每周缺少时间 → undefined（不猜测默认时间）", () => {
    assert.equal(parseSchedulePhrase("每周一"), undefined);
  });

  it("每 N 小时缺少数字 → undefined", () => {
    assert.equal(parseSchedulePhrase("每小时"), undefined);
  });

  it("非法时间（超过 23 点 / 59 分）→ undefined", () => {
    assert.equal(parseSchedulePhrase("每天25点"), undefined);
    assert.equal(parseSchedulePhrase("每天8:70"), undefined);
  });

  it("函数从不抛异常（防御性输入）", () => {
    assert.doesNotThrow(() => parseSchedulePhrase("😀🚀 !!! 123 点点点"));
    assert.doesNotThrow(() => parseSchedulePhrase("/schedule/schedule/schedule"));
  });
});
