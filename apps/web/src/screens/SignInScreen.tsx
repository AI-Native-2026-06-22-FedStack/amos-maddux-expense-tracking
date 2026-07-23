import { type FormEvent, useState } from "react";
import { Button } from "../atoms/Button";
import { useAuthSession } from "../auth";
import styles from "./SignInScreen.module.css";

export function SignInScreen() {
  const authSession = useAuthSession();
  const [tenantId, setTenantId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const awaitingCredentials = authSession.phase === "submitting_credentials";
  const awaitingMfa = authSession.phase === "submitting_mfa";
  const shouldShowMfa =
    authSession.phase === "mfa_required" ||
    authSession.phase === "submitting_mfa" ||
    (authSession.phase === "error" && authSession.mfaChallenge !== null);

  const submitCredentials = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    authSession.login({ tenantId, email, password }).catch(() => undefined);
  };

  const submitMfa = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    authSession.completeMfa(totpCode).catch(() => undefined);
  };

  return (
    <main className={styles.authPage} aria-label="ExpenseFlow sign in">
      <section className={styles.panel}>
        <div className={styles.brand}>
          <div className={styles.brandMark} aria-hidden="true">
            EF
          </div>
          <div className={styles.brandText}>
            <h1 className={styles.brandName}>ExpenseFlow</h1>
            <div className={styles.brandMeta}>Expense Report workspace</div>
          </div>
        </div>

        {authSession.errorMessage !== null ? (
          <div className={styles.error} role="alert">
            {authSession.errorMessage}
          </div>
        ) : null}

        {shouldShowMfa ? (
          <form className={styles.form} onSubmit={submitMfa}>
            <p className={styles.hint}>
              Enter the 6-digit authenticator code for this ExpenseFlow account.
            </p>
            <label className={styles.field}>
              <span className={styles.label}>MFA code</span>
              <input
                autoComplete="one-time-code"
                className={styles.input}
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setTotpCode(event.target.value)}
                pattern="[0-9]{6}"
                required
                type="text"
                value={totpCode}
              />
            </label>
            <Button disabled={awaitingMfa} type="submit" variant="primary">
              {awaitingMfa ? "Verifying" : "Complete sign in"}
            </Button>
          </form>
        ) : (
          <form className={styles.form} onSubmit={submitCredentials}>
            <label className={styles.field}>
              <span className={styles.label}>Tenant ID</span>
              <input
                autoComplete="organization"
                className={styles.input}
                onChange={(event) => setTenantId(event.target.value)}
                required
                type="text"
                value={tenantId}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Email</span>
              <input
                autoComplete="email"
                className={styles.input}
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Password</span>
              <input
                autoComplete="current-password"
                className={styles.input}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            <Button disabled={awaitingCredentials} type="submit" variant="primary">
              {awaitingCredentials ? "Signing in" : "Sign in"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
