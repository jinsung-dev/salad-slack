import { createContext, useContext, type ReactNode } from "react";
import type { Workspace } from "@chatter/shared";

// The workspace the current screen belongs to; every workspace view sits under /w/:workspaceId.

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  return <WorkspaceContext value={workspace}>{children}</WorkspaceContext>;
}

export function useCurrentWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useCurrentWorkspace outside a workspace route");
  return workspace;
}

export const workspacePath = (workspaceId: string, rest = "") => `/w/${workspaceId}${rest}`;

const LAST_KEY = "chatter:last-workspace";
export const rememberWorkspace = (id: string) => {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // Private windows may refuse storage; the first workspace is used instead.
  }
};
export const lastWorkspace = (): string | null => {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};
