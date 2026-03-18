import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithRedirect } from 'aws-amplify/auth';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';
import '../styles/glass.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

// Valid pulse code: exactly 8 alphanumeric chars
const isValidPulseCode = (code: string) => /^[A-Z0-9]{8}$/i.test(code);

type EntryState = 'splash' | 'login' | 'register' | 'new-password';

export default function SplashEntry() {
  const { user, isLoading, signIn, confirmNewPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const registeredSuccessfully = (location.state as { registered?: boolean } | null)?.registered === true;

  const [state, setState] = useState<EntryState>('splash');
  const [animating, setAnimating] = useState(false);

  // Form fields
  const [pulseCode, setPulseCode] = useState('');
  const [pulseCodeError, setPulseCodeError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState(registeredSuccessfully ? labels.login.registrationSuccess : '');
  const [submitting, setSubmitting] = useState(false);

  const firstInputRef = useRef<HTMLInputElement>(null);

  // Redirect if already authenticated
  useEffect(() => {
    if (!isLoading && user) {
      navigate('/admin/items', { replace: true });
    }
  }, [user, isLoading, navigate]);

  function transitionTo(next: EntryState) {
    setAnimating(true);
    setError('');
    setTimeout(() => {
      setState(next);
      setAnimating(false);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }, 200);
  }

  // ── Pulse code submit ──────────────────────────────────────────────────────
  function handlePulseCode(e: React.FormEvent) {
    e.preventDefault();
    const code = pulseCode.trim();
    if (!isValidPulseCode(code)) {
      setPulseCodeError(labels.splash.pulseCodeError);
      return;
    }
    window.location.href = `/s/?code=${encodeURIComponent(code.toUpperCase())}`;
  }

  // ── Login submit ───────────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { nextStep } = await signIn(email, password);
      if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setPassword('');
        transitionTo('new-password');
      } else if (nextStep.signInStep === 'DONE') {
        await redirectAfterLogin();
      }
    } catch {
      setError(labels.login.invalidCredentials);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  // ── New password submit ────────────────────────────────────────────────────
  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await confirmNewPassword(newPassword);
      await redirectAfterLogin();
    } catch (err) {
      setError((err as Error).message ?? labels.login.invalidCredentials);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Register submit ────────────────────────────────────────────────────────
  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        if (res.status === 409) setError(labels.register.emailExists);
        else if (res.status === 403) setError(labels.register.signupClosed);
        else setError(data.error ?? 'Registration failed.');
        return;
      }
      // Cognito emails a temporary password — go to login with success banner
      setName(''); setPassword('');
      setError(labels.login.registrationSuccess);
      transitionTo('login');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function redirectAfterLogin() {
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
    } catch { /* fall through */ }
    navigate('/admin/items', { replace: true });
  }

  if (isLoading) return null;

  return (
    <div className="pulse-entry-bg" style={{ padding: '24px' }}>
    <div className="pulse-glass-card" style={{ width: '100%', maxWidth: 480, padding: '48px 32px', textAlign: 'center', overflow: 'hidden' }}>
        {/* ── Logo + wordmark — always visible ── */}
        <div style={{ margin: '0 auto 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div
            role="img"
            aria-label="ur/gd Studios logo"
            style={{
              height: 'clamp(15rem, 28.125vw, 22.5rem)',
              width: 'clamp(15rem, 28.125vw, 22.5rem)',
              backgroundImage: `url(${window.location.origin}/logo.svg)`,
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
              marginTop: '-5rem',
              marginBottom: '-6rem',
            }}
          />
          <span
            style={{
              display: 'block',
              fontSize: '1.75rem',
              fontWeight: 300,
              letterSpacing: '0.12em',
              color: 'var(--color-accent-pulse)',
            }}
          >
            pulse
          </span>
        </div>

        {/* ── Animated inner content ── */}
        <div className={`pulse-card-inner ${animating ? 'entering' : 'entered'}`}>

          {/* SPLASH */}
          {state === 'splash' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <form onSubmit={handlePulseCode} noValidate>
                <div style={{ marginBottom: 4 }}>
                  <input
                    ref={firstInputRef}
                    className="pulse-input"
                    type="text"
                    placeholder={labels.splash.pulseCodePlaceholder}
                    value={pulseCode}
                    onChange={e => { setPulseCode(e.target.value); setPulseCodeError(''); }}
                    autoComplete="off"
                    aria-label={labels.splash.pulseCodeLabel}
                    aria-invalid={pulseCodeError ? 'true' : undefined}
                    style={{ marginBottom: 6 }}
                  />
                  {pulseCodeError && (
                    <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: '0 0 6px' }}>
                      {pulseCodeError}
                    </p>
                  )}
                </div>
                <button type="submit" className="pulse-btn pulse-btn-primary" style={{ marginBottom: 4 }}>
                  {labels.splash.joinButton}
                </button>
              </form>
              <button type="button" className="pulse-btn" onClick={() => transitionTo('login')}>
                {labels.splash.loginButton}
              </button>
              <button type="button" className="pulse-btn" onClick={() => transitionTo('register')}>
                {labels.splash.signUpButton}
              </button>
            </div>
          )}

          {/* LOGIN */}
          {state === 'login' && (
            <form onSubmit={handleLogin} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {error && (
                <p
                  role={error === labels.login.registrationSuccess ? undefined : 'alert'}
                  aria-live="polite"
                  style={{ color: error === labels.login.registrationSuccess ? 'var(--color-success)' : 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: 0 }}
                >
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="login-email" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.login.emailLabel}</label>
                <input
                  ref={firstInputRef}
                  id="login-email"
                  className="pulse-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div>
                <label htmlFor="login-password" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.login.passwordLabel}</label>
                <input
                  id="login-password"
                  className="pulse-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <button type="submit" className="pulse-btn pulse-btn-primary" disabled={submitting}>
                {submitting ? '…' : labels.login.submitButton}
              </button>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
              <button type="button" className="pulse-btn" onClick={() => signInWithRedirect({ provider: 'Apple' })}>
                {labels.login.appleButton}
              </button>
              <button type="button" className="pulse-btn" onClick={() => signInWithRedirect({ provider: 'Google' })}>
                {labels.login.googleButton}
              </button>
              <button type="button" className="pulse-btn-ghost" onClick={() => transitionTo('splash')}>
                ← {labels.splash.backButton}
              </button>
            </form>
          )}

          {/* NEW PASSWORD */}
          {state === 'new-password' && (
            <form onSubmit={handleNewPassword} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: 0 }}>
                {labels.login.newPasswordRequired.replace('{email}', email)}
              </p>
              {error && (
                <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="new-password" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.login.newPasswordLabel}</label>
                <input
                  ref={firstInputRef}
                  id="new-password"
                  className="pulse-input"
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="pulse-btn pulse-btn-primary" disabled={submitting}>
                {submitting ? '…' : labels.login.newPasswordSubmit}
              </button>
            </form>
          )}

          {/* REGISTER */}
          {state === 'register' && (
            <form onSubmit={handleRegister} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {error && (
                <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="reg-name" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.register.nameLabel}</label>
                <input
                  ref={firstInputRef}
                  id="reg-name"
                  className="pulse-input"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </div>
              <div>
                <label htmlFor="reg-email" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.register.emailLabel}</label>
                <input
                  id="reg-email"
                  className="pulse-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div>
                <label htmlFor="reg-password" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>{labels.register.passwordLabel}</label>
                <input
                  id="reg-password"
                  className="pulse-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="pulse-btn pulse-btn-primary" disabled={submitting}>
                {submitting ? '…' : labels.register.submitButton}
              </button>
              <button type="button" className="pulse-btn-ghost" onClick={() => transitionTo('splash')}>
                ← {labels.splash.backButton}
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
