import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

export interface DataTableColumn<T> {
  header: string;
  key: string;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  actions?: ReactNode;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  title: string;
}

export function DataTable<T>({ actions, columns, rows, title }: DataTableProps<T>) {
  return (
    <section className={styles.tableContainer} aria-labelledby="expense-report-table-title">
      <div className={styles.tableHeader}>
        <h2 className={styles.tableTitle} id="expense-report-table-title">
          {title}
        </h2>
        {actions ? <div className={styles.tableActions}>{actions}</div> : null}
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

