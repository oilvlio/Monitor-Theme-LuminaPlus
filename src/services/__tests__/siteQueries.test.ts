import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorMeToAuth } from "../api";
import { monitorMeQueryOptions, publicConfigQueryOptions } from "../siteQueries";

const clients: QueryClient[] = [];
const unsubscribers: Array<() => void> = [];

function createClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}

afterEach(() => {
  unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe("shared site queries", () => {
  it.each(["auth-first", "config-first"])(
    "requests /api/me only once during concurrent homepage subscriptions (%s)",
    async (order) => {
      const client = createClient();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
        JSON.stringify(String(input) === "/api/me"
          ? { authed: true, public_page: true, site_name: "Fleet", history_days: 30 }
          : { showGroupTabs: false }),
      ));
      vi.stubGlobal("fetch", fetchMock);
      const auth = new QueryObserver(client, {
        ...monitorMeQueryOptions(), select: monitorMeToAuth,
      });
      const config = new QueryObserver(client, publicConfigQueryOptions(client));
      if (order === "auth-first") {
        unsubscribers.push(auth.subscribe(() => {}), config.subscribe(() => {}));
      } else {
        unsubscribers.push(config.subscribe(() => {}), auth.subscribe(() => {}));
      }
      await client.fetchQuery(publicConfigQueryOptions(client));

      expect(auth.getCurrentResult().data?.logged_in).toBe(true);
      expect(config.getCurrentResult().data).toMatchObject({
        sitename: "Fleet", metric_retention_days: 30,
        theme_settings: { showGroupTabs: false },
      });
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "/api/me", "/api/themes/LuminaPlus/config",
      ]);
    },
  );

  it("reuses fresh session metadata when only configuration is refreshed", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(String(input) === "/api/me"
        ? { authed: false, public_page: true, site_name: "Fleet" } : {}),
    ));
    vi.stubGlobal("fetch", fetchMock);
    await client.fetchQuery(monitorMeQueryOptions());
    await client.fetchQuery(publicConfigQueryOptions(client));
    await client.invalidateQueries({ queryKey: ["public"] });
    await client.fetchQuery(publicConfigQueryOptions(client));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/me")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not request protected settings for a private anonymous visitor", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      authed: false, public_page: false, site_name: "Private fleet",
    })));
    vi.stubGlobal("fetch", fetchMock);
    const config = await client.fetchQuery(publicConfigQueryOptions(client));
    expect(config).toMatchObject({ private_site: true, theme_settings: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates a changed session and uses the refreshed data for private settings", async () => {
    const client = createClient();
    let authed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(String(input) === "/api/me"
        ? { authed, public_page: false } : { showGroupTabs: false }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    await client.fetchQuery(publicConfigQueryOptions(client));
    authed = true;
    await client.invalidateQueries({ queryKey: ["me"] });
    const me = await client.fetchQuery(monitorMeQueryOptions());
    expect(monitorMeToAuth(me).logged_in).toBe(true);
    await client.invalidateQueries({ queryKey: ["public"] });
    expect(await client.fetchQuery(publicConfigQueryOptions(client))).toMatchObject({
      private_site: true, theme_settings: { showGroupTabs: false },
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/me")).toHaveLength(2);
    expect(monitorMeQueryOptions().refetchOnWindowFocus).toBe("always");
  });

  it("preserves metadata errors instead of loading settings without access checks", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.fetchQuery(publicConfigQueryOptions(client))).rejects.toMatchObject({
      status: 503, path: "/api/me",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels configuration loading without aborting the shared authentication request", async () => {
    const client = createClient();
    let resolveMe!: (response: Response) => void;
    let meSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      meSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveMe = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const configPromise = client.fetchQuery(publicConfigQueryOptions(client));
    const rejected = expect(configPromise).rejects.toBeDefined();
    const authPromise = client.fetchQuery(monitorMeQueryOptions());
    await client.cancelQueries({ queryKey: ["public"] });
    expect(meSignal?.aborted).toBe(false);
    resolveMe(new Response(JSON.stringify({ authed: true, public_page: true })));
    expect(monitorMeToAuth(await authPromise).logged_in).toBe(true);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
