import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from "react";
import {
  createHttpAuthClient,
  type AuthClient,
  type AuthSession,
  type CompleteMfaInput,
  type LoginCredentials,
  type MfaChallenge
} from "./auth-client";
import { createSessionStorage, type AuthSessionStorage } from "./session-storage";
import { readAccessTokenExpiry } from "./token-expiry";

const refreshSkewMs = 60_000;

export type AuthSessionPhase =
  | "checking_storage"
  | "unauthenticated"
  | "submitting_credentials"
  | "mfa_required"
  | "submitting_mfa"
  | "authenticated"
  | "refreshing"
  | "error";

interface UnauthenticatedState {
  phase: "checking_storage" | "unauthenticated";
  session: null;
  mfaChallenge: null;
  errorMessage: string | null;
}

interface SubmittingCredentialsState {
  phase: "submitting_credentials";
  session: null;
  mfaChallenge: null;
  errorMessage: string | null;
}

interface MfaRequiredState {
  phase: "mfa_required";
  session: null;
  mfaChallenge: MfaChallenge;
  errorMessage: string | null;
}

interface SubmittingMfaState {
  phase: "submitting_mfa";
  session: null;
  mfaChallenge: MfaChallenge;
  errorMessage: string | null;
}

interface AuthenticatedState {
  phase: "authenticated" | "refreshing";
  session: AuthSession;
  mfaChallenge: null;
  errorMessage: string | null;
}

interface ErrorState {
  phase: "error";
  session: null;
  mfaChallenge: MfaChallenge | null;
  errorMessage: string;
}

type AuthState =
  | UnauthenticatedState
  | SubmittingCredentialsState
  | MfaRequiredState
  | SubmittingMfaState
  | AuthenticatedState
  | ErrorState;

type AuthAction =
  | { type: "storage_restored"; session: AuthSession | null }
  | { type: "login_started" }
  | { type: "mfa_required"; challenge: MfaChallenge }
  | { type: "mfa_started"; challenge: MfaChallenge }
  | { type: "authenticated"; session: AuthSession }
  | { type: "refresh_started" }
  | { type: "refresh_failed"; message: string }
  | { type: "failed"; message: string; challenge?: MfaChallenge | null }
  | { type: "logged_out"; message?: string };

export type RefreshSession = (session: AuthSession, signal: AbortSignal) => Promise<AuthSession>;

export interface AuthSessionProviderProps {
  authClient?: AuthClient;
  children: ReactNode;
  refreshSession?: RefreshSession;
  storage?: AuthSessionStorage;
}

export interface UseAuthSessionResult {
  phase: AuthSessionPhase;
  session: AuthSession | null;
  mfaChallenge: MfaChallenge | null;
  errorMessage: string | null;
  isAuthenticated: boolean;
  login(credentials: LoginCredentials): Promise<void>;
  completeMfa(code: string): Promise<void>;
  logout(): void;
  getCurrentAccessToken(): string | null;
}

const AuthSessionContext = createContext<UseAuthSessionResult | undefined>(undefined);

const defaultAuthClient = createHttpAuthClient();

function createInitialState(storage: AuthSessionStorage): AuthState {
  return authReducer(checkingStorageState(), { type: "storage_restored", session: storage.load() });
}

