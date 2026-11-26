import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { getMonitorMe, getPublicFromMe } from "./api";

/** Authentication and site metadata share the raw /api/me response. */
export function monitorMeQueryOptions() {
  return queryOptions({
    queryKey: ["me"],
    queryFn: ({ signal }) => getMonitorMe({ signal }),
    staleTime: 30_000,
    // Returning from an admin login tab must still revalidate the session.
    refetchOnWindowFocus: "always" as const,
  });
}

export function publicConfigQueryOptions(client: QueryClient) {
  return queryOptions({
    queryKey: ["public"],
    queryFn: async ({ signal }) => {
      // fetchQuery reuses both fresh data and an ongoing authentication request.
      // Its signal belongs to the shared query, not to this one consumer.
      const me = await client.fetchQuery(monitorMeQueryOptions());
      signal.throwIfAborted();
      return getPublicFromMe(me, { signal });
    },
    staleTime: 60_000,
    refetchInterval: (query) => query.state.data?.theme_settings_error ? 30_000 : false,
  });
}
