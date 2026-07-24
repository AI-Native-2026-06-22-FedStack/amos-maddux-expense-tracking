import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult
} from "@tanstack/react-query";
import { useAuthSession } from "../auth";
import type { ExpenseReportStage, Priority, UserRole } from "../domain";
import { useApiClient } from "./useApiClient";

export interface CaseQueueItem {
  currentStage: ExpenseReportStage;
  dueDate: string | null;
  id: string;
  onHold: boolean;
  priority: Priority;
  updatedAt: string;
}

export interface CaseQueueResponse {
  cases: readonly CaseQueueItem[];
}

export type CaseQueueQueryKey = readonly [
  "caseQueue",
  { readonly role: UserRole; readonly tenantId: string }
];

export interface AdvanceCaseQueueInput {
  id: string;
}

export interface UseCaseQueueResult {
  advanceCase: UseMutationResult<CaseQueueItem, Error, AdvanceCaseQueueInput>;
  query: UseQueryResult<CaseQueueResponse, Error>;
  queryKey: CaseQueueQueryKey;
}

interface CaseQueueSnapshot {
  previousQueue: CaseQueueResponse | undefined;
}

export function caseQueueQueryKey(tenantId: string, role: UserRole): CaseQueueQueryKey {
  return ["caseQueue", { tenantId, role }];
}

export function useCaseQueue(): UseCaseQueueResult {
  const apiClient = useApiClient();
  const authSession = useAuthSession();
  const queryClient = useQueryClient();
  const session = authSession.session;
  const tenantId = session?.tenantId ?? "";
  const role = session?.role ?? "Employee";
  const queryKey = caseQueueQueryKey(tenantId, role);

  const query = useQuery({
    enabled: session !== null,
    queryFn: async () =>
      parseCaseQueueResponse(await apiClient.requestJson<unknown>("/expense-reports/case-queue")),
    queryKey
  });

  const advanceCase = useMutation<CaseQueueItem, Error, AdvanceCaseQueueInput, CaseQueueSnapshot>({
    mutationFn: async ({ id }) =>
      parseCaseQueueItem(
        await apiClient.requestJson<unknown>(`/expense-reports/${id}/advance`, {
          body: {
            reason: "Advanced from Case Queue."
          },
          method: "POST"
        })
      ),
    onError: (_error, _input, snapshot) => {
      if (snapshot?.previousQueue !== undefined) {
        queryClient.setQueryData(queryKey, snapshot.previousQueue);
      }
    },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey });

      const previousQueue = queryClient.getQueryData<CaseQueueResponse>(queryKey);
      queryClient.setQueryData<CaseQueueResponse>(queryKey, (currentQueue) =>
        currentQueue === undefined ? currentQueue : optimisticAdvance(currentQueue, id)
      );

      return { previousQueue };
    },
    onSettled: async () => {
      await invalidateCaseQueue(queryClient, queryKey);
    }
  });

  return {
    advanceCase,
    query,
    queryKey
  };
}

export async function invalidateCaseQueue(
  queryClient: QueryClient,
  queryKey: CaseQueueQueryKey
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey });
}

function optimisticAdvance(queue: CaseQueueResponse, id: string): CaseQueueResponse {
  return {
    cases: queue.cases.map((item) =>
      item.id === id ? { ...item, currentStage: nextStage(item.currentStage) } : item
    )
  };
}

function nextStage(stage: ExpenseReportStage): ExpenseReportStage {
  switch (stage) {
    case "Submitted":
      return "Manager Approval";
    case "Manager Approval":
      return "AP Review";
    case "AP Review":
      return "Paid";
    case "Drafted":
    case "Paid":
    case "Reconciled":
      return stage;
    default:
      return stage;
  }
}

function parseCaseQueueResponse(value: unknown): CaseQueueResponse {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error("Case Queue response was not valid.");
  }

  return {
    cases: value.cases.map(parseCaseQueueItem)
  };
}

function parseCaseQueueItem(value: unknown): CaseQueueItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isExpenseReportStage(value.currentStage) ||
    !isPriority(value.priority) ||
    !(typeof value.dueDate === "string" || value.dueDate === null) ||
    typeof value.onHold !== "boolean" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Case Queue item was not valid.");
  }

  return {
    id: value.id,
    currentStage: value.currentStage,
    priority: value.priority,
    dueDate: value.dueDate,
    onHold: value.onHold,
    updatedAt: value.updatedAt
  };
}

function isExpenseReportStage(value: unknown): value is ExpenseReportStage {
  return (
    value === "Drafted" ||
    value === "Submitted" ||
    value === "Manager Approval" ||
    value === "AP Review" ||
    value === "Paid" ||
    value === "Reconciled"
  );
}

function isPriority(value: unknown): value is Priority {
  return value === "Urgent" || value === "High" || value === "Normal" || value === "Low";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
