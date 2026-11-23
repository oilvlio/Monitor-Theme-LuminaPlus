import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type uPlot from "uplot";

// 共享的图表配色。LoadChart 按指标 (cpu/memory/…) 取色，PingChart 按 task 循环取色；
// 两者都取自这一处单一来源，避免 hex 值在两个图表间漂移。
export const CHART_PALETTE = {
  cpu: "#5d88ff",
  memory: "#a35cf5",
  disk: "#f1873d",
  success: "#61c08f",
  warning: "#d4a54a",
} as const;

// 备用定性色板（仅缺少总数时用）；正常走下面的 OKLCH 生成。
const CHART_SERIES_COLORS = [
  "#4878d0", // 蓝
  "#ee854a", // 橙
  "#6acc64", // 绿
  "#d65f5f", // 红
  "#956cb4", // 紫
  "#8c613c", // 棕
  "#dc7ec0", // 粉
  "#4aa7a0", // 青
  "#c7b446", // 芥黄
  "#82c6e2", // 浅蓝
] as const;

let oklchSupported: boolean | null = null;
function supportsOklch(): boolean {
  if (oklchSupported === null) {
    oklchSupported =
      typeof window !== "undefined" &&
      typeof window.CSS !== "undefined" &&
      typeof window.CSS.supports === "function" &&
      window.CSS.supports("color", "oklch(0.7 0.2 120 / 0.85)");
  }
  return oklchSupported;
}

export function colorForSeries(index: number, total?: number): string {
  // 没有总数时（防御性调用）退回精选板。
  if (typeof total !== "number" || total <= 0) {
    return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
  }
  // 色相按总数均分，用 OKLCH 渲染：固定明度让每条线一样亮、中等彩度不刺眼、0.85 透明度让密集区
  // 混色不互相盖死；不支持则降级 HSL。
  const hue = Math.round((index * 360) / total);
  return supportsOklch()
    ? `oklch(0.7 0.2 ${hue} / 0.95)`
    : `hsl(${hue}, 50%, 60%)`;
}

// uPlot 图表的坐标轴网格/文字颜色。单一来源，避免 LoadChart 和 PingChart 在 dark/light 字面量上漂移。
export function getAxisColors(isDark: boolean): { grid: string; text: string } {
  return {
    grid: isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)",
    text: isDark ? "#a5a5aa" : "#52525b",
  };
}

// uPlot 图表 (LoadChart / PingChart) 共享的悬停 tooltip 状态结构。
export interface ChartTooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

interface TimeRangeOption {
  label: string;
  value: number;
}

const DETAIL_TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "3 天", value: 72 },
  { label: "7 天", value: 168 },
  { label: "15 天", value: 360 },
];

function buildDetailTimeRangeOptions(maxHours: number | null | undefined) {
  if (!Number.isFinite(maxHours) || !maxHours || maxHours <= 0) {
    return [...DETAIL_TIME_RANGE_OPTIONS];
  }

  const safeMaxHours = Math.floor(maxHours);
  return DETAIL_TIME_RANGE_OPTIONS.filter((option) => option.value <= safeMaxHours);
}

export function buildLoadTimeRangeOptions(maxHours: number | null | undefined) {
  return buildDetailTimeRangeOptions(maxHours);
}

export function buildPingTimeRangeOptions(maxHours: number | null | undefined) {
  return buildDetailTimeRangeOptions(maxHours);
}

export function getTimeAxisSpace(rangeHours: number) {
  if (rangeHours >= 168) return 110;
  if (rangeHours >= 72) return 100;
  if (rangeHours >= 24) return 90;
  if (rangeHours >= 4) return 80;
  return 70;
}

// 进程数/连接数这类计数没有小数。uPlot 默认刻度会按像素高度取 2.5 之类的步长，
// 于是出现 72.5/75.0 这种刻度；稳定的小数值还会让整条轴只落一个刻度。
// 计数轴统一用整数边界，并保证至少 4 个单位的窗口，让刻度稳定落在整数上。
export function getCountAxisRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 4];
  const lower = Math.max(0, Math.floor(Math.min(min, max)));
  const upper = Math.ceil(Math.max(min, max));
  if (upper - lower < 4) {
    // 窗口太窄时向两侧补齐，避免把平坦的曲线贴在底边。
    const shift = Math.ceil((4 - (upper - lower)) / 2);
    const padded = Math.max(0, lower - shift);
    return [padded, padded + 4];
  }
  return [lower, upper];
}

const AXIS_STEP_FACTORS = [1, 2, 2.5, 5] as const;

