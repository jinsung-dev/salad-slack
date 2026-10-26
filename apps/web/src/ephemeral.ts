import { useSyncExternalStore } from "react";
import type { EphemeralMessage } from "@chatter/shared";

// Messages shown to this person only (command replies, errors). Never stored
// on the server, so they live here until dismissed or the page reloads.

let messages: EphemeralMessage[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function addEphemeral(message: EphemeralMessage) {
  messages = [...messages, message];
  notify();
}

export function dismissEphemeral(id: string) {
  messages = messages.filter((m) => m.id !== id);
  notify();
}

export function useEphemeral(channelId: string, parentId: number | null): EphemeralMessage[] {
  const all = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => messages,
  );
  return all.filter((m) => m.channelId === channelId && m.parentId === parentId);
}
