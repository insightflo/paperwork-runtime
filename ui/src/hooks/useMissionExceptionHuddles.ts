import { useQuery } from "@tanstack/react-query";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import { api } from "../api/client";

export interface MissionExceptionHuddleItem {
  threadId: string;
  channelId: string;
  title: string;
  updatedAt: string;
  huddle: ExceptionHuddleMetadata;
}

export interface MissionExceptionHuddleCounts {
  open: number;
  timed_out: number;
  decided: number;
  cancelled: number;
}

export interface MissionExceptionHuddlesResponse {
  missionId: string;
  counts: MissionExceptionHuddleCounts;
  items: MissionExceptionHuddleItem[];
}

export function selectActiveExceptionHuddle(
  items: readonly MissionExceptionHuddleItem[],
): MissionExceptionHuddleItem | null {
  let latestTimedOut: MissionExceptionHuddleItem | null = null;
  let latestOpen: MissionExceptionHuddleItem | null = null;

  for (const item of items) {
    if (item.huddle.status === "timed_out") {
      if (!latestTimedOut || new Date(item.updatedAt).getTime() > new Date(latestTimedOut.updatedAt).getTime()) {
        latestTimedOut = item;
      }
    } else if (item.huddle.status === "open") {
      if (!latestOpen || new Date(item.updatedAt).getTime() > new Date(latestOpen.updatedAt).getTime()) {
        latestOpen = item;
      }
    }
  }

  return latestTimedOut ?? latestOpen;
}

export function fetchMissionExceptionHuddles(
  companyId: string,
  missionId: string,
  opts: { status?: ExceptionHuddleMetadata["status"]; limit?: number } = {},
): Promise<MissionExceptionHuddlesResponse> {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set("status", opts.status);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.toString();

  return api.get<MissionExceptionHuddlesResponse>(
    `/companies/${encodeURIComponent(companyId)}/collab-channels/missions/${encodeURIComponent(missionId)}/huddles${query ? `?${query}` : ""}`,
  );
}

export function useMissionExceptionHuddles(
  companyId: string | undefined,
  missionId: string | undefined,
  opts?: {
    status?: ExceptionHuddleMetadata["status"];
    limit?: number;
    enabled?: boolean;
  },
) {
  const query = useQuery({
    queryKey: [
      "mission-exception-huddles",
      companyId,
      missionId,
      opts?.status ?? "all",
      opts?.limit ?? null,
    ],
    queryFn: () =>
      fetchMissionExceptionHuddles(companyId!, missionId!, {
        status: opts?.status,
        limit: opts?.limit,
      }),
    enabled: Boolean(companyId && missionId && (opts?.enabled ?? true)),
  });

  return {
    ...query,
    activeHuddle: selectActiveExceptionHuddle(query.data?.items ?? []),
  };
}
