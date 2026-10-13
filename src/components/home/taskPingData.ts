import type { PingRecord } from "@/types/models";
import { resolvePingRecordLossPercent } from "@/utils/pingMetrics";
import type { TimedMetricPoint } from "../instance/chartData";

/**
 * 按监控任务聚合多节点延迟曲线的对齐器。
 *
 * 输入是已按单个 `task_id` 过滤、按时间升序的采样；与详情页
 * `alignPingChartRecords`（按任务分线）对称，这里按节点（`record.client`）
 * 分线。邻近采样共享时间锚点，丢包率按原始样本数合并。
 */
export function alignTaskPingRecords(
  sortedRecords: Array<{ record: PingRecord; time: number }>,
  nodeKeys: Set<string>,
  tolerance: number,
) {
  const latencyPointMap = new Map<number, TimedMetricPoint>();
  const lossPointMap = new Map<number, TimedMetricPoint>();
  const lossWeightMap = new Map<number, TimedMetricPoint>();
  let lastAnchor = Number.NEGATIVE_INFINITY;

  for (const { record, time } of sortedRecords) {
    const nodeKey = record.client;
    if (!nodeKey || !nodeKeys.has(nodeKey)) continue;
    const anchor = time - lastAnchor <= tolerance ? lastAnchor : time;
    lastAnchor = anchor;

    const latency = latencyPointMap.get(anchor) ?? { time: anchor };
    // 延迟沿用最新采样；0 是亚毫秒成功，负值才表示丢包。
    latency[nodeKey] = record.value >= 0 ? record.value : null;
    latencyPointMap.set(anchor, latency);

    const loss = lossPointMap.get(anchor) ?? { time: anchor };
    const weights = lossWeightMap.get(anchor) ?? { time: anchor };
    const previousWeight = weights[nodeKey] ?? 0;
    const weight =
      typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
        ? Math.max(1, Math.round(record.count))
        : 1;
    const totalWeight = previousWeight + weight;
    // 同节点也可能因采样抖动落入同一锚点，不能用后一条覆盖已有丢包和权重。
    loss[nodeKey] =
      ((loss[nodeKey] ?? 0) * previousWeight + resolvePingRecordLossPercent(record) * weight) /
      totalWeight;
    weights[nodeKey] = totalWeight;
    lossPointMap.set(anchor, loss);
    lossWeightMap.set(anchor, weights);
  }

  return {
    latencyPoints: [...latencyPointMap.values()],
    lossPoints: [...lossPointMap.values()],
    lossWeightMap,
  };
}
