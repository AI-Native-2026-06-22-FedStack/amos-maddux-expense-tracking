import { Sidebar } from "./components/Sidebar";
import styles from "./App.module.css";

export function App() {
  return (
    <div className={styles.appContainer}>
      <Sidebar />
      <div className={styles.mainContent}>
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <h1>Expense Reports</h1>
          </div>
          <div className={styles.roleSwitcher} aria-label="Current role view">
            <span className={styles.labelPill}>View as</span>
            <span>Finance Admin</span>
          </div>
        </header>
        <main className={styles.contentSection} aria-label="Expense Report workspace">
          <div className={styles.shellPlaceholder} aria-label="Task 2 workspace placeholder" />
        </main>
      </div>
    </div>
  );
}
