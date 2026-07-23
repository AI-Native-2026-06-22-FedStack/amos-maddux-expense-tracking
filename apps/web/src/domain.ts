export const expenseReportStages = [
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
] as const;

export type ExpenseReportStage = (typeof expenseReportStages)[number];

export type Priority = "Urgent" | "High" | "Normal" | "Low";

export type UserRole = "Finance Admin" | "Department Manager" | "Employee" | "Platform Admin";
