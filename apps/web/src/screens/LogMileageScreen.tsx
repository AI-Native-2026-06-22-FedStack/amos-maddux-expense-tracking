import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldError } from "react-hook-form";
import { createMileageDraftExpenseReportRequestSchema } from "@expenseflow/shared-schemas";
import { Button } from "../atoms/Button";
import { ApiProblemError } from "../api";
import { type MileageDraftFormValues, useExpenseDraftMutations } from "../api/useExpenseDraftMutations";
import styles from "./ExpenseWriteForms.module.css";

export function LogMileageScreen() {
  const { createMileageDraft } = useExpenseDraftMutations();
  const {
    formState: { errors },
    handleSubmit,
    register
  } = useForm<MileageDraftFormValues>({
    defaultValues: {
      draftType: "mileage",
      mileageEntries: [
        {
          business_purpose: "",
          destination: "",
          miles: 0,
          origin: "",
          trip_date: ""
        }
      ],
      priority: "Normal"
    },
    resolver: zodResolver(createMileageDraftExpenseReportRequestSchema)
  });

  const mileageErrors = errors.mileageEntries?.[0];

  return (
    <div className={styles.formScreen}>
      <section className={styles.summary} aria-labelledby="log-mileage-title">
        <h2 className={styles.title} id="log-mileage-title">
          Log Mileage
        </h2>
        <p className={styles.summaryText}>
          Create a Drafted Expense Report with one mileage entry for employee reimbursement.
        </p>
      </section>

      <form
        className={styles.form}
        onSubmit={(event) => {
          void handleSubmit((values) => createMileageDraft.mutate(values))(event);
        }}
      >
        <input type="hidden" {...register("draftType")} />
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Report</legend>
          <div className={styles.grid}>
            <Field
              error={errors.priority}
              id="mileage-priority"
              label="Priority"
              render={(describedBy) => (
                <select
                  className={styles.select}
                  id="mileage-priority"
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
              id="mileage-due-date"
              label="Due date"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="mileage-due-date"
                  type="date"
                  aria-describedby={describedBy}
                  {...register("dueDate")}
                />
              )}
            />
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Route</legend>
          <div className={styles.grid}>
            <Field
              error={mileageErrors?.trip_date}
              id="mileage-trip-date"
              label="Trip date"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="mileage-trip-date"
                  type="date"
                  aria-describedby={describedBy}
                  {...register("mileageEntries.0.trip_date")}
                />
              )}
            />
            <Field
              error={mileageErrors?.origin}
              id="mileage-origin"
              label="Origin"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="mileage-origin"
                  aria-describedby={describedBy}
                  {...register("mileageEntries.0.origin")}
                />
              )}
            />
            <Field
              error={mileageErrors?.destination}
              id="mileage-destination"
              label="Destination"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="mileage-destination"
                  aria-describedby={describedBy}
                  {...register("mileageEntries.0.destination")}
                />
              )}
            />
            <Field
              error={mileageErrors?.miles}
              id="mileage-miles"
              label="Miles"
              render={(describedBy) => (
                <input
                  className={styles.input}
                  id="mileage-miles"
                  type="number"
                  step="0.01"
                  aria-describedby={describedBy}
                  {...register("mileageEntries.0.miles")}
                />
              )}
            />
          </div>
          <Field
            error={mileageErrors?.business_purpose}
            id="mileage-business-purpose"
            label="Business purpose"
            render={(describedBy) => (
              <input
                className={styles.input}
                id="mileage-business-purpose"
                aria-describedby={describedBy}
                {...register("mileageEntries.0.business_purpose")}
              />
            )}
          />
        </fieldset>

        <div className={styles.actions}>
          <Button disabled={createMileageDraft.isPending} type="submit" variant="primary">
            Save mileage draft
          </Button>
          <Status mutationError={createMileageDraft.error} success={createMileageDraft.isSuccess} />
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
    return <span className={styles.status}>Mileage draft saved.</span>;
  }

  return null;
}
