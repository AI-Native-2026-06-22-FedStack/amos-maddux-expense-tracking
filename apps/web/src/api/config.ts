const defaultApiBaseUrl = "/v1";

export function getExpenseFlowApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_EXPENSEFLOW_API_BASE_URL;

  if (configuredBaseUrl === undefined || configuredBaseUrl.trim().length === 0) {
    return defaultApiBaseUrl;
  }

  return configuredBaseUrl.trim();
}