function axisStepCandidates(span: number, integerOnly: boolean): number[] {
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const steps = new Set<number>();
  for (const scale of [magnitude / 100, magnitude / 10, magnitude, magnitude * 10]) {
    for (const factor of AXIS_STEP_FACTORS) {
      const step = factor * scale;
      if (!Number.isFinite(step) || step <= 0) continue;
      if (integerOnly && !Number.isInteger(step)) continue;
      steps.add(step);
    }
  }
  return [...steps].sort((a, b) => a - b);
}

function ticksForStep(min: number, max: number, step: number): number[] {
  const rawStart = Math.ceil(min / step - 1e-9) * step;
  // 避免 -0 出现在刻度里（Math.ceil(-1e-9) 会得到 -0）。
  const start = rawStart === 0 ? 0 : rawStart;
  if (start > max + 1e-9) return [];
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-6 && ticks.length < 64; value += step) {
    ticks.push(value);
  }
  return ticks;
}

/**
 * 所有 Y 轴共用的刻度：按「大约 3~4 个刻度」挑步长，和磁盘图一致。
 * 计数轴（进程/连接）只允许整数步长，避免 72.5 这类刻度。
 */
export function getAxisTicks(min: number, max: number, integerOnly = false): number[] {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    return [Number.isFinite(lower) ? lower : 0];
  }

  let best: number[] = [];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of axisStepCandidates(upper - lower, integerOnly)) {
    const ticks = ticksForStep(lower, upper, step);
    if (ticks.length < 2) continue;
    const score = Math.abs(ticks.length - 3.5);
    // 同分时取更细的步长，再截到 4 个，避免只剩两个标签。
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && ticks.length > best.length)) {
      best = ticks;
      bestScore = score;
    }
  }

  if (!best.length) return [lower];
  const limited = best.length > 4 ? best.slice(0, 4) : best;
  return integerOnly ? limited.map((value) => Math.round(value)) : limited;
}

export function getDiskPercentAxisRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 100];
  const lower = Math.max(0, Math.min(90, Math.floor(min / 5) * 5));
  let upper = Math.min(100, Math.ceil(max / 5) * 5);

  // A very stable disk percentage should not get a tiny auto-scaled axis that
  // visually exaggerates small changes. Keep at least a 10-point window.
  if (upper - lower < 10) upper = lower + 10;
  return [lower, upper];
}

const GRID_CHART_DEFAULT = { w: 320, h: 132 };
const GRID_CHART_HEIGHT = 132;
const WIDE_CHART_GUTTER = 96;
const WIDE_CHART_HEIGHT = 340;
const WIDE_CHART_TABLET_HEIGHT = 300;
const WIDE_CHART_MOBILE_HEIGHT = 260;
const CHART_WIDTH_STEP = 8;

export function toChartSeconds(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed / 1000;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function getDateParts(timestampSeconds: number) {
  const date = new Date(timestampSeconds * 1000);
  return {
    year: date.getFullYear(),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    hour: pad2(date.getHours()),
    minute: pad2(date.getMinutes()),
    second: pad2(date.getSeconds()),
  };
}

function formatAxisTime(timestampSeconds: number, rangeHours: number) {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 72) {
    if (parts.hour === "00" && parts.minute === "00") return `${parts.month}/${parts.day}`;
    return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
  }
  return `${parts.hour}:${parts.minute}`;
}

export function createTimeAxisFormatter(rangeHours: number) {
  return (_self: uPlot, splits: number[]): string[] =>
    splits.map((value) => formatAxisTime(value, rangeHours));
}

