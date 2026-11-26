import { useQuery, useQueryClient } from "@tanstack/react-query";
import { publicConfigQueryOptions } from "@/services/siteQueries";

export function usePublicConfig() {
  const client = useQueryClient();
  return useQuery(publicConfigQueryOptions(client));
}
