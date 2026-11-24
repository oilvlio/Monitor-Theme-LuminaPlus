import { ANOMALY_COLORS } from "./pingAnomalyStrip";

export interface PingAnomalyStat {
  id: number | string;
  label: string;
  color: string;
  valid: number;
  over: number;
}

export function PingAnomalyLegend({
  axisMax,
  stats,
}: {
  axisMax: number;
  stats: readonly PingAnomalyStat[];
}) {
  return (
    <div className="instance-ping-anomaly" aria-label="异常色带图例">
      <div className="instance-ping-anomaly-legend">
        <span>
          <i
            className="instance-ping-anomaly-tick"
            style={{ background: ANOMALY_COLORS.normal }}
            aria-hidden
          />
          正常
        </span>
        {[
          `${axisMax}–${axisMax * 2} ms`,
          `${axisMax * 2}–${axisMax * 5} ms`,
          `> ${axisMax * 5} ms`,
        ].map((label, tier) => (
          <span key={label}>
            <i
              className="instance-ping-anomaly-dot"
              style={{ background: ANOMALY_COLORS.tiers[tier] }}
              aria-hidden
            />
            {label}
          </span>
        ))}
        <span>
          <i className="instance-ping-anomaly-empty" aria-hidden />
          丢包 / 无数据（留空）
        </span>
        <span className="instance-ping-anomaly-note">
          量程 0–{axisMax} ms，超出量程的点不进折线
        </span>
      </div>
      <div className="instance-ping-anomaly-stats">
        {stats.map((stat) => (
          <span key={stat.id}>
            <i
              className="instance-ping-anomaly-dot"
              style={{ background: stat.color }}
              aria-hidden
            />
            {stat.label}：超出量程 {stat.over} 个
            {stat.valid > 0 ? `（${((stat.over / stat.valid) * 100).toFixed(1)}%）` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
