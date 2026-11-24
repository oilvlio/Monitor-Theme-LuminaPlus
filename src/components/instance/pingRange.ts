/**
 * Ping 延迟图的“自动量程 + 异常色带”规则（纯函数，不依赖图表库）。
 *
 * 思路：折线只负责回答“什么时候整体变慢、慢到多少”，所以量程由“典型的高位”决定——
 * 取各线路延迟的 p95，让它落在量程的 80% 左右（上方留 20% 缓冲）。超出量程的点从折线里
 * 拿掉，改在下方色带里按各自的时间位置落一个点，颜色越深表示越慢。
 *
 * 用百分位而不是“排除尖刺后的最大值”：后者的判据依赖相对基线的倍数，对基线很高的线路
 * （150ms 以上）会失效，而百分位对基线高低不敏感，只取决于异常点占比。
 */

export type PingSeries = ArrayLike<number | null | undefined>;

/** 决定量程的百分位值占量程的目标比例，剩余部分是缓冲区。 */
export const AUTO_RANGE_HEADROOM = 0.8;

/** 量程候选刻度（ms）。小值给亚毫秒/局域网线路，大值给跨洲或异常线路；中段刻度密一些，避免多出 60% 的空白。 */
const NICE_AXIS_STEPS = [
  1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 350, 400, 450,
  500, 600, 700, 800, 1000, 1200, 1500, 2000, 3000, 5000,
];

/** 默认量程：没有任何有效采样时使用。 */
export const DEFAULT_LATENCY_AXIS_MAX = 100;

/**
 * 决定量程的百分位。超过它的点（约 5%）中，高于量程的会进入色带；
 * 占比低于 5% 的短时劣化也会进入色带，占比更大的持续劣化则留在折线里。
 */
export const AUTO_RANGE_PERCENTILE = 0.95;

export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return NICE_AXIS_STEPS[0];
  for (const step of NICE_AXIS_STEPS) {
    if (step >= value) return step;
  }
  return Math.ceil(value / 1000) * 1000;
}

function isValidLatency(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 有效采样（有限且 >= 0）的分位数，线性插值；没有有效采样返回 null。 */
export function seriesPercentile(series: PingSeries, ratio: number): number | null {
  const values: number[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index];
    if (isValidLatency(value)) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const position = Math.min(1, Math.max(0, ratio)) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

/**
 * 多条线路共用一条 Y 轴：取各线路 p95 中的最大者（逐线路取，避免持续劣化的线路被平静的线路稀释），
 * 再留出缓冲并取整。
 */
export function resolveAutoLatencyAxis(
  seriesList: readonly PingSeries[],
  percentile = AUTO_RANGE_PERCENTILE,
): number {
  let top: number | null = null;
  for (const series of seriesList) {
    const value = seriesPercentile(series, percentile);
    if (value != null && (top == null || value > top)) top = value;
  }
  if (top == null) return DEFAULT_LATENCY_AXIS_MAX;
  return niceCeil(top / AUTO_RANGE_HEADROOM);
}

/** -1：在量程内（正常）；0/1/2：超出量程 1–2 倍 / 2–5 倍 / 5 倍以上。 */
export type AnomalyTier = -1 | 0 | 1 | 2;

export function classifyOverRange(value: number, axisMax: number): AnomalyTier {
  if (value <= axisMax) return -1;
  if (value <= axisMax * 2) return 0;
  if (value <= axisMax * 5) return 1;
  return 2;
}

/** 折线用的数据：超出量程的点置为 null，折线在该处断开而不是连过去。 */
export function clipSeriesToAxis(
  series: PingSeries,
  axisMax: number,
): Array<number | null | undefined> {
  const out: Array<number | null | undefined> = new Array(series.length);
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index];
    out[index] = isValidLatency(value) && value > axisMax ? null : value;
  }
  return out;
}

/** 统计一条线路在量程之外的采样个数（valid 是全部有效采样数）。 */
export function countOverRange(series: PingSeries, axisMax: number) {
  let valid = 0;
  let over = 0;
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index];
    if (!isValidLatency(value)) continue;
    valid += 1;
    if (value > axisMax) over += 1;
  }
  return { valid, over };
}
