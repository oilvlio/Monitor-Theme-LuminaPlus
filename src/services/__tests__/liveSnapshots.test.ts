import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class LiveSocket {
  static OPEN = 1;
  static instances: LiveSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { LiveSocket.instances.push(this); }
  frame(nodes: unknown[]) { this.onmessage?.({ data: JSON.stringify({ nodes }) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function node(cpu = 10) {
  return {
    id: 1, name: "fixture", public: true, online: true, last_seen: Math.floor(Date.now() / 1000),
    mem_total: 100, swap_total: 0, disk_total: 100,
    metrics: { cpu, uptime: cpu, mem_total: 100, mem_used: 10, disk_total: 100, disk_used: 10,
      load: [0, 0, 0], net_rx: 1, net_tx: 2, total_rx: 100, total_tx: 200 },
  };
}

describe("live snapshot delivery", () => {
  let events: EventTarget;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T00:00:00Z"));
    LiveSocket.instances = [];
    events = new EventTarget();
    vi.stubGlobal("WebSocket", LiveSocket);
    vi.stubGlobal("window", {
      location: { protocol: "https:", host: "fixture.test" },
      setTimeout, clearTimeout, setInterval, clearInterval,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [node()] })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function settle() { await vi.advanceTimersByTimeAsync(0); }

  it("applies WS metrics immediately between timer ticks without an HTTP request", async () => {
    const store = await import("@/services/wsStore");
    const stop = store.retainStore();
    await settle();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(123);
    LiveSocket.instances[0].frame([node(42)]);
    await settle();
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    stop(); await settle();
    LiveSocket.instances[0].frame([node(87)]);
    await settle();
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(42);
  });

  it("defers WS updates while scrolling and applies the latest frame on scroll idle", async () => {
    const store = await import("@/services/wsStore");
    const stop = store.retainStore(); await settle();
    events.dispatchEvent(new Event("scroll"));
    LiveSocket.instances[0].frame([node(42)]);
    LiveSocket.instances[0].frame([node(55)]);
    await settle();
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(10);
    await vi.advanceTimersByTimeAsync(160);
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(55);
    stop(); await settle();
  });

  it("falls back to HTTP when frames stop and resumes immediate WS updates", async () => {
    const store = await import("@/services/wsStore");
    const stop = store.retainStore(); await settle();
    LiveSocket.instances[0].frame([node(42)]); await settle();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    LiveSocket.instances[0].frame([node(63)]); await settle();
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(63);
    stop(); await settle();
  });

  it("does not let an older HTTP response overwrite a WS snapshot", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const api = await import("@/services/api");
    const request = api.getNodes();
    LiveSocket.instances[0].frame([node(72)]);
    finish(new Response(JSON.stringify({ nodes: [node(10)] })));
    await request;
    expect(await api.getNodesLatestStatus(["1"])).toMatchObject({ "1": { cpu: { usage: 72 } } });
  });

  it("renders a WS snapshot while the initial HTTP request is still pending", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const store = await import("@/services/wsStore");
    const stop = store.retainStore();
    LiveSocket.instances[0].frame([node(81)]);
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(81);
    finish(new Response(JSON.stringify({ nodes: [node(10)] })));
    await settle();
    expect(store.getNodeMetricsSnapshot("1")?.cpuPct).toBe(81);
    stop(); await settle();
  });

  it("reconciles added/removed nodes from WS without waiting for metadata polling", async () => {
    const store = await import("@/services/wsStore");
    const stop = store.retainStore(); await settle();
    LiveSocket.instances[0].frame([{ ...node(25), id: 2 }]); await settle();
    expect(store.getAllNodeMetaSnapshot().map(n => n.uuid)).toEqual(["2"]);
    expect(store.getNodeMetricsSnapshot("2")?.cpuPct).toBe(25);
    LiveSocket.instances[0].frame([]); await settle();
    expect(store.getAllNodeMetaSnapshot()).toEqual([]);
    stop(); await settle();
  });
});
