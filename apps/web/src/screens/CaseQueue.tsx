import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { Badge } from "../atoms/Badge";
import { Button } from "../atoms/Button";
import { EmptyState, ErrorState, LoadingState } from "../atoms/StateMessage";
import { ApiProblemError } from "../api";
import {
  useApprovalQueue,
  type ApprovalQueueLineItem,
  type SendBackInput
} from "../api/useApprovalQueue";
import styles from "./CaseQueue.module.css";

export function CaseQueue() {
  const {
    approveLineItem,
    clearLineItemFlag,
    query,
    rejectLineItem,
    sendBackReport,
    updateDeductible
  } = useApprovalQueue();
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [sendBackDraft, setSendBackDraft] = useState<SendBackInput | null>(null);
  const [sendBackReasonError, setSendBackReasonError] = useState("");
  const mutationError =
    approveLineItem.error ??
    rejectLineItem.error ??
    clearLineItemFlag.error ??
    updateDeductible.error ??
    sendBackReport.error;

  const columns = useMemo<ColumnDef<ApprovalQueueLineItem>[]>(
    () => [
      {
        accessorKey: "merchant",
        cell: (info) => info.getValue(),
        header: "Merchant"
      },
      {
        accessorFn: (row) => row.amountCents,
        cell: (info) => formatCurrency(info.row.original.amountCents, info.row.original.currency),
        header: "Amount",
        id: "amount"
      },
      {
        accessorFn: (row) => glCodeLabel(row),
        cell: (info) => <span>{info.getValue<string>()}</span>,
        header: "GL Code",
        id: "glCode"
      },
      {
        accessorFn: (row) => flagLabel(row),
        cell: (info) => <span>{info.getValue<string>()}</span>,
        header: "Over-$500 Flag",
        id: "flag"
      },
      {
        accessorKey: "managerReviewStatus",
        cell: (info) => reviewStatusLabel(info.getValue<ApprovalQueueLineItem["managerReviewStatus"]>()),
        header: "Review Status"
      },
      {
        accessorKey: "reportStage",
        cell: (info) => <Badge kind="status" stage={info.getValue<ApprovalQueueLineItem["reportStage"]>()} />,
        header: "Stage"
      },
      {
        accessorKey: "deductible",
        cell: (info) => {
          const row = info.row.original;
          const checkboxId = `deductible-${row.lineItemId}`;
          const canEdit = row.reportStage === "AP Review";

          return (
            <div className={styles.checkboxCell}>
              <input
                checked={row.deductible}
                disabled={!canEdit || updateDeductible.isPending}
                id={checkboxId}
                onChange={(event) =>
                  updateDeductible.mutate({
                    deductible: event.currentTarget.checked,
                    lineItemId: row.lineItemId,
                    reportId: row.reportId
                  })
                }
                type="checkbox"
              />
              <label htmlFor={checkboxId}>
                {canEdit ? "Deductible" : "Deductible, read-only outside AP Review"}
              </label>
            </div>
          );
        },
        enableSorting: false,
        header: "Deductible"
      },
      {
        cell: (info) => {
          const row = info.row.original;
          const actionInput = { lineItemId: row.lineItemId, reportId: row.reportId };
          const rowBusy =
            approveLineItem.isPending || rejectLineItem.isPending || clearLineItemFlag.isPending;

          return (
            <div className={styles.rowActions}>
              <Button
                disabled={rowBusy || row.reportStage !== "Manager Approval"}
                onClick={() => approveLineItem.mutate(actionInput)}
                type="button"
                variant="secondary"
              >
                Approve {row.merchant}
              </Button>
              <Button
                disabled={rowBusy || row.reportStage !== "Manager Approval"}
                onClick={() => rejectLineItem.mutate(actionInput)}
                type="button"
                variant="secondary"
              >
                Reject {row.merchant}
              </Button>
              <Button
                disabled={rowBusy || row.reportStage !== "Manager Approval" || !row.flagged || row.flagCleared}
                onClick={() => clearLineItemFlag.mutate(actionInput)}
                type="button"
                variant="secondary"
              >
                Clear flag for {row.merchant}
              </Button>
              <Button
                disabled={sendBackReport.isPending}
                onClick={() => {
                  setSendBackDraft({ reason: "", reportId: row.reportId });
                  setSendBackReasonError("");
                }}
                type="button"
                variant="secondary"
              >
                Send report {shortId(row.reportId)} back
              </Button>
            </div>
          );
        },
        enableSorting: false,
        header: "Actions",
        id: "actions"
      }
    ],
    [
      approveLineItem,
      clearLineItemFlag,
      rejectLineItem,
      sendBackReport.isPending,
      updateDeductible
    ]
  );

  const tableData = useMemo(() => [...(query.data?.lineItems ?? [])], [query.data?.lineItems]);

  const table = useReactTable({
    columns,
    data: tableData,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: approvalQueueGlobalFilter,
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    state: {
      globalFilter,
      sorting
    }
  });

  if (query.isPending) {
    return (
      <LoadingState
        title="Loading Approval Queue"
        message="Retrieving tenant-scoped Expense Report line items."
      />
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Approval Queue unavailable"
        message={readErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch(() => undefined);
        }}
        retryLabel="Retry queue"
      />
    );
  }

  if (query.data.lineItems.length === 0) {
    return (
      <EmptyState
        title="No line items in the queue"
        message="There are no Expense Report line items waiting for review in this tenant view."
      />
    );
  }

  return (
    <div className={styles.queue}>
      <section className={styles.summary} aria-labelledby="approval-queue-title">
        <h2 className={styles.summaryTitle} id="approval-queue-title">
          Approval Queue
        </h2>
        <p className={styles.summaryText}>
          {query.data.lineItems.length} Expense Report line item
          {query.data.lineItems.length === 1 ? "" : "s"} in this scoped view.
        </p>
      </section>

      {mutationError ? (
        <div className={styles.errorBanner} role="alert">
          {readErrorMessage(mutationError)}
        </div>
      ) : null}

      {sendBackDraft ? (
        <form
          className={styles.sendBackForm}
          onSubmit={(event) => {
            event.preventDefault();
            const reason = sendBackDraft.reason.trim();

            if (reason === "") {
              setSendBackReasonError("Enter a reason before sending this report back.");
              return;
            }

            sendBackReport.mutate(
              { reason, reportId: sendBackDraft.reportId },
              {
                onSuccess: () => {
                  setSendBackDraft(null);
                  setSendBackReasonError("");
                }
              }
            );
          }}
        >
          <label htmlFor="send-back-reason">
            Reason for sending report {shortId(sendBackDraft.reportId)} back to Drafted
          </label>
          <textarea
            aria-describedby={sendBackReasonError === "" ? undefined : "send-back-reason-error"}
            id="send-back-reason"
            onChange={(event) => {
              setSendBackDraft({ ...sendBackDraft, reason: event.currentTarget.value });
              setSendBackReasonError("");
            }}
            value={sendBackDraft.reason}
          />
          {sendBackReasonError ? (
            <span className={styles.fieldError} id="send-back-reason-error">
              {sendBackReasonError}
            </span>
          ) : null}
          <div className={styles.formActions}>
            <Button disabled={sendBackReport.isPending} type="submit" variant="primary">
              Send back to Drafted
            </Button>
            <Button
              disabled={sendBackReport.isPending}
              onClick={() => {
                setSendBackDraft(null);
                setSendBackReasonError("");
              }}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <section className={styles.tableContainer} aria-labelledby="approval-queue-table-title">
        <div className={styles.tableHeader}>
          <h3 className={styles.tableTitle} id="approval-queue-table-title">
            Line Items
          </h3>
          <label className={styles.filterLabel} htmlFor="approval-queue-filter">
            Filter line items
          </label>
          <input
            id="approval-queue-filter"
            onChange={(event) => setGlobalFilter(event.currentTarget.value)}
            type="search"
            value={globalFilter}
          />
        </div>

        <table className={styles.table}>
          <caption className={styles.tableCaption}>
            Department Manager approval line items
          </caption>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    aria-sort={sortStateForHeader(header.column.getIsSorted())}
                    key={header.id}
                    scope="col"
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        className={styles.sortButton}
                        onClick={header.column.getToggleSortingHandler()}
                        type="button"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className={styles.pagination} aria-label="Approval Queue pagination">
          <Button
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            type="button"
            variant="secondary"
          >
            Previous page
          </Button>
          <span aria-live="polite">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <Button
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            type="button"
            variant="secondary"
          >
            Next page
          </Button>
        </div>
      </section>
    </div>
  );
}

function approvalQueueGlobalFilter(
  row: { original: ApprovalQueueLineItem },
  _columnId: string,
  filterValue: unknown
): boolean {
  const filter = typeof filterValue === "string" ? filterValue.trim().toLowerCase() : "";

  if (filter === "") {
    return true;
  }

  const item = row.original;
  const haystack = [
    item.merchant,
    item.reportId,
    item.glAccountCode,
    item.glAccountName,
    item.glCodeId,
    item.category
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return haystack.includes(filter);
}

function sortStateForHeader(sortState: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  if (sortState === "asc") {
    return "ascending";
  }

  if (sortState === "desc") {
    return "descending";
  }

  return "none";
}

function glCodeLabel(row: ApprovalQueueLineItem): string {
  if (row.glAccountCode !== null && row.glAccountName !== null) {
    return `${row.glAccountCode} - ${row.glAccountName}`;
  }

  if (row.glCodingStatus === "unmapped") {
    return "Unmapped";
  }

  return "Not coded";
}

function flagLabel(row: ApprovalQueueLineItem): string {
  if (!row.flagged) {
    return "No over-$500 flag";
  }

  return row.flagCleared ? "Flag cleared" : "Flagged over $500";
}

function reviewStatusLabel(status: ApprovalQueueLineItem["managerReviewStatus"]): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "pending":
      return "Pending";
    default:
      return "Pending";
  }
}

function readErrorMessage(error: Error): string {
  if (error instanceof ApiProblemError) {
    return error.detail;
  }

  return error.message;
}

function formatCurrency(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    currency,
    style: "currency"
  }).format(amountCents / 100);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
