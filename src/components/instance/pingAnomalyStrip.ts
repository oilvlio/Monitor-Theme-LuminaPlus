import type uPlot from "uplot";
import { classifyOverRange, type PingSeries } from "./pingRange";

/** 正常 = 绿色小竖线；超出量程的点按 1–2 倍 / 2–5 倍 / 5 倍以上由浅到深。丢包与无数据留空。 */
export const ANOMALY_COLORS = {
  normal: "#2e9e4a",
  tiers: ["#f2aaa6", "#e34948", "#a82a2a"],
} as const;

/** 与 PingChart 的 padding 底部基础值保持一致。 */
export const CHART_BASE_BOTTOM_PADDING = 12;

const STRIP_TOP_GAP = 6;
const STRIP_ROW_HEIGHT = 8;
const STRIP_ROW_GAP = 4;
const STRIP_BOTTOM_PAD = 2;
const DOT_RADIUS = 3;

/** 色带占用的额外高度（css px）；没有行时为 0。 */
export function stripExtraHeight(rows: number): number {
  if (rows <= 0) return 0;
  return (
    STRIP_TOP_GAP + rows * STRIP_ROW_HEIGHT + (rows - 1) * STRIP_ROW_GAP + STRIP_BOTTOM_PAD
  );
}

export interface AnomalyStripRow {
  /** 行首小圆点的颜色，用来对应线路。 */
  color: string;
  values: PingSeries;
}

export interface AnomalyStripSpec {
  times: ArrayLike<number>;
  rows: readonly AnomalyStripRow[];
  axisMax: number;
  trackColor: string;
}

/**
 * 在图表底部预留的区域绘制色带（uPlot draw 钩子里调用）。
 * 使用 valToPos 换算横坐标，因此拖动缩放时间轴时会自动对齐。
 */
export function drawAnomalyStrip(u: uPlot, spec: AnomalyStripSpec) {
  const rowCount = spec.rows.length;
  if (rowCount === 0) return;
  const { left, width } = u.bbox;
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null || !(width > 0)) return;

  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const { ctx } = u;
  const rowHeight = STRIP_ROW_HEIGHT * ratio;
  const rowGap = STRIP_ROW_GAP * ratio;
  const top =
    (u.height - CHART_BASE_BOTTOM_PADDING - stripExtraHeight(rowCount) + STRIP_TOP_GAP) * ratio;

  const times = spec.times;
  const pxPerSecond = width / Math.max(1e-9, xMax - xMin);

  ctx.save();
  spec.rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * (rowHeight + rowGap);
    const centerY = y + rowHeight / 2;

    ctx.fillStyle = spec.trackColor;
    ctx.fillRect(left, y, width, rowHeight);

    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(left - 8 * ratio, centerY, 2.5 * ratio, 0, Math.PI * 2);
    ctx.fill();

    // 典型采样间隔按这条线路自己的数据算：undefined 是别的线路的对齐锚点，不算这条线路的采样。
    const ownTimes: number[] = [];
    for (let index = 0; index < times.length; index += 1) {
      if (row.values[index] !== undefined) ownTimes.push(times[index]);
    }
    const diffs: number[] = [];
    for (let index = 1; index < ownTimes.length; index += 1) {
      const diff = ownTimes[index] - ownTimes[index - 1];
      if (diff > 0) diffs.push(diff);
    }
    diffs.sort((a, b) => a - b);
    const typicalStep = diffs.length > 0 ? diffs[Math.floor(diffs.length / 2)] : 0;
    const halfCell = Math.max(0.5 * ratio, (typicalStep * pxPerSecond) / 2);

    const dots: Array<{ x: number; tier: number }> = [];
    // 连续的正常采样合并成一整段绿色，避免采样密集时相邻竖线之间的缝隙形成条码纹；
    // 丢包 / 无数据 / 超出量程的位置，或两个采样之间缺了数据，都会断开。
    let runStart: number | null = null;
    let runEnd = 0;
    let runEndTime = 0;
    const flushRun = () => {
      if (runStart == null) return;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = ANOMALY_COLORS.normal;
      ctx.fillRect(runStart - halfCell, centerY - 4 * ratio, runEnd - runStart + halfCell * 2, 8 * ratio);
      ctx.globalAlpha = 1;
      runStart = null;
    };
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index];
      if (time < xMin || time > xMax) continue;
      const value = row.values[index];
      if (value === undefined) continue;
      const valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
      if (!valid) {
        flushRun();
        continue;
      }
      const x = u.valToPos(time, "x", true);
      const tier = classifyOverRange(value, spec.axisMax);
      if (tier >= 0) {
        flushRun();
        dots.push({ x, tier });
        continue;
      }
      const continuous =
        runStart != null && (typicalStep <= 0 || time - runEndTime <= typicalStep * 1.5);
      if (!continuous) {
        flushRun();
        runStart = x;
      }
      runEnd = x;
      runEndTime = time;
    }
    flushRun();

    // 异常点后画，压在绿色竖线之上；最慢的最后画，避免被浅色点盖住。
    dots.sort((a, b) => a.tier - b.tier);
    for (const dot of dots) {
      ctx.fillStyle = ANOMALY_COLORS.tiers[dot.tier];
      ctx.beginPath();
      ctx.arc(dot.x, centerY, DOT_RADIUS * ratio, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.restore();
}
