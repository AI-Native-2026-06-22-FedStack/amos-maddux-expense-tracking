import {
  createBrowserRouter,
  createMemoryRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
  useRouteError
} from "react-router-dom";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Button } from "../atoms/Button";
import { ErrorState } from "../atoms/StateMessage";
import { useAuthSession } from "../auth";
import { Sidebar, type SidebarPage } from "../components/Sidebar";
import type { UserRole } from "../domain";
import { CaseQueue } from "../screens/CaseQueue";
import { ExpenseReportsScreen } from "../screens/ExpenseReportsScreen";
import { SignInScreen } from "../screens/SignInScreen";
import styles from "../App.module.css";
import routeStyles from "./router.module.css";

const internalRoles: readonly UserRole[] = [
  "Finance Admin",
  "Department Manager",
  "Platform Admin"
];
const employeeRoles: readonly UserRole[] = ["Employee"];
const adminRoles: readonly UserRole[] = ["Platform Admin"];
type ExpenseFlowRouter = ReturnType<typeof createBrowserRouter>;

export const routePaths = {
  adminRoles: "/app/admin-roles",
  adminUsers: "/app/admin-users",
  approvalQueue: "/app/approval-queue",
  dashboard: "/app/dashboard",
  expenseReports: "/app/expense-reports",
  logMileage: "/app/log-mileage",
  login: "/login",
  mySubmissions: "/app/my-submissions",
  submitExpense: "/app/submit-expense"
} as const;

export function createExpenseFlowRouter(queryClient: QueryClient): ExpenseFlowRouter {
  return createBrowserRouter(routeDefinitions(queryClient));
}

export function createExpenseFlowMemoryRouter(
  queryClient: QueryClient,
  initialEntries: readonly string[]
): ExpenseFlowRouter {
  return createMemoryRouter(routeDefinitions(queryClient), { initialEntries: [...initialEntries] });
}

export function ExpenseFlowRouterProvider({ router }: { router: ExpenseFlowRouter }) {
  return <RouterProvider router={router} />;
}

