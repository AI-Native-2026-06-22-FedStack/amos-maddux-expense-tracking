import { Badge } from "../atoms/Badge";
import { Button } from "../atoms/Button";
import { EmptyState, ErrorState, LoadingState } from "../atoms/StateMessage";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { ApiProblemError } from "../api";
import { useCaseQueue, type CaseQueueItem } from "../api/useCaseQueue";
import styles from "./CaseQueue.module.css";

const columns: readonly DataTableColumn<CaseQueueItem>[] = [
  {
    header: "Case ID",
    key: "id",
    render: (row) => <span className={styles.caseId}>{row.id}</span>
  },
  {
    header: "Stage",
    key: "currentStage",
    render: (row) => <Badge kind="status" stage={row.currentStage} />
  },
  {
    header: "Priority",
    key: "priority",
    render: (row) => <Badge kind="priority" priority={row.priority} />
  },
  {
    header: "Due Date",
    key: "dueDate",
    render: (row) => (row.dueDate === null ? "Not set" : formatDate(row.dueDate))
  },
  {
    header: "Hold",
    key: "onHold",
    render: (row) => (row.onHold ? <Badge kind="neutral" label="On hold" /> : "Clear")
  },
  {
    header: "Updated",
    key: "updatedAt",
    render: (row) => formatDate(row.updatedAt)
  }
];

export function CaseQueue() {
  const { advanceCase, query } = useCaseQueue();

  if (query.isPending) {
    return (
      <LoadingState
        title="Loading Case Queue"
        message="Retrieving tenant-scoped Expense Report cases."
      />
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Case Queue unavailable"
        message={readErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch(() => undefined);
        }}
        retryLabel="Retry queue"
      />
    );
  }

  if (query.data.cases.length === 0) {
    return (
      <EmptyState
        title="No cases in the queue"
        message="There are no Expense Reports waiting for review in this tenant and role view."
      />
    );
  }

  return (
    <div className={styles.queue}>
      <section className={styles.summary} aria-labelledby="case-queue-title">
        <h2 className={styles.summaryTitle} id="case-queue-title">
          Case / Approval Queue
        </h2>
        <p className={styles.summaryText}>
          {query.data.cases.length} Expense Report case{query.data.cases.length === 1 ? "" : "s"} in
          this scoped view.
        </p>
      </section>
      <DataTable
        actions={
          advanceCase.isPending ? <span className={styles.mutating}>Updating...</span> : null
        }
        columns={[
          ...columns,
          {
            header: "Actions",
            key: "actions",
            render: (row) => (
              <Button
                disabled={advanceCase.isPending}
                onClick={() => advanceCase.mutate({ id: row.id })}
                type="button"
                variant="secondary"
              >
                Advance
              </Button>
            )
          }
        ]}
        getRowKey={(row) => row.id}
        rows={query.data.cases}
        title="Case Queue"
      />
    </div>
  );
}

function readErrorMessage(error: Error): string {
  if (error instanceof ApiProblemError) {
    return error.detail;
  }

  return error.message;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(new Date(value));
}
