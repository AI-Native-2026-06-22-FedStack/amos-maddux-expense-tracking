import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { AuthSessionProvider } from "./auth";
import { createExpenseFlowRouter, ExpenseFlowRouterProvider } from "./routes/router";

const queryClient = new QueryClient();

export function App() {
  const router = useMemo(() => createExpenseFlowRouter(queryClient), []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthSessionProvider>
        <ExpenseFlowRouterProvider router={router} />
      </AuthSessionProvider>
    </QueryClientProvider>
  );
}
