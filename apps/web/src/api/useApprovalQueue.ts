import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult
} from "@tanstack/react-query";
import { useAuthSession } from "../auth";
import type { ExpenseReportStage, UserRole } from "../domain";
import { useApiClient } from "./useApiClient";

export type ManagerReviewStatus = "pending" | "approved" | "rejected";
export type GlCodingStatus = "mapped" | "unmapped";

export interface ApprovalQueueLineItem {
  amountCents: number;
  category: string;
  createdAt: string;
  currency: string;
  deductible: boolean;
  flagCleared: boolean;
  flagged: boolean;
  glAccountCode: string | null;
  glAccountName: string | null;
  glCodeId: string | null;
  glCodingStatus: GlCodingStatus | null;
  lineItemId: string;
  managerReviewStatus: ManagerReviewStatus;
  merchant: string;
  reportId: string;
  reportStage: ExpenseReportStage;
}

export interface ApprovalQueueResponse {
  lineItems: readonly ApprovalQueueLineItem[];
}

export type ApprovalQueueQueryKey = readonly [
  "approvalQueue",
  { readonly role: UserRole; readonly tenantId: string }
];

export interface LineItemActionInput {
  lineItemId: string;
  reportId: string;
}

export type DeductibleInput = LineItemActionInput & {
  deductible: boolean;
};

export interface SendBackInput {
  reason: string;
  reportId: string;
}

export interface UseApprovalQueueResult {
  approveLineItem: UseMutationResult<
    ApprovalQueueLineItem,
    Error,
    LineItemActionInput,
    QueueSnapshot
  >;
  clearLineItemFlag: UseMutationResult<
    ApprovalQueueLineItem,
    Error,
    LineItemActionInput,
    QueueSnapshot
  >;
  query: UseQueryResult<ApprovalQueueResponse, Error>;
  queryKey: ApprovalQueueQueryKey;
  rejectLineItem: UseMutationResult<
    ApprovalQueueLineItem,
    Error,
    LineItemActionInput,
    QueueSnapshot
  >;
  sendBackReport: UseMutationResult<unknown, Error, SendBackInput, QueueSnapshot>;
  updateDeductible: UseMutationResult<ApprovalQueueLineItem, Error, DeductibleInput, QueueSnapshot>;
}

interface QueueSnapshot {
  previousQueue: ApprovalQueueResponse | undefined;
}

export function approvalQueueQueryKey(tenantId: string, role: UserRole): ApprovalQueueQueryKey {
  return ["approvalQueue", { tenantId, role }];
}

export function useApprovalQueue(): UseApprovalQueueResult {
  const apiClient = useApiClient();
  const authSession = useAuthSession();
  const queryClient = useQueryClient();
  const session = authSession.session;
  const tenantId = session?.tenantId ?? "";
  const role = session?.role ?? "Employee";
  const queryKey = approvalQueueQueryKey(tenantId, role);

  const query = useQuery({
    enabled: session !== null,
    queryFn: async () =>
      parseApprovalQueueResponse(
        await apiClient.requestJson<unknown>("/expense-reports/approval-line-items")
      ),
    queryKey
  });

  const approveLineItem = useLineItemMutation({
    mutationFn: async ({ lineItemId, reportId }) =>
      parseApprovalQueueLineItem(
        await apiClient.requestJson<unknown>(
          `/expense-reports/${reportId}/line-items/${lineItemId}/approve`,
          { method: "POST" }
        )
      ),
    optimisticUpdate: (queue, input) =>
      updateLineItem(queue, input, { managerReviewStatus: "approved" }),
    queryClient,
    queryKey
  });

  const rejectLineItem = useLineItemMutation({
    mutationFn: async ({ lineItemId, reportId }) =>
      parseApprovalQueueLineItem(
        await apiClient.requestJson<unknown>(
          `/expense-reports/${reportId}/line-items/${lineItemId}/reject`,
          { method: "POST" }
        )
      ),
    optimisticUpdate: (queue, input) =>
      updateLineItem(queue, input, { managerReviewStatus: "rejected" }),
    queryClient,
    queryKey
  });

  const clearLineItemFlag = useLineItemMutation({
    mutationFn: async ({ lineItemId, reportId }) =>
      parseApprovalQueueLineItem(
        await apiClient.requestJson<unknown>(
          `/expense-reports/${reportId}/line-items/${lineItemId}/clear-flag`,
          { method: "POST" }
        )
      ),
    optimisticUpdate: (queue, input) => updateLineItem(queue, input, { flagCleared: true }),
    queryClient,
    queryKey
  });

  const updateDeductible = useMutation<
    ApprovalQueueLineItem,
    Error,
    DeductibleInput,
    QueueSnapshot
  >({
    mutationFn: async ({ deductible, lineItemId, reportId }) =>
      parseApprovalQueueLineItem(
        await apiClient.requestJson<unknown>(
          `/expense-reports/${reportId}/line-items/${lineItemId}/deductible`,
          {
            body: { deductible },
            method: "PATCH"
          }
        )
      ),
    onError: (_error, _input, snapshot) => restoreQueue(queryClient, queryKey, snapshot),
    onMutate: async (input) => {
      const previousQueue = await snapshotQueue(queryClient, queryKey);
      queryClient.setQueryData<ApprovalQueueResponse>(queryKey, (currentQueue) =>
        currentQueue === undefined
          ? currentQueue
          : updateLineItem(currentQueue, input, { deductible: input.deductible })
      );

      return { previousQueue };
    },
    onSettled: async () => {
      await invalidateApprovalQueue(queryClient, queryKey);
    }
  });

  const sendBackReport = useMutation<unknown, Error, SendBackInput, QueueSnapshot>({
    mutationFn: async ({ reason, reportId }) =>
      apiClient.requestJson<unknown>(`/expense-reports/${reportId}/reject`, {
        body: { reason },
        method: "POST"
      }),
    onError: (_error, _input, snapshot) => restoreQueue(queryClient, queryKey, snapshot),
    onMutate: async (input) => {
      const previousQueue = await snapshotQueue(queryClient, queryKey);
      queryClient.setQueryData<ApprovalQueueResponse>(queryKey, (currentQueue) =>
        currentQueue === undefined
          ? currentQueue
          : {
              lineItems: currentQueue.lineItems.filter((item) => item.reportId !== input.reportId)
            }
      );

      return { previousQueue };
    },
    onSettled: async () => {
      await invalidateApprovalQueue(queryClient, queryKey);
    }
  });

  return {
    approveLineItem,
    clearLineItemFlag,
    query,
    queryKey,
    rejectLineItem,
    sendBackReport,
    updateDeductible
  };
}

