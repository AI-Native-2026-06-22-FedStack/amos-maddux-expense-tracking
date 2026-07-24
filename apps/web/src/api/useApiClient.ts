import { useMemo } from "react";
import { useAuthSession } from "../auth";
import { createApiClient, type ApiClient } from "./client";

export function useApiClient(): ApiClient {
  const authSession = useAuthSession();

  return useMemo(
    () =>
      createApiClient({
        getAccessToken: authSession.getCurrentAccessToken,
        onRefreshFailed: authSession.logout,
        refreshSession: async () => {
          await authSession.refreshCurrentSession();
        }
      }),
    [authSession.getCurrentAccessToken, authSession.logout, authSession.refreshCurrentSession]
  );
}