function routeDefinitions(queryClient: QueryClient) {
  return [
    {
      path: routePaths.login,
      element: <LoginRoute />
    },
    {
      path: "/",
      element: <RoleDefaultRedirect />
    },
    {
      path: "/app",
      element: <AuthenticatedRoute />,
      children: [
        {
          element: <AppShell queryClient={queryClient} />,
          errorElement: <ShellRouteError />,
          children: [
            {
              index: true,
              element: <RoleDefaultRedirect />
            },
            {
              path: "dashboard",
              element: (
                <RoleGate allowedRoles={internalRoles}>
                  <PlaceholderScreen
                    label="Finance Dashboard"
                    message="Tenant Expense Report metrics and review trends will appear here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "expense-reports",
              element: (
                <RoleGate allowedRoles={internalRoles}>
                  <ExpenseReportsScreen />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "approval-queue",
              element: (
                <RoleGate allowedRoles={internalRoles}>
                  <CaseQueue />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "my-submissions",
              element: (
                <RoleGate allowedRoles={employeeRoles}>
                  <PlaceholderScreen
                    label="My Submissions"
                    message="Employee Expense Report submissions will appear here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "submit-expense",
              element: (
                <RoleGate allowedRoles={employeeRoles}>
                  <PlaceholderScreen
                    label="Submit Expense"
                    message="Employee Expense Report submission starts here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "log-mileage",
              element: (
                <RoleGate allowedRoles={employeeRoles}>
                  <PlaceholderScreen
                    label="Log Mileage"
                    message="Employee mileage entries will be captured here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "admin-users",
              element: (
                <RoleGate allowedRoles={adminRoles}>
                  <PlaceholderScreen
                    label="All Tenants & Users"
                    message="Platform administration for tenants and users will appear here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "admin-roles",
              element: (
                <RoleGate allowedRoles={adminRoles}>
                  <PlaceholderScreen
                    label="Roles & Permissions"
                    message="Platform role and permission controls will appear here."
                  />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "route-error-test",
              element: (
                <RoleGate allowedRoles={internalRoles}>
                  <ThrowingRoute />
                </RoleGate>
              ),
              errorElement: <ShellRouteError />
            },
            {
              path: "*",
              element: <RoleDefaultRedirect />
            }
          ]
        }
      ]
    },
    {
      path: "*",
      element: <RoleDefaultRedirect />
    }
  ];
}

function AuthenticatedRoute() {
  const authSession = useAuthSession();
  const location = useLocation();

  if (authSession.session === null) {
    return <Navigate replace state={{ from: location }} to={routePaths.login} />;
  }

  return <Outlet />;
}

function LoginRoute() {
  const authSession = useAuthSession();

  if (authSession.session !== null) {
    return <Navigate replace to={defaultPathForRole(authSession.session.role)} />;
  }

  return <SignInScreen />;
}

function RoleGate({
  allowedRoles,
  children
}: {
  allowedRoles: readonly UserRole[];
  children: JSX.Element;
}) {
  const authSession = useAuthSession();
  const role = authSession.session?.role;

  if (role === undefined) {
    return <Navigate replace to={routePaths.login} />;
  }

  if (!allowedRoles.includes(role)) {
    return <Navigate replace to={defaultPathForRole(role)} />;
  }

  return children;
}

function RoleDefaultRedirect() {
  const authSession = useAuthSession();
  const role = authSession.session?.role;

  return <Navigate replace to={role === undefined ? routePaths.login : defaultPathForRole(role)} />;
}

function AppShell({ queryClient }: { queryClient: QueryClient }) {
  const authSession = useAuthSession();
  const location = useLocation();
  const navigate = useNavigate();
  const routeQueryClient = useQueryClient();
  const session = authSession.session;

  if (session === null) {
    return <Navigate replace to={routePaths.login} />;
  }

  const activePage = activePageFromPath(location.pathname);
  const currentUser = {
    initials: "AU",
    name: "Authenticated User",
    organization: session.tenantId
  };

  const logout = () => {
    routeQueryClient.clear();
    queryClient.clear();
    authSession.logout();
    const navigation = navigate(routePaths.login, { replace: true });

    if (navigation !== undefined) {
      navigation.catch(() => undefined);
    }
  };

  return (
    <div className={styles.appContainer}>
      <Sidebar activePage={activePage} caseCount={17} role={session.role} user={currentUser} />
      <div className={styles.mainContent}>
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <h1>{pageTitle(activePage)}</h1>
          </div>
          <div className={styles.sessionActions}>
            <div className={styles.roleSwitcher} aria-label="Current role view">
              <span className={styles.labelPill}>View as</span>
              <span>{session.role}</span>
            </div>
            <Button onClick={logout} type="button" variant="secondary">
              Logout
            </Button>
          </div>
        </header>
        <main className={styles.contentSection} aria-label="Expense Report workspace">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ShellRouteError() {
  const error = useRouteError();

  return (
    <ErrorState
      title="Route unavailable"
      message={error instanceof Error ? error.message : "ExpenseFlow could not render this route."}
      onRetry={() => {
        window.location.reload();
      }}
      retryLabel="Reload route"
    />
  );
}

function PlaceholderScreen({ label, message }: { label: string; message: string }) {
  return (
    <section className={routeStyles.placeholder} aria-labelledby="placeholder-title">
      <h2 className={routeStyles.placeholderTitle} id="placeholder-title">
        {label}
      </h2>
      <p className={routeStyles.placeholderMessage}>{message}</p>
    </section>
  );
}

function ThrowingRoute(): JSX.Element {
  throw new Error("Synthetic route failure.");
}

export function defaultPathForRole(role: UserRole): string {
  if (role === "Employee") {
    return routePaths.mySubmissions;
  }

  if (role === "Platform Admin") {
    return routePaths.dashboard;
  }

  return routePaths.dashboard;
}

function activePageFromPath(pathname: string): SidebarPage {
  const page = pathname.split("/").filter(Boolean).at(-1);

  if (isSidebarPage(page)) {
    return page;
  }

  return "dashboard";
}

function isSidebarPage(value: string | undefined): value is SidebarPage {
  return (
    value === "dashboard" ||
    value === "expense-reports" ||
    value === "approval-queue" ||
    value === "my-submissions" ||
    value === "submit-expense" ||
    value === "log-mileage" ||
    value === "admin-users" ||
    value === "admin-roles"
  );
}

function pageTitle(page: SidebarPage): string {
  switch (page) {
    case "dashboard":
      return "Finance Dashboard";
    case "expense-reports":
      return "Expense Reports";
    case "approval-queue":
      return "Approval Queue";
    case "my-submissions":
      return "My Submissions";
    case "submit-expense":
      return "Submit Expense";
    case "log-mileage":
      return "Log Mileage";
    case "admin-users":
      return "All Tenants & Users";
    case "admin-roles":
      return "Roles & Permissions";
    default:
      return "ExpenseFlow";
  }
}
