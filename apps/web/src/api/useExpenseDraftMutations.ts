import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { z } from "zod";
import {
  createExpenseDraftExpenseReportRequestSchema,
  createMileageDraftExpenseReportRequestSchema
} from "@expenseflow/shared-schemas";
import { useAuthSession } from "../auth";
import type { ExpenseReportStage, Priority, UserRole } from "../domain";
import { caseQueueQueryKey, invalidateCaseQueue } from "./useCaseQueue";
import { useApiClient } from "./useApiClient";

export type MileageDraftFormValues = z.infer<typeof createMileageDraftExpenseReportRequestSchema>;
export type ExpenseDraftFormValues = z.infer<typeof createExpenseDraftExpenseReportRequestSchema>;

export interface ExpenseReportResponse {
  currentStage: ExpenseReportStage;
  dueDate: string | null;
  id: string;
  priority: Priority;
  tenantId: string;
  updatedAt: string;
}

export interface ExpenseDraftMutations {
  createExpenseDraft: UseMutationResult<ExpenseReportResponse, Error, ExpenseDraftFormValues>;
  createMileageDraft: UseMutationResult<ExpenseReportResponse, Error, MileageDraftFormValues>;
}

export function useExpenseDraftMutations(): ExpenseDraftMutations {
  const apiClient = useApiClient();
  const authSession = useAuthSession();
  const queryClient = useQueryClient();
  const session = authSession.session;
  const tenantId = session?.tenantId ?? "";
  const role: UserRole = session?.role ?? "Employee";
  const queryKey = caseQueueQueryKey(tenantId, role);

  const createMileageDraft = useMutation<ExpenseReportResponse, Error, MileageDraftFormValues>({
    mutationFn: async (values) =>
      parseExpenseReportResponse(
        await apiClient.requestJson<unknown>("/expense-reports", {
          body: values,
          method: "POST"
        })
      ),
    onSuccess: async () => {
      await invalidateCaseQueue(queryClient, queryKey);
    }
  });

  const createExpenseDraft = useMutation<ExpenseReportResponse, Error, ExpenseDraftFormValues>({
    mutationFn: async (values) =>
      parseExpenseReportResponse(
        await apiClient.requestJson<unknown>("/expense-reports", {
          body: values,
          method: "POST"
        })
      ),
    onSuccess: async () => {
      await invalidateCaseQueue(queryClient, queryKey);
    }
  });

  return {
    createExpenseDraft,
    createMileageDraft
  };
}

function parseExpenseReportResponse(value: unknown): ExpenseReportResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.tenantId !== "string" ||
    !isExpenseReportStage(value.currentStage) ||
    !isPriority(value.priority) ||
    !(typeof value.dueDate === "string" || value.dueDate === null) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Expense Report response was not valid.");
  }

  return {
    currentStage: value.currentStage,
    dueDate: value.dueDate,
    id: value.id,
    priority: value.priority,
    tenantId: value.tenantId,
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