export function AuthSessionProvider({
  authClient = defaultAuthClient,
  children,
  refreshSession,
  storage
}: AuthSessionProviderProps) {
  const sessionStorageAdapter = useMemo(() => storage ?? createSessionStorage(), [storage]);
  const [state, dispatch] = useReducer(authReducer, sessionStorageAdapter, createInitialState);
  const activeSession = state.session;
  const activeAuthRequestRef = useRef<{ controller: AbortController; id: number } | null>(null);
  const authRequestIdRef = useRef(0);
  const sessionGenerationRef = useRef(0);

  const abortActiveAuthRequest = useCallback(() => {
    activeAuthRequestRef.current?.controller.abort();
    activeAuthRequestRef.current = null;
  }, []);

  const beginAuthRequest = useCallback(() => {
    abortActiveAuthRequest();

    const request = {
      controller: new AbortController(),
      id: authRequestIdRef.current + 1
    };
    authRequestIdRef.current = request.id;
    activeAuthRequestRef.current = request;

    return request;
  }, [abortActiveAuthRequest]);

  const isActiveAuthRequest = useCallback(
    (request: { controller: AbortController; id: number }) => {
      return activeAuthRequestRef.current?.id === request.id && !request.controller.signal.aborted;
    },
    []
  );

  useEffect(() => {
    if (state.session !== null) {
      sessionStorageAdapter.save(state.session);
      return;
    }

    sessionStorageAdapter.clear();
  }, [state.session, sessionStorageAdapter]);

  useEffect(() => abortActiveAuthRequest, [abortActiveAuthRequest]);

  useEffect(() => {
    if (activeSession === null) {
      return;
    }

    const controller = new AbortController();
    const refreshGeneration = sessionGenerationRef.current;
    const expiresAt = readAccessTokenExpiry(activeSession.accessToken);
    const refreshDelayMs =
      expiresAt === null ? 0 : Math.max(expiresAt - Date.now() - refreshSkewMs, 0);

    const timerId = window.setTimeout(() => {
      if (refreshSession === undefined) {
        dispatch({ type: "logged_out", message: "Your session expired. Please sign in again." });
        return;
      }

      dispatch({ type: "refresh_started" });
      void refreshSession(activeSession, controller.signal)
        .then((nextSession) => {
          if (controller.signal.aborted || refreshGeneration !== sessionGenerationRef.current) {
            return;
          }

          dispatch({ type: "authenticated", session: nextSession });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          dispatch({ type: "refresh_failed", message: readErrorMessage(error) });
        });
    }, refreshDelayMs);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [activeSession, refreshSession]);

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      const request = beginAuthRequest();

      dispatch({ type: "login_started" });

      try {
        const result = await authClient.login(credentials, request.controller.signal);

        if (!isActiveAuthRequest(request)) {
          return;
        }

        activeAuthRequestRef.current = null;

        if (result.status === "mfa_required") {
          dispatch({ type: "mfa_required", challenge: result.challenge });
          return;
        }

        sessionGenerationRef.current += 1;
        dispatch({ type: "authenticated", session: result.session });
      } catch (error) {
        if (!isActiveAuthRequest(request)) {
          return;
        }

        activeAuthRequestRef.current = null;
        dispatch({ type: "failed", message: readErrorMessage(error) });
      }
    },
    [authClient, beginAuthRequest, isActiveAuthRequest]
  );

  const completeMfa = useCallback(
    async (code: string) => {
      if (state.mfaChallenge === null) {
        dispatch({ type: "failed", message: "Start sign-in before entering an MFA code." });
        return;
      }

      const challenge = state.mfaChallenge;
      const request = beginAuthRequest();
      const input: CompleteMfaInput = {
        tenantId: challenge.tenantId,
        userId: challenge.userId,
        code
      };

      dispatch({ type: "mfa_started", challenge });

      try {
        const session = await authClient.completeMfa(input, request.controller.signal);

        if (!isActiveAuthRequest(request)) {
          return;
        }

        activeAuthRequestRef.current = null;
        sessionGenerationRef.current += 1;
        dispatch({ type: "authenticated", session });
      } catch (error) {
        if (!isActiveAuthRequest(request)) {
          return;
        }

        activeAuthRequestRef.current = null;
        dispatch({ type: "failed", message: readErrorMessage(error), challenge });
      }
    },
    [authClient, beginAuthRequest, isActiveAuthRequest, state.mfaChallenge]
  );

  const logout = useCallback(() => {
    abortActiveAuthRequest();
    sessionGenerationRef.current += 1;
    dispatch({ type: "logged_out" });
  }, [abortActiveAuthRequest]);

  const getCurrentAccessToken = useCallback(
    () => state.session?.accessToken ?? null,
    [state.session]
  );

  const value = useMemo<UseAuthSessionResult>(
    () => ({
      phase: state.phase,
      session: state.session,
      mfaChallenge: state.mfaChallenge,
      errorMessage: state.errorMessage,
      isAuthenticated: state.session?.isAuthenticated ?? false,
      login,
      completeMfa,
      logout,
      getCurrentAccessToken
    }),
    [completeMfa, getCurrentAccessToken, login, logout, state]
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): UseAuthSessionResult {
  const context = useContext(AuthSessionContext);

  if (context === undefined) {
    throw new Error("useAuthSession must be used within AuthSessionProvider.");
  }

  return context;
}

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "storage_restored":
      return action.session === null || !isSessionUsable(action.session)
        ? unauthenticatedState()
        : authenticatedState(action.session);
    case "login_started":
      return {
        phase: "submitting_credentials",
        session: null,
        mfaChallenge: null,
        errorMessage: null
      };
    case "mfa_required":
      return {
        phase: "mfa_required",
        session: null,
        mfaChallenge: action.challenge,
        errorMessage: null
      };
    case "mfa_started":
      return {
        phase: "submitting_mfa",
        session: null,
        mfaChallenge: action.challenge,
        errorMessage: null
      };
    case "authenticated":
      return authenticatedState(action.session);
    case "refresh_started":
      if (state.session === null) {
        return state;
      }

      return {
        phase: "refreshing",
        session: state.session,
        mfaChallenge: null,
        errorMessage: null
      };
    case "refresh_failed":
      return {
        phase: "error",
        session: null,
        mfaChallenge: null,
        errorMessage: action.message
      };
    case "failed":
      return {
        phase: "error",
        session: null,
        mfaChallenge: action.challenge ?? null,
        errorMessage: action.message
      };
    case "logged_out":
      return {
        phase: "unauthenticated",
        session: null,
        mfaChallenge: null,
        errorMessage: action.message ?? null
      };
    default:
      return state;
  }
}

function checkingStorageState(): AuthState {
  return {
    phase: "checking_storage",
    session: null,
    mfaChallenge: null,
    errorMessage: null
  };
}

function unauthenticatedState(): AuthState {
  return {
    phase: "unauthenticated",
    session: null,
    mfaChallenge: null,
    errorMessage: null
  };
}

function authenticatedState(session: AuthSession): AuthState {
  return {
    phase: "authenticated",
    session,
    mfaChallenge: null,
    errorMessage: null
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication request failed.";
}

function isSessionUsable(session: AuthSession): boolean {
  const expiresAt = readAccessTokenExpiry(session.accessToken);

  return expiresAt !== null && expiresAt > Date.now();
}
