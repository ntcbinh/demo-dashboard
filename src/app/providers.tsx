"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StreamProvider } from "@/features/live/stream-provider";

/**
 * Client providers.
 *
 * The `QueryClient` is created in state rather than at module scope so it is
 * never shared between requests on the server, and never recreated by a
 * re-render on the client.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The sensor catalog is immutable and the history dataset is fixed
            // for the life of the server process, so refetching on every
            // window focus would be pure noise.
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <StreamProvider>{children}</StreamProvider>
    </QueryClientProvider>
  );
}
