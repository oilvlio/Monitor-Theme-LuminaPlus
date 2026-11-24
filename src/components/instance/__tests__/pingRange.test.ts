import { describe, expect, it } from "vitest";
import {
  classifyOverRange,
  clipSeriesToAxis,
  countOverRange,
  niceCeil,
  resolveAutoLatencyRange,
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

describe("resolveAutoLatencyRange – upper bound", () => {
  it("puts the p95 near 80% and is not stretched by a few spikes", () => {
    const series: Array<number | null> = baseline(120);
    series[50] = 939;
    series[90] = 760;
    const range = resolveAutoLatencyRange([series]);
    expect(range).toEqual({ min: 0, max: 10 });
    expect((seriesPercentile(series, 0.95) ?? 0) / range.max).toBeLessThanOrEqual(0.8);
  });

  it("keeps a sustained degradation (well over 5% of samples) in the line", () => {
    const series = [...baseline(60), ...Array.from({ length: 20 }, (_, i) => 35 + (i % 5))];
    expect(resolveAutoLatencyRange([series]).max).toBe(50);
  });

  it("moves a very short degradation (under 5% of samples) to the strip", () => {
    const series = [...baseline(100), 40, 41, 42];
    expect(resolveAutoLatencyRange([series]).max).toBe(10);
  });

  it("shares one axis across series using the largest per-series p95", () => {
    const calm = baseline(60);
    const degraded = [...baseline(40), ...Array.from({ length: 20 }, (_, i) => 60 + (i % 5))];
    expect(resolveAutoLatencyRange([calm, degraded])).toEqual({ min: 0, max: 80 });
  });

  it("falls back to a default range without valid samples", () => {
    expect(resolveAutoLatencyRange([])).toEqual({ min: 0, max: 100 });
    expect(resolveAutoLatencyRange([[null, null]])).toEqual({ min: 0, max: 100 });
  });
});

describe("resolveAutoLatencyRange – lower bound", () => {
  // 约 142–165ms 的高基线线路，偶有 190–224ms 的抖动和个别尖刺。
  function highBaseline() {
    const series: number[] = Array.from({ length: 721 }, (_, index) => 142 + ((index * 7) % 24));
    for (let index = 430; index < 520; index += 1) series[index] += 20 + (index % 30);
    [566, 540, 500, 450, 415].forEach((value, index) => {
      series[20 + index * 100] = value;
    });
    return series;
  }

  it("lifts the lower bound for a high-baseline line instead of anchoring at zero", () => {
    const series = highBaseline();
    const range = resolveAutoLatencyRange([series]);
    const min = Math.min(...series);
    expect(range.min).toBeGreaterThan(0);
    expect(range.min).toBeLessThanOrEqual(min);
    // 基线不再挤在上半截：最低采样落在量程下半部分。
    expect((min - range.min) / (range.max - range.min)).toBeLessThan(0.3);
    // p95 上方仍留有缓冲，尖刺不撑大量程。
    const p95 = seriesPercentile(series, 0.95) ?? 0;
    expect((p95 - range.min) / (range.max - range.min)).toBeLessThanOrEqual(0.85);
    expect(range.max).toBeLessThanOrEqual(260);
  });

  it("does not magnify a very stable high-baseline line into full-height jitter", () => {
    const series = Array.from({ length: 300 }, (_, index) => 158 + (index % 7));
    const range = resolveAutoLatencyRange([series]);
    const p95 = seriesPercentile(series, 0.95) ?? 0;
    expect(range.max - range.min).toBeGreaterThanOrEqual(p95 * 0.25 - 1e-9);
    expect(range.min).toBeLessThanOrEqual(158);
    expect(range.max).toBeGreaterThanOrEqual(164);
  });

  it("zooms a mid-level baseline such as 35–45ms", () => {
    const series = Array.from({ length: 300 }, (_, index) => 35 + ((index * 3) % 11));
    const range = resolveAutoLatencyRange([series]);
    expect(range.min).toBeGreaterThanOrEqual(25);
    expect(range.min).toBeLessThanOrEqual(35);
    expect(range.max).toBeGreaterThanOrEqual(45);
    expect(range.max).toBeLessThanOrEqual(60);
  });

  it("keeps zero as the lower bound for low-latency lines", () => {
    expect(resolveAutoLatencyRange([baseline(120, 12)]).min).toBe(0);
  });

  it("keeps zero when series differ widely in level (shared axis)", () => {
    const fast = baseline(120);
    const slow = Array.from({ length: 120 }, (_, index) => 150 + (index % 9));
    expect(resolveAutoLatencyRange([fast, slow]).min).toBe(0);
  });

  it("never puts the lower bound above the lowest sample", () => {
    const series = [150, 151, 149, 152, 148, 150, 153, 147, 150, 151, 149, 150];
    expect(resolveAutoLatencyRange([series]).min).toBeLessThanOrEqual(147);
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
