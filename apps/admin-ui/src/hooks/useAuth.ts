import { useState, useEffect, useCallback } from 'react';
import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  fetchAuthSession,
  getCurrentUser,
  confirmSignIn,
  type SignInOutput,
} from 'aws-amplify/auth';

export type AuthUser = {
  username: string;
  email: string;
  name?: string;
};

export type UseAuthReturn = {
  user: AuthUser | null;
  tenantId: string | null;
  isLoading: boolean;
  signIn: (
    email: string,
    password: string
  ) => Promise<{ nextStep: SignInOutput['nextStep'] }>;
  confirmNewPassword: (newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
};

function extractTenantId(session: Awaited<ReturnType<typeof fetchAuthSession>>): string | null {
  try {
    const payload = session.tokens?.idToken?.payload;
    if (!payload) return null;
    return (payload['custom:tenantId'] as string) ?? null;
  } catch {
    return null;
  }
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadUser() {
      try {
        const [currentUser, session] = await Promise.all([
          getCurrentUser(),
          fetchAuthSession(),
        ]);
        if (cancelled) return;
        const payload = session.tokens?.idToken?.payload;
        setUser({
          username: currentUser.username,
          email: (payload?.email as string) ?? currentUser.username,
          name: (payload?.name as string) ?? undefined,
        });
        setTenantId(extractTenantId(session));
      } catch {
        if (!cancelled) {
          setUser(null);
          setTenantId(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadUser();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await amplifySignIn({ username: email, password });
      if (result.isSignedIn) {
        const [currentUser, session] = await Promise.all([
          getCurrentUser(),
          fetchAuthSession(),
        ]);
        const payload = session.tokens?.idToken?.payload;
        setUser({
          username: currentUser.username,
          email: (payload?.email as string) ?? currentUser.username,
          name: (payload?.name as string) ?? undefined,
        });
        setTenantId(extractTenantId(session));
      }
      return { nextStep: result.nextStep };
    },
    []
  );

  const confirmNewPassword = useCallback(async (newPassword: string) => {
    const result = await confirmSignIn({ challengeResponse: newPassword });
    if (result.isSignedIn) {
      const [currentUser, session] = await Promise.all([
        getCurrentUser(),
        fetchAuthSession(),
      ]);
      const payload = session.tokens?.idToken?.payload;
      setUser({
        username: currentUser.username,
        email: (payload?.email as string) ?? currentUser.username,
        name: (payload?.name as string) ?? undefined,
      });
      setTenantId(extractTenantId(session));
    }
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
    setTenantId(null);
  }, []);

  const getToken = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    const session = await fetchAuthSession({ forceRefresh: opts?.forceRefresh ?? false });
    const token = session.tokens?.accessToken?.toString();
    if (!token) throw new Error('No access token');
    return token;
  }, []);

  return { user, tenantId, isLoading, signIn, confirmNewPassword, signOut, getToken };
}
