import { Sidebar } from "./components/Sidebar";
import type { UserRole } from "./domain";
import { ExpenseReportsScreen } from "./screens/ExpenseReportsScreen";
import styles from "./App.module.css";

const currentRole: UserRole = "Finance Admin";

const currentUser = {
  initials: "MH",
  name: "Marcus Hill",
  organization: "Demo Tenant"
};

export function App() {
  return (
    <div className={styles.appContainer}>
      <Sidebar activePage="expense-reports" caseCount={17} role={currentRole} user={currentUser} />
      <div className={styles.mainContent}>
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <h1>Expense Reports</h1>
          </div>
          <div className={styles.roleSwitcher} aria-label="Current role view">
            <span className={styles.labelPill}>View as</span>
            <span>{currentRole}</span>
          </div>
        </header>
        <main className={styles.contentSection} aria-label="Expense Report workspace">
          <ExpenseReportsScreen />
        </main>
      </div>
    </div>
  );
}
