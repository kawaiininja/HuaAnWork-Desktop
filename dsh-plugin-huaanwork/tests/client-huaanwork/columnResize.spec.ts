import { describe, expect, it } from "vitest";
import {
  CENTER_MIN_WIDTH,
  LEFT_MIN_WIDTH,
  RIGHT_MIN_WIDTH,
  clampLeftWidth,
  clampRightWidth,
  resolveColumnWidths,
} from "../../src/client-huaanwork/logic/columnResize.ts";

describe("clampLeftWidth(左栏拖拽钳制)", () => {
  it("范围内的请求原样通过", () => {
    expect(clampLeftWidth(240, 1200, 360, true)).toBe(240);
  });

  it("低于左栏最小宽度时落到下限", () => {
    expect(clampLeftWidth(100, 1200, 360, true)).toBe(LEFT_MIN_WIDTH);
  });

  it("上限保证中栏不低于最小宽度(右栏在位)", () => {
    // 1200 - 320(中栏最小) - 360(右栏) = 520
    expect(clampLeftWidth(700, 1200, 360, true)).toBe(1200 - CENTER_MIN_WIDTH - 360);
  });

  it("无右栏时上限只给中栏留最小宽度", () => {
    expect(clampLeftWidth(1000, 1200, 0, false)).toBe(1200 - CENTER_MIN_WIDTH);
  });
});

describe("clampRightWidth(右栏拖拽钳制)", () => {
  it("范围内的请求原样通过", () => {
    expect(clampRightWidth(360, 1200, 240)).toBe(360);
  });

  it("低于右栏最小宽度时落到下限", () => {
    expect(clampRightWidth(100, 1200, 240)).toBe(RIGHT_MIN_WIDTH);
  });

  it("上限保证中栏不低于最小宽度", () => {
    // 1200 - 320(中栏最小) - 240(左栏) = 640
    expect(clampRightWidth(800, 1200, 240)).toBe(1200 - CENTER_MIN_WIDTH - 240);
  });
});

describe("resolveColumnWidths(窗口尺寸变化后的整体重钳制)", () => {
  it("无右栏时右宽归零,左栏只受中栏最小宽度约束", () => {
    expect(resolveColumnWidths({ left: 240, right: 360, total: 1200, hasRight: false }))
      .toEqual({ left: 240, right: 0 });
    expect(resolveColumnWidths({ left: 1000, right: 360, total: 1200, hasRight: false }))
      .toEqual({ left: 1200 - CENTER_MIN_WIDTH, right: 0 });
  });

  it("容器足够宽时两栏原样保留", () => {
    expect(resolveColumnWidths({ left: 240, right: 360, total: 1200, hasRight: true }))
      .toEqual({ left: 240, right: 360 });
  });

  it("容器收窄时先保左栏、压右栏,中栏恰好落到最小宽度", () => {
    // total=1000:左 400 保留,右 400 → 280,中栏 320。
    expect(resolveColumnWidths({ left: 400, right: 400, total: 1000, hasRight: true }))
      .toEqual({ left: 400, right: 1000 - CENTER_MIN_WIDTH - 400 });
  });

  it("容器收到三栏最小宽度之和时两栏都落到下限", () => {
    const total = LEFT_MIN_WIDTH + CENTER_MIN_WIDTH + RIGHT_MIN_WIDTH;
    expect(resolveColumnWidths({ left: 240, right: 360, total, hasRight: true }))
      .toEqual({ left: LEFT_MIN_WIDTH, right: RIGHT_MIN_WIDTH });
  });

  it("容器比三栏最小宽度之和还窄时两栏保持下限,中栏吃剩余(不为负、不溢出)", () => {
    const total = LEFT_MIN_WIDTH + RIGHT_MIN_WIDTH + 100;
    const result = resolveColumnWidths({ left: 240, right: 360, total, hasRight: true });
    expect(result).toEqual({ left: LEFT_MIN_WIDTH, right: RIGHT_MIN_WIDTH });
    expect(total - result.left - result.right).toBe(100);
  });
});