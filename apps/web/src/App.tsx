import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "./atoms/Button";
import { AuthSessionProvider, useAuthSession } from "./auth";
import { Sidebar } from "./components/Sidebar";
import { ExpenseReportsScreen } from "./screens/ExpenseReportsScreen";
import { SignInScreen } from "./screens/SignInScreen";
import styles from "./App.module.css";

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthSessionProvider>
        <ExpenseFlowApp />
      </AuthSessionProvider>
    </QueryClientProvider>
  );
}

function ExpenseFlowApp() {
  const authSession = useAuthSession();
  const session = authSession.session;

  if (session === null) {
    return <SignInScreen />;
  }

  const currentUser = {
    initials: "AU",
    name: "Authenticated User",
    organization: session.tenantId
  };

  return (
    <div className={styles.appContainer}>
      <Sidebar activePage="expense-reports" caseCount={17} role={session.role} user={currentUser} />
      <div className={styles.mainContent}>
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <h1>Expense Reports</h1>
          </div>
          <div className={styles.sessionActions}>
            <div className={styles.roleSwitcher} aria-label="Current role view">
              <span className={styles.labelPill}>View as</span>
              <span>{session.role}</span>
            </div>
            <Button onClick={authSession.logout} type="button" variant="secondary">
              Logout
            </Button>
          </div>
        </header>
        <main className={styles.contentSection} aria-label="Expense Report workspace">
          <ExpenseReportsScreen />
        </main>
      </div>
    </div>
  );
}
