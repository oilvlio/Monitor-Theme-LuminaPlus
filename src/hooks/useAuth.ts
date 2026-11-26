import { useQuery } from "@tanstack/react-query";
import { monitorMeToAuth } from "@/services/api";
import { monitorMeQueryOptions } from "@/services/siteQueries";

export function useAuth() {
  return useQuery({
    ...monitorMeQueryOptions(),
    select: monitorMeToAuth,
  });
}
