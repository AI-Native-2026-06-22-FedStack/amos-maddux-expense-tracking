import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";

export interface AssistRequest {
  question: string;
}

export interface AssistCitation {
  chunk_id: string;
  source: string;
  section_id: string;
  quote: string | null;
}

export interface AssistResponse {
  answer: string;
  citations: AssistCitation[];
}

export function useAssist() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (request: AssistRequest) =>
      apiClient.requestJson<AssistResponse>("/assist", {
        body: request
      })
  });
}
