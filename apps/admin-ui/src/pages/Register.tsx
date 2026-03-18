import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { labels } from '../config/labels-registry';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

/**
 * Registration page — calls POST /api/auth/register.
 * Cognito sends a temporary password email; user then logs in and completes
 * the NEW_PASSWORD_REQUIRED challenge on the login page.
 * Requirements: 3.5, 3.6, 3.7, 3.8, 3.9
 */
export default function Register() {
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      // Cognito emails a temporary password — send user to login to complete sign-in
      navigate('/admin/login', { replace: true, state: { registered: true } });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
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
