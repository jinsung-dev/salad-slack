import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { handleUnauthorized } from "./api";
import { App } from "./App";
import { endSession } from "./session";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // Realtime events keep the cache current; refetch only on reconnect.
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
});
handleUnauthorized(() => endSession(queryClient));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
