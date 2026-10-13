import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { getPingOverview } from "@/services/api";
import { useAllNodeMeta } from "@/hooks/useNode";
import { Spinner } from "@/components/ui/Spinner";
import type { TaskPingNode } from "./HomeTaskPingChart";

const HomeTaskPingChart = lazy(() =>
  import("./HomeTaskPingChart").then((module) => ({ default: module.HomeTaskPingChart })),
);

/** 按监控任务聚合多节点延迟曲线的时间档，与详情页 Ping 图保持一致。 */
const TASK_PING_RANGES = [
  { label: "1 小时", value: 1 },
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "7 天", value: 168 },
] as const;
const DEFAULT_TASK_PING_HOURS = 4;

function formatRangeLabel(hours: number) {
  return TASK_PING_RANGES.find((range) => range.value === hours)?.label ?? `${hours} 小时`;
}

/** 对比集合直接取下方卡片区当前显示的节点，不再另设一份节点复选。 */
export function HomeTaskPingPanel({ nodeUuids }: { nodeUuids: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [hours, setHours] = useState<number>(DEFAULT_TASK_PING_HOURS);
  const allMeta = useAllNodeMeta();

  const nameByUuid = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of allMeta) map.set(node.uuid, node.name?.trim() || node.uuid);
    return map;
  }, [allMeta]);

  // 先选任务：一次请求拉全选中节点的全部任务，任务切换只做本地过滤不发请求；
  // 改时间或下方卡片集合变化才重新请求。折叠时不产生任何历史请求。
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  useEffect(() => {
    if (!expanded) {
      setSelectedTaskId(null);
    }
  }, [expanded]);

  const selectKey = useMemo(() => [...nodeUuids].sort().join(","), [nodeUuids]);

  const overviewQuery = useQuery({
    queryKey: ["home-task-ping", hours, selectKey],
    queryFn: ({ signal }) =>
      getPingOverview(hours, undefined, {
        signal,
        entityIds: nodeUuids,
      }),
    enabled: expanded && nodeUuids.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
  const { refetch: refetchOverview } = overviewQuery;
  const handleRefresh = useCallback(() => {
    void refetchOverview();
  }, [refetchOverview]);

  const tasks = useMemo(
    () => [...(overviewQuery.data?.tasks ?? [])].sort((a, b) => a.id - b.id),
    [overviewQuery.data],
  );

  useEffect(() => {
    if (tasks.length === 0) return;
    setSelectedTaskId((prev) =>
      prev != null && tasks.some((task) => task.id === prev) ? prev : tasks[0].id,
    );
  }, [tasks]);

  const activeTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const taskRecords = useMemo(
    () =>
      selectedTaskId == null
        ? []
        : (overviewQuery.data?.records ?? []).filter((record) => record.task_id === selectedTaskId),
    [overviewQuery.data, selectedTaskId],
  );

  // 传给图表的节点数组必须引用稳定：uplot-react 对 options 做浅比较，任何新数组
  // 都会级联出新的 options/data 并触发整图 destroy + create（重画闪烁）。
  // 下面 memo 的依赖在无实质变化时引用不变，因此平时不会重算、不触发重画。
  const chartNodes: TaskPingNode[] = useMemo(() => {
    const successful = new Set(overviewQuery.data?.successfulEntityIds ?? []);
    return nodeUuids
      .filter((uuid) => successful.size === 0 || successful.has(uuid))
      .map((uuid) => ({ uuid, name: nameByUuid.get(uuid) ?? uuid }));
  }, [overviewQuery.data, nodeUuids, nameByUuid]);
  const visibleChartNodes = useMemo(
    () => chartNodes.filter((node) => taskRecords.some((record) => record.client === node.uuid)),
    [chartNodes, taskRecords],
  );

  const lossByNode = useMemo(() => {
    if (selectedTaskId == null) return {};
    const result: Record<string, number> = {};
    const table = overviewQuery.data?.clientWindowLoss ?? {};
    for (const [uuid, losses] of Object.entries(table)) {
      const loss = losses[selectedTaskId];
      if (typeof loss === "number" && Number.isFinite(loss)) result[uuid] = loss;
    }
    return result;
  }, [overviewQuery.data, selectedTaskId]);
  const failedCount = overviewQuery.data?.failedEntityIds?.length ?? 0;

  return (
    <section className="home-task-ping" aria-label="监控任务延迟对比">
      <button
        type="button"
        className="home-task-ping-head"
        aria-expanded={expanded}
        aria-controls="home-task-ping-body"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="home-task-ping-title">监控任务延迟对比</span>
        <span className="home-task-ping-sub">
          按监控任务聚合多节点 · {formatRangeLabel(hours)} · {expanded ? "收起" : "展开"}
        </span>
        <ChevronDown
          size={16}
          aria-hidden
          className="home-task-ping-chevron"
          data-expanded={expanded ? "true" : "false"}
        />
      </button>

      {expanded && (
        <div id="home-task-ping-body" className="home-task-ping-body">
          {nodeUuids.length === 0 ? (
            <div className="home-task-ping-empty">暂无可见节点</div>
          ) : (
            <>
              <div className="home-task-ping-controls">
                <div
                  className="instance-segmented is-scrollable"
                  role="group"
                  aria-label="选择时间范围"
                >
                  {TASK_PING_RANGES.map((range) => (
                    <button
                      key={range.value}
                      type="button"
                      data-active={hours === range.value ? "true" : "false"}
                      aria-pressed={hours === range.value}
                      onClick={() => setHours(range.value)}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
                <label className="home-task-ping-field">
                  <span>监控任务</span>
                  <select
                    value={selectedTaskId ?? ""}
                    disabled={overviewQuery.isLoading || tasks.length === 0}
                    onChange={(event) => setSelectedTaskId(Number(event.target.value))}
                    aria-label="选择监控任务"
                  >
                    {tasks.length === 0 && <option value="">加载中…</option>}
                    {tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.name || `任务 #${task.id}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="home-task-ping-actions">
                  <button
                    type="button"
                    className="instance-toggle-button"
                    onClick={handleRefresh}
                    disabled={overviewQuery.isFetching}
                    aria-busy={overviewQuery.isFetching}
                  >
                    {overviewQuery.isFetching ? "刷新中" : "刷新"}
                  </button>
                </div>
              </div>
              <p className="home-task-ping-hint" aria-live="polite">
                对比下方卡片区共 {nodeUuids.length} 台节点
                {failedCount > 0 ? ` · 其中 ${failedCount} 台加载失败` : ""}
              </p>

              {overviewQuery.isLoading ? (
                <div className="home-task-ping-empty" aria-busy>
                  <Spinner size={22} label="" />
                  <span>延迟历史加载中…</span>
                </div>
              ) : overviewQuery.isError ? (
                <div className="home-task-ping-empty">
                  <span>延迟历史加载失败</span>
                  <button
                    type="button"
                    className="instance-toggle-button"
                    onClick={handleRefresh}
                    disabled={overviewQuery.isFetching}
                    aria-busy={overviewQuery.isFetching}
                  >
                    {overviewQuery.isFetching ? "重试中" : "重试"}
                  </button>
                </div>
              ) : activeTask == null ? (
                <div className="home-task-ping-empty">所选节点暂无监控任务</div>
              ) : taskRecords.length === 0 ? (
                <div className="home-task-ping-empty">
                  该任务在{formatRangeLabel(hours)}内暂无数据
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="home-task-ping-empty" aria-busy>
                      <Spinner size={22} label="" />
                      <span>图表加载中…</span>
                    </div>
                  }
                >
                  <HomeTaskPingChart
                    taskId={activeTask.id}
                    taskName={activeTask.name || `任务 #${activeTask.id}`}
                    taskInterval={activeTask.interval}
                    records={taskRecords}
                    nodes={visibleChartNodes}
                    hours={hours}
                    lossByNode={lossByNode}
                    rangeStartMs={overviewQuery.data?.rangeStartMs}
                    rangeEndMs={overviewQuery.data?.rangeEndMs}
                    isFetching={overviewQuery.isFetching}
                    onRefresh={handleRefresh}
                  />
                </Suspense>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
