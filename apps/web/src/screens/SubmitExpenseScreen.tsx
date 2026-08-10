import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldError } from "react-hook-form";
import { createExpenseDraftExpenseReportRequestSchema } from "@expenseflow/shared-schemas";
import { Button } from "../atoms/Button";
import { ApiProblemError } from "../api";
import {
  type ExpenseDraftFormValues,
  useExpenseDraftMutations
} from "../api/useExpenseDraftMutations";
import styles from "./ExpenseWriteForms.module.css";

export function SubmitExpenseScreen() {
  const { createExpenseDraft } = useExpenseDraftMutations();
  const {
    formState: { errors },
    handleSubmit,
    register
  } = useForm<ExpenseDraftFormValues>({
    defaultValues: {
      draftType: "expense",
      lineItems: [
        {
          amount_cents: 0,
          category: "",
          currency: "USD",
          merchant: "",
          receipt: {
            amount_cents: 0,
            currency: "USD",
            merchant: "",
            receipt_date: ""
          }
        }
      ],
      priority: "Normal"
    },
    resolver: zodResolver(createExpenseDraftExpenseReportRequestSchema)
  });

  const lineItemErrors = errors.lineItems?.[0];
  const receiptErrors = lineItemErrors?.receipt;

  return (
    <div className={styles.formScreen}>
      <section className={styles.summary} aria-labelledby="submit-expense-title">
        <h2 className={styles.title} id="submit-expense-title">
          Submit Expense
        </h2>
        <p className={styles.summaryText}>
          Create a Drafted Expense Report with one line item and receipt metadata.
        </p>
      </section>

      <form
        className={styles.form}
        onSubmit={(event) => {
          handleSubmit((values) => createExpenseDraft.mutate(values))(event).catch(() => undefined);
        }}
      >
        <input type="hidden" {...register("draftType")} />
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Report</legend>
          <div className={styles.grid}>
            <Field
              error={errors.priority}
              id="expense-priority"
              label="Priority"
              render={(describedBy) => (
                <select
                  className={styles.select}
                  id="expense-priority"
                  aria-describedby={describedBy}
                  {...register("priority")}
                >
                  <option value="Low">Low</option>
                  <option value="Normal">Normal</option>
                  <option value="High">High</option>
                  <option value="Urgent">Urgent</option>
                </select>
              )}
            />
            <Field
              error={errors.dueDate}
              id="expense-due-date"
              label="Due date"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="expense-due-date"
                  type="date"
                  aria-describedby={describedBy}
                  {...register("dueDate")}
                />
              )}
            />
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Line item</legend>
          <div className={styles.grid}>
            <Field
              error={lineItemErrors?.merchant}
              id="expense-merchant"
              label="Merchant"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="expense-merchant"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.merchant")}
                />
              )}
            />
            <Field
              error={lineItemErrors?.amount_cents}
              id="expense-amount-cents"
              label="Amount in cents"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="expense-amount-cents"
                  type="number"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.amount_cents")}
                />
              )}
            />
            <Field
              error={lineItemErrors?.currency}
              id="expense-currency"
              label="Currency"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="expense-currency"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.currency")}
                />
              )}
            />
            <Field
              error={lineItemErrors?.category}
              id="expense-category"
              label="Category"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="expense-category"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.category")}
                />
              )}
            />
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Receipt</legend>
          <div className={styles.grid}>
            <Field
              error={receiptErrors?.merchant}
              id="receipt-merchant"
              label="Receipt merchant"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="receipt-merchant"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.receipt.merchant")}
                />
              )}
            />
            <Field
              error={receiptErrors?.amount_cents}
              id="receipt-amount-cents"
              label="Receipt amount in cents"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="receipt-amount-cents"
                  type="number"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.receipt.amount_cents")}
                />
              )}
            />
            <Field
              error={receiptErrors?.currency}
              id="receipt-currency"
              label="Receipt currency"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="receipt-currency"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.receipt.currency")}
                />
              )}
            />
            <Field
              error={receiptErrors?.receipt_date}
              id="receipt-date"
              label="Receipt date"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="receipt-date"
                  type="date"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.receipt.receipt_date")}
                />
              )}
            />
            <Field
              error={receiptErrors?.receipt_number}
              id="receipt-number"
              label="Receipt number"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="receipt-number"
                  aria-describedby={describedBy}
                  {...register("lineItems.0.receipt.receipt_number")}
                />
              )}
            />
          </div>
        </fieldset>

        <div className={styles.actions}>
          <Button disabled={createExpenseDraft.isPending} type="submit" variant="primary">
            Save expense draft
          </Button>
          <Status mutationError={createExpenseDraft.error} success={createExpenseDraft.isSuccess} />
        </div>
      </form>
    </div>
  );
}

function Field({
  error,
  id,
  label,
  render
}: {
  error?: FieldError;
  id: string;
  label: string;
  render: (describedBy: string) => JSX.Element;
}) {
  const errorId = `${id}-error`;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {render(errorId)}
      <span className={styles.error} id={errorId}>
        {error?.message ?? ""}
      </span>
    </div>
  );
}

function Status({ mutationError, success }: { mutationError: Error | null; success: boolean }) {
  if (mutationError !== null) {
    return (
      <span className={`${styles.status} ${styles.failure}`} role="alert">
        {mutationError instanceof ApiProblemError ? mutationError.detail : mutationError.message}
      </span>
    );
  }

  if (success) {
    return <span className={styles.status}>Expense draft saved.</span>;
  }

  return null;
}
