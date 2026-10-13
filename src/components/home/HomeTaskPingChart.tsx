import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import { RefreshCw } from "lucide-react";
import {
  buildChartTooltipHooks,
  colorForSeries,
  createTimeAxisFormatter,
  getAxisColors,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
} from "../instance/chartShared";
import { ChartTooltip, SwitchToggle } from "../instance/ChartParts";
import {
  detectTypicalIntervalSeconds,
  downsampleAligned,
  insertMetricGapSentinels,
} from "../instance/chartData";
import { resolvePingChartInterval } from "@/utils/pingMetrics";
import { historyChartRangeSeconds, historyCoverageLabel } from "@/utils/historyRange";
import { usePreferences } from "@/hooks/usePreferences";
import type { PingRecord } from "@/types/models";
import { alignTaskPingRecords } from "./taskPingData";

export interface TaskPingNode {
  uuid: string;
  name: string;
}

const MAX_RENDER_POINTS = 720;

// 服务端只下发有丢包的任务窗口丢包率，缺席即 0%，与 normalizePingHistory 一致。
function formatWindowLoss(loss: number | undefined) {
  return `${(typeof loss === "number" && Number.isFinite(loss) ? loss : 0).toFixed(1)}%`;
}

export function HomeTaskPingChart({
  taskId,
  taskName,
  taskInterval,
  records,
  nodes,
  hours,
  lossByNode,
  rangeStartMs,
  rangeEndMs,
  isFetching,
  onRefresh,
}: {
  taskId: number;
  taskName: string;
  taskInterval?: number;
  records: PingRecord[];
  nodes: TaskPingNode[];
  hours: number;
  lossByNode: Record<string, number>;
  rangeStartMs?: number;
  rangeEndMs?: number;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { resolvedAppearance } = usePreferences();
  const { w, h, ref: chartSizeRef } = useResponsiveChartSize("wide");
  const [connectNulls, setConnectNulls] = useState(false);
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(new Set());
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const isDark = resolvedAppearance === "dark";

  const nodeKeys = useMemo(() => nodes.map((node) => node.uuid), [nodes]);
  const nodeKeySet = useMemo(() => new Set(nodeKeys), [nodeKeys]);
  const nameByUuid = useMemo(
    () => new Map(nodes.map((node) => [node.uuid, node.name || node.uuid] as const)),
    [nodes],
  );
  const nodeColors = useMemo(
    () => new Map(nodes.map((node, index) => [node.uuid, colorForSeries(index, nodes.length)] as const)),
    [nodes],
  );

  // 任务/节点集合变化时清掉隐藏态，避免旧 uuid 污染新图。
  const nodeSignature = nodeKeys.join(",");
  useEffect(() => {
    setHiddenNodes(new Set());
  }, [taskId, hours, nodeSignature]);

  const sortedRecords = useMemo(
    () =>
      records
        .map((record) => ({ record, time: toChartSeconds(record.time) }))
        .filter(({ time }) => time > 0)
        .sort((left, right) => left.time - right.time),
    [records],
  );

  const chartPoints = useMemo(() => {
    if (sortedRecords.length === 0 || nodeKeys.length === 0) return null;
    const detectedInterval = detectTypicalIntervalSeconds(
      sortedRecords.map(({ time }) => time),
      taskInterval ?? 60,
    );
    const fallbackInterval = resolvePingChartInterval(null, taskInterval ?? null, detectedInterval);
    const tolerance = Math.min(6, Math.max(0.8, fallbackInterval * 0.25));
    const gapOptions = {
      intervals: new Map(
        nodeKeys.map((uuid) => {
          const times = sortedRecords
            .filter(({ record }) => record.client === uuid)
            .map(({ time }) => time);
          return [uuid, detectTypicalIntervalSeconds(times, taskInterval ?? 60)] as const;
        }),
      ),
      defaultInterval: fallbackInterval,
      matchToleranceRatio: 0.25,
    };
    return {
      ...alignTaskPingRecords(sortedRecords, nodeKeySet, tolerance),
      gapOptions,
    };
  }, [nodeKeys, nodeKeySet, sortedRecords, taskInterval]);

  const latencyChart = useMemo(() => {
    if (!chartPoints) return null;
    const points = insertMetricGapSentinels(chartPoints.latencyPoints, chartPoints.gapOptions);
    const times = points.map((point) => point.time);
    const perNode = nodeKeys.map((uuid) => points.map((point) => point[uuid]));
    const reduced = downsampleAligned(times, perNode, MAX_RENDER_POINTS, true);
    return [reduced.times, ...reduced.perTask] as uPlot.AlignedData;
  }, [chartPoints, nodeKeys]);

  const chart = latencyChart;

  useEffect(() => {
    if (chart) chartRef.current = chart;
  }, [chart]);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => !hiddenNodes.has(node.uuid)),
    [hiddenNodes, nodes],
  );
  const visibleUuids = useMemo(() => new Set(visibleNodes.map((node) => node.uuid)), [visibleNodes]);

  const latestByNode = useMemo(() => {
    const latest = new Map<string, number | null>();
    for (const { record } of sortedRecords) {
      if (!nodeKeySet.has(record.client)) continue;
      latest.set(record.client, record.value >= 0 ? record.value : null);
    }
    return latest;
  }, [nodeKeySet, sortedRecords]);

  const yRange = useMemo<[number | null, number | null]>(() => {
    if (!chart) return [null, null];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    nodeKeys.forEach((uuid, index) => {
      if (!visibleUuids.has(uuid)) return;
      const series = chart[index + 1] as Array<number | null | undefined> | undefined;
      if (!series) return;
      for (const value of series) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    });
    if (min === Number.POSITIVE_INFINITY) return [0, 100];
    if (min === max) {
      const pad = Math.max(5, min * 0.1);
      return [Math.max(0, min - pad), max + pad];
    }
    const pad = Math.max(5, (max - min) * 0.12);
    return [Math.max(0, min - pad), max + pad];
  }, [chart, nodeKeys, visibleUuids]);

  const requestedXRange = useMemo(
    () => historyChartRangeSeconds({ rangeStartMs, rangeEndMs }),
    [rangeEndMs, rangeStartMs],
  );
  const coverageLabel = useMemo(() => {
    const times = chart?.[0];
    if (!times?.length) return null;
    return historyCoverageLabel(
      { rangeStartMs, rangeEndMs },
      times[0],
      times[times.length - 1],
    );
  }, [chart, rangeEndMs, rangeStartMs]);

  const baseOptions = useMemo<Omit<uPlot.Options, "width" | "height"> | null>(() => {
    if (!chart) return null;
    const { grid, text } = getAxisColors(isDark);
    const tooltipHooks = buildChartTooltipHooks({
      dataRef: chartRef,
      rangeHours: hours,
      estimatedWidth: 196,
      setTooltip,
      buildRows: (idx) =>
        visibleNodes
          .map((node) => {
            const seriesIndex = nodeKeys.indexOf(node.uuid);
            const raw = chartRef.current[seriesIndex + 1]?.[idx] as number | null | undefined;
            return {
              label: nameByUuid.get(node.uuid) ?? node.uuid,
              raw: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
              color: nodeColors.get(node.uuid) ?? colorForSeries(seriesIndex, nodeKeys.length),
            };
          })
          .sort((a, b) => {
            if (a.raw == null) return b.raw == null ? 0 : 1;
            if (b.raw == null) return -1;
            return b.raw - a.raw;
          })
          .map(({ label, raw, color }) => ({
            label,
            value: raw == null ? "—" : `${raw.toFixed(1)} ms`,
            color,
          })),
    });
    return {
      padding: [10, 14, 12, 2],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: requestedXRange
          ? { time: true, auto: false, range: () => requestedXRange }
          : { time: true },
        y: { auto: false, range: yRange },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 36,
          values: createTimeAxisFormatter(hours),
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 54,
          values: (_self, splits) =>
            splits.map((value) =>
              value === 0 ? "" : `${Math.round(value)} ms`,
            ),
        },
      ],
      series: [
        { label: "time" },
        ...nodes.map((node, index) => ({
          label: nameByUuid.get(node.uuid) ?? node.uuid,
          stroke: nodeColors.get(node.uuid) ?? colorForSeries(index, nodes.length),
          width: 1.7,
          spanGaps: connectNulls,
          show: !hiddenNodes.has(node.uuid),
          points: { show: false },
        })),
      ],
      hooks: {
        init: [
          (u) => {
            u.root.setAttribute("role", "img");
            u.root.setAttribute(
              "aria-label",
              `监控任务 ${taskName} 延迟历史图表，共 ${nodes.length} 台节点`,
            );
          },
          tooltipHooks.onInit,
        ],
        destroy: [tooltipHooks.onDestroy],
        setCursor: [tooltipHooks.onSetCursor],
      },
    };
  }, [
    chart,
    connectNulls,
    hiddenNodes,
    hours,
    isDark,
    nameByUuid,
    nodeColors,
    nodeKeys,
    nodes,
    requestedXRange,
    taskName,
    visibleNodes,
    yRange,
  ]);

  const options = useMemo<uPlot.Options | null>(
    () => (baseOptions ? { ...baseOptions, width: w, height: h } : null),
    [baseOptions, w, h],
  );

  const toggleNode = (uuid: string) => {
    setHiddenNodes((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  return (
    <div className="home-task-ping-chart-block">
      <div className="instance-ping-toolbar">
        <SwitchToggle
          label="断点连线"
          active={connectNulls}
          onToggle={() => setConnectNulls((value) => !value)}
          title="关闭：如实显示中断/丢包断点；开启：跨过空缺连成完整曲线。"
        />
        <span className="home-task-ping-coverage" aria-live="polite">
          {coverageLabel ?? ""}
        </span>
        <button
          type="button"
          className="instance-toggle-button"
          onClick={onRefresh}
          disabled={isFetching}
          aria-busy={isFetching}
        >
          <RefreshCw size={14} aria-hidden />
          {isFetching ? "刷新中" : "刷新"}
        </button>
      </div>

      <div className="instance-ping-tasks" data-filtered={hiddenNodes.size > 0 ? "true" : "false"}>
        {nodes.map((node, index) => {
          const selected = !hiddenNodes.has(node.uuid);
          const latest = latestByNode.get(node.uuid);
          const loss = lossByNode[node.uuid];
          const color = nodeColors.get(node.uuid) ?? colorForSeries(index, nodes.length);
          return (
            <button
              key={node.uuid}
              type="button"
              className="instance-ping-task"
              data-selected={selected ? "true" : "false"}
              aria-pressed={selected}
              onClick={() => toggleNode(node.uuid)}
              style={{ borderColor: selected ? color : "var(--border-subtle)" }}
              title={`${nameByUuid.get(node.uuid) ?? node.uuid}\n当前 ${latest != null ? `${latest.toFixed(1)} ms` : "—"} | 窗口丢包 ${formatWindowLoss(loss)}`}
            >
              <div className="instance-ping-task-head">
                <span className="instance-ping-task-name" style={{ color }}>
                  {nameByUuid.get(node.uuid) ?? node.uuid}
                </span>
                <span className="instance-ping-task-primary">
                  {latest != null ? `${latest.toFixed(1)} ms` : "—"}
                </span>
              </div>
              <div className="instance-ping-task-stats">
                <span>窗口丢包 {formatWindowLoss(loss)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div ref={chartSizeRef} className="instance-uplot-wrap is-large">
        {chart && options && visibleNodes.length > 0 ? (
          <>
            <UplotReact
              key={`${taskId}-${hours}-${connectNulls ? "span" : "gap"}`}
              options={options}
              data={chart}
            />
            <ChartTooltip tooltip={tooltip} />
          </>
        ) : (
          <div className="instance-empty">当前没有可显示的节点</div>
        )}
      </div>
    </div>
  );
}
