import { describe, expect, it } from "vitest";
import {
  classifyOverRange,
  clipSeriesToAxis,
  countOverRange,
  niceCeil,
  resolveAutoLatencyAxis,
  seriesPercentile,
} from "@/components/instance/pingRange";

// 确定性的基线：4–6ms 之间循环，模拟稳定线路。
function baseline(length: number, from = 4) {
  return Array.from({ length }, (_, index) => from + (index % 3));
}

describe("niceCeil", () => {
  it("rounds up to the next readable axis step", () => {
    expect(niceCeil(0.6)).toBe(1);
    expect(niceCeil(41)).toBe(50);
    expect(niceCeil(97)).toBe(100);
    expect(niceCeil(270)).toBe(300);
    expect(niceCeil(310)).toBe(350);
    expect(niceCeil(520)).toBe(600);
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(5001)).toBe(6000);
  });

  it("falls back to the smallest step for non-positive or invalid input", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-3)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
});

describe("seriesPercentile", () => {
  it("interpolates between ranked samples", () => {
    const series = Array.from({ length: 101 }, (_, index) => index);
    expect(seriesPercentile(series, 0.95)).toBe(95);
    expect(seriesPercentile(series, 0.5)).toBe(50);
    expect(seriesPercentile([10, 20], 0.5)).toBe(15);
  });

  it("skips nulls, undefined, NaN and negative values", () => {
    expect(seriesPercentile([null, undefined, -1, Number.NaN], 0.95)).toBeNull();
    expect(seriesPercentile([null, 8, undefined, 9, -1], 1)).toBe(9);
  });
});

describe("resolveAutoLatencyAxis", () => {
  it("puts the p95 near 80% and is not stretched by a few spikes", () => {
    const series: Array<number | null> = baseline(120);
    series[50] = 939;
    series[90] = 760;
    const axis = resolveAutoLatencyAxis([series]);
    expect(axis).toBe(10);
    expect((seriesPercentile(series, 0.95) ?? 0) / axis).toBeLessThanOrEqual(0.8);
  });

  it("keeps a sustained degradation (well over 5% of samples) in the line", () => {
    const series = [...baseline(60), ...Array.from({ length: 20 }, (_, i) => 35 + (i % 5))];
    expect(resolveAutoLatencyAxis([series])).toBe(50);
  });

  it("moves a very short degradation (under 5% of samples) to the strip", () => {
    const series = [...baseline(100), 40, 41, 42];
    expect(resolveAutoLatencyAxis([series])).toBe(10);
  });

  it("is not fooled by a high baseline with frequent spikes", () => {
    // 基线约 158–164ms，721 个采样里有 15 个 285–566ms 的尖刺（约 2%）。
    const series: number[] = Array.from({ length: 721 }, (_, index) => 158 + (index % 7));
    const spikes = [566, 540, 500, 450, 415, 408, 395, 380, 360, 340, 320, 315, 300, 290, 285];
    spikes.forEach((value, index) => {
      series[20 + index * 45] = value;
    });
    const axis = resolveAutoLatencyAxis([series]);
    expect(axis).toBeLessThanOrEqual(300);
    expect(axis).toBeGreaterThanOrEqual(250);
  });

  it("shares one axis across series using the largest per-series p95", () => {
    const calm = baseline(60);
    const degraded = [...baseline(40), ...Array.from({ length: 20 }, (_, i) => 60 + (i % 5))];
    // 持续抬高那段的 p95 约 64ms，64 / 0.8 = 80，刚好落在候选刻度上。
    expect(resolveAutoLatencyAxis([calm, degraded])).toBe(80);
  });

  it("falls back to a default range without valid samples", () => {
    expect(resolveAutoLatencyAxis([])).toBe(100);
    expect(resolveAutoLatencyAxis([[null, null]])).toBe(100);
  });
});

describe("classifyOverRange", () => {
  it("splits points beyond the axis into three tiers by multiples", () => {
    expect(classifyOverRange(50, 50)).toBe(-1);
    expect(classifyOverRange(51, 50)).toBe(0);
    expect(classifyOverRange(100, 50)).toBe(0);
    expect(classifyOverRange(101, 50)).toBe(1);
    expect(classifyOverRange(250, 50)).toBe(1);
    expect(classifyOverRange(251, 50)).toBe(2);
  });
});

describe("clipSeriesToAxis / countOverRange", () => {
  const series = [4, 80, null, 12, undefined, 300];

  it("nulls out points above the axis and keeps gaps as they were", () => {
    expect(clipSeriesToAxis(series, 50)).toEqual([4, null, null, 12, undefined, null]);
  });

  it("does not mutate the input", () => {
    clipSeriesToAxis(series, 50);
    expect(series).toEqual([4, 80, null, 12, undefined, 300]);
  });

  it("counts valid samples and the ones beyond the axis", () => {
    expect(countOverRange(series, 50)).toEqual({ valid: 4, over: 2 });
  });
});
