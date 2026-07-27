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
          const refreshedSession = await authSession.refreshCurrentSession();

          return refreshedSession.accessToken;
        }
      }),
    [authSession.getCurrentAccessToken, authSession.logout, authSession.refreshCurrentSession]
  );
}
