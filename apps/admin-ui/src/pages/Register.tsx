import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { labels } from '../config/labels-registry';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const RESEND_COOLDOWN_SECONDS = 30;

type FormState = 'register' | 'verify';

/**
 * Registration page — calls POST /api/auth/register, then shows verification code prompt.
 * Requirements: 3.5, 3.6, 3.7, 3.8, 3.9
 */
export default function Register() {
  const navigate = useNavigate();

  const [formState, setFormState] = useState<FormState>('register');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    cooldownRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

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
        if (res.status === 409) {
          setError(labels.register.emailExists);
        } else if (res.status === 403) {
          setError(labels.register.signupClosed);
        } else {
          setError(data.error ?? 'Registration failed.');
        }
        return;
      }
      setFormState('verify');
      startCooldown();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { confirmSignUp } = await import('aws-amplify/auth');
      await confirmSignUp({ username: email, confirmationCode: code });
      // After verification, create tenant record
      await fetch(`${API_BASE}/api/auth/create-tenant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      navigate('/admin/welcome', { replace: true });
    } catch (err) {
      const msg = (err as { message?: string }).message ?? '';
      if (msg.includes('ExpiredCode') || msg.includes('expired')) {
        setError(labels.register.expiredCode);
      } else if (msg.includes('CodeMismatch') || msg.includes('Invalid')) {
        setError(labels.register.invalidCode);
      } else {
        setError(msg || 'Verification failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0) return;
    setError('');
    setInfo('');
    try {
      const { resendSignUpCode } = await import('aws-amplify/auth');
      await resendSignUpCode({ username: email });
      setInfo(labels.register.codeSent);
      startCooldown();
    } catch {
      setError('Failed to resend code. Please try again.');
    }
  }

  if (formState === 'verify') {
    return (
      <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: 8 }}>{labels.register.verificationTitle}</h1>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>
          {labels.register.verificationDescription.replace('{email}', email)}
        </p>
        <form onSubmit={handleVerify} noValidate>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="code">{labels.register.verificationCodeLabel}</label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              autoComplete="one-time-code"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </div>
          {error && (
            <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', marginBottom: 12 }}>
              {error}
            </p>
          )}
          {info && (
            <p aria-live="polite" style={{ color: 'var(--color-success)', marginBottom: 12 }}>
              {info}
            </p>
          )}
          <button type="submit" disabled={submitting} style={{ width: '100%', marginBottom: 12 }}>
            {labels.register.verifyButton}
          </button>
          <button
            type="button"
            onClick={handleResend}
            disabled={cooldown > 0}
            style={{ width: '100%' }}
          >
            {cooldown > 0
              ? labels.register.resendCooldown.replace('{seconds}', String(cooldown))
              : labels.register.resendButton}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 24 }}>{labels.register.title}</h1>
      <form onSubmit={handleRegister} noValidate>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="name">{labels.register.nameLabel}</label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="email">{labels.register.emailLabel}</label>
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
          <label htmlFor="password">{labels.register.passwordLabel}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </div>
        {error && (
          <p role="alert" aria-live="polite" style={{ color: 'var(--color-error)', marginBottom: 12 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={{ width: '100%' }}>
          {labels.register.submitButton}
        </button>
      </form>
    </main>
  );
}
