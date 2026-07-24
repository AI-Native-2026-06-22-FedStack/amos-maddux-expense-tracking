import { memo, type ReactNode } from "react";
import styles from "./DataTable.module.css";

export interface DataTableColumn<T> {
  header: string;
  key: string;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  actions?: ReactNode;
  columns: readonly DataTableColumn<T>[];
  getRowKey: (row: T) => string;
  rows: readonly T[];
  title: string;
}

function DataTableComponent<T>({ actions, columns, getRowKey, rows, title }: DataTableProps<T>) {
  return (
    <section className={styles.tableContainer} aria-label={title}>
      <div className={styles.tableHeader}>
        <h2 className={styles.tableTitle}>{title}</h2>
        {actions ? <div className={styles.tableActions}>{actions}</div> : null}
      </div>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>{title}</caption>
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
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
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

export const DataTable = memo(DataTableComponent) as typeof DataTableComponent;