function formatTooltipTime(timestampSeconds: number, rangeHours = 0): string {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 24) {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatChartCoverageTime(timestampSeconds: number): string {
  const parts = getDateParts(timestampSeconds);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getChartTooltipPosition({
  containerWidth,
  containerHeight,
  anchorX,
  anchorY,
  rowCount,
  estimatedWidth = 188,
}: {
  containerWidth: number;
  containerHeight: number;
  anchorX: number;
  anchorY: number;
  rowCount: number;
  estimatedWidth?: number;
}) {
  const margin = 10;
  const offsetX = 18;
  const offsetY = 16;
  const estimatedHeight = 34 + rowCount * 22;
  const maxLeft = Math.max(margin, containerWidth - estimatedWidth - margin);
  const maxTop = Math.max(margin, containerHeight - estimatedHeight - margin);

  let left =
    anchorX + estimatedWidth + offsetX <= containerWidth - margin
      ? anchorX + offsetX
      : anchorX - estimatedWidth - offsetX;
  left = clamp(left, margin, maxLeft);

  let top = anchorY - estimatedHeight - offsetY;
  if (top < margin) top = anchorY + offsetY;
  top = clamp(top, margin, maxTop);

  return { left, top };
}

export function buildChartTooltipHooks({
  dataRef,
  rangeHours,
  estimatedWidth,
  setTooltip,
  buildRows,
}: {
  dataRef: { readonly current: uPlot.AlignedData };
  rangeHours: number;
  estimatedWidth: number;
  setTooltip: Dispatch<SetStateAction<ChartTooltipState>>;
  buildRows: (idx: number) => ChartTooltipState["rows"];
}): {
  onInit: (u: uPlot) => void;
  onDestroy: (u: uPlot) => void;
  onSetCursor: (u: uPlot) => void;
} {
  let frame: number | null = null;
  let view: Window | null = null;
  const cancelScheduled = () => {
    if (frame != null) view?.cancelAnimationFrame(frame);
    frame = null;
  };
  const hide = () => {
    cancelScheduled();
    setTooltip((prev) => (prev.show ? { ...prev, show: false } : prev));
  };
  const update = (u: uPlot) => {
    frame = null;
    const idx = u.cursor.idx;
    if (idx == null || idx < 0) {
      hide();
      return;
    }
    const timestamp = dataRef.current[0]?.[idx];
    if (typeof timestamp !== "number") {
      hide();
      return;
    }
    const bbox = u.root.getBoundingClientRect();
    const anchorX = u.over.offsetLeft + u.valToPos(timestamp, "x");
    const anchorY =
      u.over.offsetTop +
      (typeof u.cursor.top === "number" ? u.cursor.top : u.over.clientHeight * 0.5);
    const rows = buildRows(idx);
    const position = getChartTooltipPosition({
      containerWidth: bbox.width,
      containerHeight: bbox.height,
      anchorX,
      anchorY,
      rowCount: rows.length,
      estimatedWidth,
    });
    setTooltip({
      show: true,
      left: position.left,
      top: position.top,
      rows,
      time: formatTooltipTime(timestamp, rangeHours),
    });
  };
  return {
    onInit: (u) => {
      view = u.root.ownerDocument.defaultView;
      u.root.addEventListener("mouseleave", hide);
    },
    onDestroy: (u) => {
      cancelScheduled();
      u.root.removeEventListener("mouseleave", hide);
      view = null;
    },
    onSetCursor: (u) => {
      if (!view) view = u.root.ownerDocument.defaultView;
      if (frame != null) return;
      frame = view?.requestAnimationFrame(() => update(u)) ?? null;
      if (frame == null) update(u);
    },
  };
}

function computeChartSize(
  mode: "grid" | "wide",
  viewportWidth: number,
  containerWidth?: number,
): { w: number; h: number } {
  const quantize = (value: number) =>
    Math.max(1, Math.floor(value / CHART_WIDTH_STEP) * CHART_WIDTH_STEP);
  const measuredWidth =
    typeof containerWidth === "number" && containerWidth > 0
      ? containerWidth
      : mode === "wide"
        ? viewportWidth - WIDE_CHART_GUTTER
        : GRID_CHART_DEFAULT.w;

  if (mode === "wide") {
    const height =
      viewportWidth < 720
        ? WIDE_CHART_MOBILE_HEIGHT
        : viewportWidth < 1024
          ? WIDE_CHART_TABLET_HEIGHT
          : WIDE_CHART_HEIGHT;
    return {
      w: quantize(measuredWidth),
      h: height,
    };
  }

  return {
    w: quantize(measuredWidth),
    h: viewportWidth < 768 ? 136 : GRID_CHART_HEIGHT,
  };
}

export function useResponsiveChartSize(mode: "grid" | "wide") {
  const [size, setSize] = useState(
    mode === "grid"
      ? GRID_CHART_DEFAULT
      : { w: 1280, h: WIDE_CHART_HEIGHT },
  );
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const apply = useCallback(() => {
    const next = computeChartSize(mode, window.innerWidth, nodeRef.current?.clientWidth);
    setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
  }, [mode]);

  const scheduleApply = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      apply();
    });
  }, [apply]);

  const observeNode = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (node && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(scheduleApply);
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [scheduleApply],
  );

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      observeNode(node);
      if (node) {
        apply();
      }
    },
    [apply, observeNode],
  );

  useEffect(() => {
    observeNode(nodeRef.current);
    apply();
    window.addEventListener("resize", scheduleApply);
    return () => {
      window.removeEventListener("resize", scheduleApply);
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [apply, observeNode, scheduleApply]);

  return { ...size, ref };
}