export async function invalidateApprovalQueue(
  queryClient: QueryClient,
  queryKey: ApprovalQueueQueryKey
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey });
}

function useLineItemMutation({
  mutationFn,
  optimisticUpdate,
  queryClient,
  queryKey
}: {
  mutationFn: (input: LineItemActionInput) => Promise<ApprovalQueueLineItem>;
  optimisticUpdate: (
    queue: ApprovalQueueResponse,
    input: LineItemActionInput
  ) => ApprovalQueueResponse;
  queryClient: QueryClient;
  queryKey: ApprovalQueueQueryKey;
}): UseMutationResult<ApprovalQueueLineItem, Error, LineItemActionInput, QueueSnapshot> {
  return useMutation<ApprovalQueueLineItem, Error, LineItemActionInput, QueueSnapshot>({
    mutationFn,
    onError: (_error, _input, snapshot) => restoreQueue(queryClient, queryKey, snapshot),
    onMutate: async (input) => {
      const previousQueue = await snapshotQueue(queryClient, queryKey);
      queryClient.setQueryData<ApprovalQueueResponse>(queryKey, (currentQueue) =>
        currentQueue === undefined ? currentQueue : optimisticUpdate(currentQueue, input)
      );

      return { previousQueue };
    },
    onSettled: async () => {
      await invalidateApprovalQueue(queryClient, queryKey);
    }
  });
}

async function snapshotQueue(
  queryClient: QueryClient,
  queryKey: ApprovalQueueQueryKey
): Promise<ApprovalQueueResponse | undefined> {
  await queryClient.cancelQueries({ queryKey });

  return queryClient.getQueryData<ApprovalQueueResponse>(queryKey);
}

function restoreQueue(
  queryClient: QueryClient,
  queryKey: ApprovalQueueQueryKey,
  snapshot: QueueSnapshot | undefined
): void {
  if (snapshot?.previousQueue !== undefined) {
    queryClient.setQueryData(queryKey, snapshot.previousQueue);
  }
}

function updateLineItem(
  queue: ApprovalQueueResponse,
  input: LineItemActionInput,
  patch: Partial<ApprovalQueueLineItem>
): ApprovalQueueResponse {
  return {
    lineItems: queue.lineItems.map((item) =>
      item.reportId === input.reportId && item.lineItemId === input.lineItemId
        ? { ...item, ...patch }
        : item
    )
  };
}

function parseApprovalQueueResponse(value: unknown): ApprovalQueueResponse {
  if (!isRecord(value) || !Array.isArray(value.lineItems)) {
    throw new Error("Approval Queue response was not valid.");
  }

  return {
    lineItems: value.lineItems.map(parseApprovalQueueLineItem)
  };
}

function parseApprovalQueueLineItem(value: unknown): ApprovalQueueLineItem {
  if (
    !isRecord(value) ||
    typeof value.reportId !== "string" ||
    !isExpenseReportStage(value.reportStage) ||
    typeof value.lineItemId !== "string" ||
    typeof value.merchant !== "string" ||
    typeof value.amountCents !== "number" ||
    typeof value.currency !== "string" ||
    typeof value.category !== "string" ||
    typeof value.flagged !== "boolean" ||
    typeof value.flagCleared !== "boolean" ||
    !isNullableString(value.glAccountCode) ||
    !isNullableString(value.glAccountName) ||
    !isNullableString(value.glCodeId) ||
    !isNullableGlCodingStatus(value.glCodingStatus) ||
    typeof value.deductible !== "boolean" ||
    !isManagerReviewStatus(value.managerReviewStatus) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Approval Queue line item was not valid.");
  }

  return {
    amountCents: value.amountCents,
    category: value.category,
    createdAt: value.createdAt,
    currency: value.currency,
    deductible: value.deductible,
    flagCleared: value.flagCleared,
    flagged: value.flagged,
    glAccountCode: value.glAccountCode,
    glAccountName: value.glAccountName,
    glCodeId: value.glCodeId,
    glCodingStatus: value.glCodingStatus,
    lineItemId: value.lineItemId,
    managerReviewStatus: value.managerReviewStatus,
    merchant: value.merchant,
    reportId: value.reportId,
    reportStage: value.reportStage
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

function isManagerReviewStatus(value: unknown): value is ManagerReviewStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}

function isNullableGlCodingStatus(value: unknown): value is GlCodingStatus | null {
  return value === null || value === "mapped" || value === "unmapped";
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
