import type { UserRole } from "../domain";
import styles from "./Sidebar.module.css";

export type SidebarPage =
  | "dashboard"
  | "expense-reports"
  | "approval-queue"
  | "my-submissions"
  | "submit-expense"
  | "log-mileage"
  | "admin-users"
  | "admin-roles";

interface SidebarUser {
  initials: string;
  name: string;
  organization: string;
}

interface NavEntry {
  badge?: string;
  icon: string;
  label: string;
  page: SidebarPage;
  roles: readonly UserRole[];
}

interface NavSection {
  label: string;
  entries: readonly NavEntry[];
}

export interface SidebarProps {
  activePage: SidebarPage;
  caseCount?: number;
  role: UserRole;
  user: SidebarUser;
}

const workspaceRoles = ["Finance Admin", "Department Manager", "Platform Admin"] as const;

const navSections: readonly NavSection[] = [
  {
    label: "Workspace",
    entries: [
      {
        icon: "DB",
        label: "Finance Dashboard",
        page: "dashboard",
        roles: workspaceRoles,
      },
      {
        icon: "ER",
        label: "Expense Reports",
        page: "expense-reports",
        roles: workspaceRoles,
      },
      {
        icon: "AQ",
        label: "Approval Queue",
        page: "approval-queue",
        roles: workspaceRoles,
      },
    ],
  },
  {
    label: "Employee Portal",
    entries: [
      {
        icon: "MS",
        label: "My Submissions",
        page: "my-submissions",
        roles: ["Employee"],
      },
      {
        icon: "SE",
        label: "Submit Expense",
        page: "submit-expense",
        roles: ["Employee"],
      },
      {
        icon: "LM",
        label: "Log Mileage",
        page: "log-mileage",
        roles: ["Employee"],
      },
    ],
  },
  {
    label: "Administration",
    entries: [
      {
        icon: "TU",
        label: "All Tenants & Users",
        page: "admin-users",
        roles: ["Platform Admin"],
      },
      {
        icon: "RP",
        label: "Roles & Permissions",
        page: "admin-roles",
        roles: ["Platform Admin"],
      },
    ],
  },
];

function entryBadge(entry: NavEntry, caseCount?: number): string | undefined {
  if (entry.page === "expense-reports" && caseCount !== undefined) {
    return String(caseCount);
  }

  return entry.badge;
}

export function Sidebar({ activePage, caseCount, role, user }: SidebarProps) {
  const visibleSections = navSections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => entry.roles.includes(role)),
    }))
    .filter((section) => section.entries.length > 0);

  return (
    <aside className={styles.sidebar} aria-label="ExpenseFlow navigation">
      <div className={styles.sidebarHeader}>
        <div className={styles.logo}>
          <div className={styles.logoIcon} aria-hidden="true">
            EF
          </div>
          <span>ExpenseFlow</span>
        </div>
      </div>

      <nav className={styles.navMenu} aria-label="Primary navigation">
        {visibleSections.map((section) => (
          <section className={styles.navSection} key={section.label}>
            <h2 className={styles.navSectionLabel}>{section.label}</h2>
            {section.entries.map((entry) => (
              <a
                aria-current={entry.page === activePage ? "page" : undefined}
                className={`${styles.navItem} ${entry.page === activePage ? styles.active : ""}`}
                href={`#${entry.page}`}
                key={entry.page}
              >
                <span className={styles.navIcon} aria-hidden="true">
                  {entry.icon}
                </span>
                <span>{entry.label}</span>
                {entryBadge(entry, caseCount) ? (
                  <span className={styles.navBadge}>{entryBadge(entry, caseCount)}</span>
                ) : null}
              </a>
            ))}
          </section>
        ))}
      </nav>

      <div className={styles.sidebarFooter}>
        <div className={styles.userProfile}>
          <div className={styles.userAvatar} aria-hidden="true">
            {user.initials}
          </div>
          <div>
            <div className={styles.userName}>{user.name}</div>
            <div className={styles.userRole}>
              {user.organization} - {role}
            </div>
            <div className={styles.roleBadge}>{role}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

