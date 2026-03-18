import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

type FormState = 'login' | 'new-password';

/**
 * Login page — email/password + social sign-in.
 * Handles NEW_PASSWORD_REQUIRED challenge.
 * Requirements: 3.10, 3.11, 3.12, 3.13, 3.14, 3.15
 */
export default function Login() {
  const { user, isLoading, signIn, confirmNewPassword } = useAuth();
  const navigate = useNavigate();

  const [formState, setFormState] = useState<FormState>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Req 3.15 — redirect if already authenticated
  useEffect(() => {
    if (!isLoading && user) {
      navigate('/admin/items', { replace: true });
    }
  }, [user, isLoading, navigate]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { nextStep } = await signIn(email, password);
      if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        // Req 3.12
        setFormState('new-password');
        setPassword('');
      } else if (nextStep.signInStep === 'DONE') {
        await redirectAfterLogin();
      }
    } catch {
      // Req 3.11
      setError(labels.login.invalidCredentials);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await confirmNewPassword(newPassword);
      // Req 3.13
      await redirectAfterLogin();
    } catch (err) {
      setError((err as Error).message ?? labels.login.invalidCredentials);
    } finally {
      setSubmitting(false);
    }
  }

  async function redirectAfterLogin() {
    // Check onboardingComplete from settings API
    try {
      const { fetchAuthSession } = await import('aws-amplify/auth');
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString();
      if (token) {
        const res = await fetch(`${API_BASE}/api/manage/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json() as { data?: { onboardingComplete?: boolean } };
          if (data.data?.onboardingComplete === false) {
            navigate('/admin/welcome', { replace: true });
            return;
          }
        }
      }
    } catch {
      // fall through to items
    }
    navigate('/admin/items', { replace: true });
  }

  if (isLoading) return null;

  if (formState === 'new-password') {
    return (
      <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: 8 }}>
          {labels.login.newPasswordRequired.replace('{email}', email)}
        </h1>
        <form onSubmit={handleNewPassword} noValidate>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="new-password">{labels.login.newPasswordLabel}</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoFocus
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </div>
          {error && (
            <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', marginBottom: 12 }}>
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting} style={{ width: '100%' }}>
            {labels.login.newPasswordSubmit}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 24 }}>{labels.login.title}</h1>
      <form onSubmit={handleLogin} noValidate>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="email">{labels.login.emailLabel}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="password">{labels.login.passwordLabel}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </div>
        {error && (
          <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', marginBottom: 12 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={{ width: '100%', marginBottom: 12 }}>
          {labels.login.submitButton}
        </button>
      </form>

      <hr style={{ margin: '16px 0' }} />

      {/* Req 3.14 — social sign-in via Cognito hosted UI */}
      <button
        type="button"
        onClick={() => signInWithRedirect({ provider: 'Apple' })}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {labels.login.appleButton}
      </button>
      <button
        type="button"
        onClick={() => signInWithRedirect({ provider: 'Google' })}
        style={{ width: '100%' }}
      >
        {labels.login.googleButton}
      </button>
    </main>
  );
}
