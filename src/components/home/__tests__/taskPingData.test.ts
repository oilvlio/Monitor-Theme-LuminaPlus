import { describe, expect, it } from "vitest";
import { alignTaskPingRecords } from "@/components/home/taskPingData";
import type { PingRecord } from "@/types/models";

function record(client: string, time: number, value: number, extra?: Partial<PingRecord>): PingRecord {
  return { task_id: 7, time, value, client, count: 1, ...extra };
}

describe("alignTaskPingRecords", () => {
  it("按节点分线并把邻近采样收到同一锚点", () => {
    const out = alignTaskPingRecords(
      [
        { record: record("a", 1000, 10), time: 1000 },
        { record: record("b", 1001, 20), time: 1001 },
        { record: record("a", 2000, 30), time: 2000 },
      ],
      new Set(["a", "b"]),
      5,
    );
    expect(out.latencyPoints).toHaveLength(2);
    expect(out.latencyPoints[0]).toMatchObject({ time: 1000, a: 10, b: 20 });
    expect(out.latencyPoints[1]).toMatchObject({ time: 2000, a: 30 });
  });

  it("丢包记为 null 延迟并按样本数合并丢包率", () => {
    const out = alignTaskPingRecords(
      [
        { record: record("a", 1000, -1, { loss: 100 }), time: 1000 },
        { record: record("a", 1000, 40, { loss: 0 }), time: 1000 },
      ],
      new Set(["a"]),
      5,
    );
    expect(out.latencyPoints).toHaveLength(1);
    // 同一锚点后一条覆盖延迟，但丢包率按权重合并而非覆盖。
    expect(out.latencyPoints[0]).toMatchObject({ a: 40 });
    expect(out.lossPoints[0]?.a).toBeCloseTo(50, 5);
  });

  it("忽略未选中的节点", () => {
    const out = alignTaskPingRecords(
      [{ record: record("zzz", 1000, 10), time: 1000 }],
      new Set(["a"]),
      5,
    );
    expect(out.latencyPoints).toHaveLength(0);
  });
});
