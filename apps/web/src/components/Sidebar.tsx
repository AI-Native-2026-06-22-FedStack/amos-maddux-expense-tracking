import styles from "./Sidebar.module.css";

const navSections = [
  "Workspace",
  "Employee Portal",
  "Administration",
] as const;

export function Sidebar() {
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
        {navSections.map((section) => (
          <section className={styles.navSection} key={section}>
            <h2 className={styles.navSectionLabel}>{section}</h2>
            <div className={styles.navPlaceholder} aria-label={`${section} entries pending`} />
          </section>
        ))}
      </nav>

      <div className={styles.sidebarFooter}>
        <div className={styles.userProfile}>
          <div className={styles.userAvatar} aria-hidden="true">
            MH
          </div>
          <div>
            <div className={styles.userName}>Marcus Hill</div>
            <div className={styles.userRole}>GlobalTech Inc · Finance Admin</div>
            <div className={styles.roleBadge}>Finance Admin</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
