import assert from "node:assert/strict";
import { test } from "vitest";

import { createKeepAwakeDriver, shouldHoldKeepAwake } from "../../src/client-huaanwork/logic/keepAwake.ts";

test("holds when keep_awake is on and a non-manual automation is enabled", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [{ enabled: true, schedule: { kind: "daily" } }]),
    true,
  );
});

test("does not hold when keep_awake is off, even with enabled automations", () => {
  assert.equal(
    shouldHoldKeepAwake(false, [{ enabled: true, schedule: { kind: "daily" } }]),
    false,
  );
});

test("does not hold when every automation is disabled", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [{ enabled: false, schedule: { kind: "daily" } }]),
    false,
  );
});

test("does not hold when the only enabled automations are manual", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [
      { enabled: true, schedule: { kind: "manual" } },
      { enabled: false, schedule: { kind: "daily" } },
    ]),
    false,
  );
});

test("does not hold with an empty automation list", () => {
  assert.equal(shouldHoldKeepAwake(true, []), false);
});

test("holds if at least one of several automations qualifies", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [
      { enabled: true, schedule: { kind: "manual" } },
      { enabled: false, schedule: { kind: "cron" } },
      { enabled: true, schedule: { kind: "cron" } },
    ]),
    true,
  );
});

/** 可控 fake invoke：每次调用入列，测试侧手动 resolve/reject，模拟任意时序。 */
type PendingCall = { hold: boolean; resolve: (held: boolean) => void; reject: (error: unknown) => void };

function makeFakeInvoke(): { calls: PendingCall[]; invoke: (hold: boolean) => Promise<boolean> } {
  const calls: PendingCall[] = [];
  return {
    calls,
    invoke: (hold) =>
      new Promise<boolean>((resolve, reject) => {
        calls.push({ hold, resolve, reject });
      }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("driver: 失败不提交 confirmed，下次同期望 refresh 重试，成功后不再发", async () => {
  const { calls, invoke } = makeFakeInvoke();
  const unavailable: boolean[] = [];
  const driver = createKeepAwakeDriver(invoke, (value) => unavailable.push(value));

  driver.refresh(true);
  assert.equal(calls.length, 1);
  calls[0]!.reject(new Error("host 501"));
  await flush();
  assert.deepEqual(unavailable, [true]);

  // 失败未提交（D4 修复目标）——同期望的下一次刷新必须重发断言。
  driver.refresh(true);
  assert.equal(calls.length, 2);
  calls[1]!.resolve(true);
  await flush();
  assert.deepEqual(unavailable, [true, false]);

  // 成功已提交——同期望的后续刷新（automations 换引用等）不再发请求。
  driver.refresh(true);
  assert.equal(calls.length, 2);
});

test("driver: 期望被更新取代后，晚到的失败结果被丢弃", async () => {
  const { calls, invoke } = makeFakeInvoke();
  const unavailable: boolean[] = [];
  const driver = createKeepAwakeDriver(invoke, (value) => unavailable.push(value));

  driver.refresh(true);
  driver.refresh(false); // 期望翻转为 false，在途的 true 断言已过期
  assert.equal(calls.length, 2);

  calls[1]!.resolve(false); // 新期望先成功：confirmed=false
  await flush();
  assert.deepEqual(unavailable, [false]);

  calls[0]!.reject(new Error("late failure")); // 旧期望的失败晚到：必须丢弃，不追加提示
  await flush();
  assert.deepEqual(unavailable, [false]);

  // confirmed 已是 false：同期望刷新短路。若旧结果被错误提交，这里会多发一次调用。
  driver.refresh(false);
  assert.equal(calls.length, 2);
});

test("driver: 期望被更新取代后，晚到的成功结果被丢弃，不清除新期望的提示", async () => {
  const { calls, invoke } = makeFakeInvoke();
  const unavailable: boolean[] = [];
  const driver = createKeepAwakeDriver(invoke, (value) => unavailable.push(value));

  driver.refresh(false);
  driver.refresh(true);
  calls[1]!.reject(new Error("host down")); // 新期望失败：提示「不可用」
  await flush();
  assert.deepEqual(unavailable, [true]);

  calls[0]!.resolve(false); // 旧期望的成功晚到（原 cancelled 缺陷场景）：必须丢弃
  await flush();
  assert.deepEqual(unavailable, [true]);

  // 失败未提交 → 同期望刷新重试，成功后清除提示。
  driver.refresh(true);
  assert.equal(calls.length, 3);
  calls[2]!.resolve(true);
  await flush();
  assert.deepEqual(unavailable, [true, false]);
});
