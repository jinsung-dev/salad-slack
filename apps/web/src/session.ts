import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./cache";

/**
 * Single owner of "the session is over": signed out here, in another tab, or
 * expired. Clearing `me` first switches App to the sign-in screen, which
 * unmounts every view and the socket; only then is per-user data dropped, so
 * nothing re-renders with or refetches the previous user's state.
 */
export function endSession(qc: QueryClient) {
  qc.setQueryData(keys.me, null);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.me[0] });
}
