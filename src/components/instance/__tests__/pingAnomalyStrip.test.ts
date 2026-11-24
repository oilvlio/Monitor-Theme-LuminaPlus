import { describe, expect, it } from "vitest";
import type uPlot from "uplot";
import {
  ANOMALY_COLORS,
  drawAnomalyStrip,
  stripExtraHeight,
} from "@/components/instance/pingAnomalyStrip";

function fakePlot(xMin: number, xMax: number) {
  const calls: Array<{ op: string; style?: unknown }> = [];
  const ctx = {
    fillStyle: "" as unknown,
    globalAlpha: 1,
    save: () => calls.push({ op: "save" }),
    restore: () => calls.push({ op: "restore" }),
    beginPath: () => undefined,
    fill: () => undefined,
    fillRect: () => calls.push({ op: "rect", style: ctx.fillStyle }),
    arc: () => calls.push({ op: "arc", style: ctx.fillStyle }),
  };
  const u = {
    ctx,
    height: 240,
    bbox: { left: 100, top: 10, width: 500, height: 150 },
    scales: { x: { min: xMin, max: xMax } },
    valToPos: (value: number) => 100 + ((value - xMin) / (xMax - xMin)) * 500,
  } as unknown as uPlot;
  return { u, calls };
}

describe("stripExtraHeight", () => {
  it("reserves nothing without rows and grows with each row", () => {
    expect(stripExtraHeight(0)).toBe(0);
    expect(stripExtraHeight(2)).toBeGreaterThan(stripExtraHeight(1));
  });
});

describe("drawAnomalyStrip", () => {
  const times = [0, 1, 2, 3, 4, 5];

  it("draws green ticks for in-range samples, red dots beyond the axis, and nothing for gaps", () => {
    const { u, calls } = fakePlot(0, 5);
    drawAnomalyStrip(u, {
      times,
      rows: [{ color: "#2a78d6", values: [4, 5, null, 120, 300, 700] }],
      axisMax: 50,
      trackColor: "rgba(0,0,0,0.1)",
    });

    // 1 条底轨 + 1 段连续的正常绿色（两个相邻正常采样合并成一段）。
    expect(calls.filter((c) => c.op === "rect")).toHaveLength(2);
    const dotStyles = calls
      .filter((c) => c.op === "arc")
      .map((c) => c.style)
      .slice(1); // 第 1 个是行首线路色圆点
    expect(dotStyles).toEqual([
      ANOMALY_COLORS.tiers[1],
      ANOMALY_COLORS.tiers[2],
      ANOMALY_COLORS.tiers[2],
    ]);
  });

  it("skips samples outside the visible time range after zooming", () => {
    const { u, calls } = fakePlot(2, 3);
    drawAnomalyStrip(u, {
      times,
      rows: [{ color: "#2a78d6", values: [4, 5, 6, 700, 8, 9] }],
      axisMax: 50,
      trackColor: "rgba(0,0,0,0.1)",
    });
    expect(calls.filter((c) => c.op === "rect")).toHaveLength(2); // 底轨 + 1 根竖线
    expect(calls.filter((c) => c.op === "arc")).toHaveLength(2); // 行首圆点 + 1 个异常点
  });

  it("merges adjacent normal samples into one run and breaks at gaps and anomalies", () => {
    const { u, calls } = fakePlot(0, 9);
    drawAnomalyStrip(u, {
      times: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      // 0-2 正常 | 3 丢包 | 4-5 正常 | 6 超出量程 | 7-9 正常
      rows: [{ color: "#2a78d6", values: [4, 5, 6, null, 7, 8, 900, 4, 5, 6] }],
      axisMax: 50,
      trackColor: "rgba(0,0,0,0.1)",
    });
    expect(calls.filter((c) => c.op === "rect")).toHaveLength(1 + 3);
  });

  it("breaks a run when samples are missing between two normal ones", () => {
    const { u, calls } = fakePlot(0, 9);
    drawAnomalyStrip(u, {
      times: [0, 1, 2, 6, 7, 8, 9],
      rows: [{ color: "#2a78d6", values: [4, 5, 6, 4, 5, 6, 7] }],
      axisMax: 50,
      trackColor: "rgba(0,0,0,0.1)",
    });
    expect(calls.filter((c) => c.op === "rect")).toHaveLength(1 + 2);
  });

  it("does not break a run on undefined values left by other tasks' anchors", () => {
    const { u, calls } = fakePlot(0, 5);
    drawAnomalyStrip(u, {
      times: [0, 1, 2, 3, 4, 5],
      rows: [{ color: "#2a78d6", values: [4, undefined, 6, undefined, 5, undefined] }],
      axisMax: 50,
      trackColor: "rgba(0,0,0,0.1)",
    });
    expect(calls.filter((c) => c.op === "rect")).toHaveLength(1 + 1);
  });

  it("draws nothing when there are no rows", () => {
    const { u, calls } = fakePlot(0, 5);
    drawAnomalyStrip(u, { times, rows: [], axisMax: 50, trackColor: "#000" });
    expect(calls).toHaveLength(0);
  });
});
