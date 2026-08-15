import { api } from "./client";

export type ChannelProvider = "teams" | "slack" | "gchat";
export type ChannelEvent = "critical" | "alert" | "monitor" | "budget" | "inactive";
export type ChannelStatus = "active" | "paused" | "fail";

export type NotificationChannel = {
  id: number;
  name: string;
  provider: ChannelProvider;
  destination?: string | null;
  webhook_masked: string;
  events: ChannelEvent[];
  team_id?: number | null;
  team_name?: string | null;
  is_active: boolean;
  status: ChannelStatus;
  last_delivery_at?: string | null;
  last_ok?: boolean | null;
};

export type ChannelsResponse = {
  channels: NotificationChannel[];
  kpis: {
    active: number;
    total: number;
    providers: number;
    failures_24h: number;
    delivered_today: number;
  };
};

export type ChannelPayload = {
  name: string;
  provider: ChannelProvider;
  webhook?: string;
  events: ChannelEvent[];
  team_id: number | null;
  clear_team?: boolean;
  is_active: boolean;
};

export function getChannels() {
  return api<ChannelsResponse>("/api/channels");
}

export function createChannel(payload: ChannelPayload & { webhook: string }) {
  return api<{ ok: true; id: number }>("/api/channels", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateChannel(id: number, payload: ChannelPayload) {
  return api<{ ok: true }>(`/api/channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function testSavedChannel(id: number) {
  return api<{ ok: true; message: string }>(`/api/channels/${id}/test`, {
    method: "POST",
  });
}

export function testDraftChannel(payload: {
  name: string;
  provider: ChannelProvider;
  webhook: string;
}) {
  return api<{ ok: true; message: string }>("/api/channels/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
