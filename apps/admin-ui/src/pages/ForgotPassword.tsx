import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resetPassword, confirmResetPassword } from 'aws-amplify/auth';
import { labels } from '../config/labels-registry';
import styles from './ForgotPassword.module.css';
import '../styles/glass.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapForgotPasswordError(err: unknown): string {
  const msg = (err as Error)?.message ?? '';
  if (msg.includes('UserNotFoundException') || msg.includes('Username/client id combination not found')) {
    return labels.forgotPassword.errorEmailNotFound;
  }
  if (msg.includes('LimitExceededException') || msg.includes('Attempt limit exceeded')) {
    return labels.forgotPassword.errorTooManyAttempts;
  }
  return labels.forgotPassword.errorGeneric;
}

function mapConfirmPasswordError(err: unknown): string {
  const msg = (err as Error)?.message ?? '';
  if (msg.includes('CodeMismatchException') || msg.includes('ExpiredCodeException') || msg.includes('Invalid verification code')) {
    return labels.forgotPassword.errorInvalidCode;
  }
  if (msg.includes('LimitExceededException') || msg.includes('Attempt limit exceeded')) {
    return labels.forgotPassword.errorTooManyAttempts;
  }
  if (msg.includes('8 characters') || msg.includes('too short')) {
    return labels.forgotPassword.errorPasswordTooShort;
  }
  if (msg.includes('uppercase')) {
    return labels.forgotPassword.errorPasswordUppercase;
  }
  if (msg.includes('number') || msg.includes('numeric')) {
    return labels.forgotPassword.errorPasswordNumber;
  }
  if (msg.includes('symbol') || msg.includes('special')) {
    return labels.forgotPassword.errorPasswordSymbol;
  }
  return labels.forgotPassword.errorGeneric;
}

// ─── Component ────────────────────────────────────────────────────────────────

type Step = 'email' | 'code' | 'success';

export default function ForgotPassword() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('email');
  const [animating, setAnimating] = useState(false);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [resendStatus, setResendStatus] = useState<'idle' | 'sent'>('idle');

  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = labels.forgotPassword.documentTitle;
  }, []);

  function transitionTo(next: Step) {
    setAnimating(true);
    setError('');
    setTimeout(() => {
      setStep(next);
      setAnimating(false);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }, 250);
  }

  // ── Step 1: send reset code ────────────────────────────────────────────────

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await resetPassword({ username: email.trim() });
      transitionTo('code');
    } catch (err) {
      setError(mapForgotPasswordError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step 2: confirm new password ───────────────────────────────────────────

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || !newPassword) return;
    setSubmitting(true);
    setError('');
    try {
      await confirmResetPassword({
        username: email.trim(),
        confirmationCode: code.trim(),
        newPassword,
      });
      transitionTo('success');
    } catch (err) {
      setError(mapConfirmPasswordError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ── Resend code ────────────────────────────────────────────────────────────

  async function handleResend() {
    setError('');
    try {
      await resetPassword({ username: email.trim() });
      setResendStatus('sent');
      setTimeout(() => setResendStatus('idle'), 3000);
    } catch (err) {
      setError(mapForgotPasswordError(err));
    }
  }

  return (
    <div className="pulse-entry-bg" style={{ padding: '24px' }}>
      <div className="pulse-glass-card" style={{ width: '100%', maxWidth: 480, padding: '48px 32px', textAlign: 'center', overflow: 'hidden' }}>

        {/* Logo + wordmark */}
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
              marginTop: 'clamp(-3.33rem, -6.25vw, -5rem)',
              marginBottom: 'clamp(-4rem, -7.5vw, -6rem)',
            }}
          />
          <span style={{ display: 'block', fontSize: '1.75rem', fontWeight: 300, letterSpacing: '0.12em', color: 'var(--color-accent-pulse)' }}>
            pulse
          </span>
        </div>

        {/* Animated card content */}
        <div className={`pulse-card-inner ${animating ? 'entering' : 'entered'}`} role="main">

          {/* STEP 1 — Email entry */}
          {step === 'email' && (
            <form onSubmit={handleSendCode} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'left' }}>
              <div>
                <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 600, margin: '0 0 8px', textAlign: 'center' }}>
                  {labels.forgotPassword.heading}
                </h1>
                <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: 0, textAlign: 'center' }}>
                  {labels.forgotPassword.subheading}
                </p>
              </div>

              <div aria-live="polite" style={{ minHeight: '1.4em' }}>
                {error && (
                  <p role="alert" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
                    {error}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="fp-email" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
                  {labels.forgotPassword.emailLabel}
                </label>
                <input
                  ref={firstInputRef}
                  id="fp-email"
                  className="pulse-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  disabled={submitting}
                />
              </div>

              <button type="submit" className="pulse-btn pulse-btn-primary" disabled={submitting || !email.trim()}>
                {submitting ? '…' : labels.forgotPassword.sendCodeButton}
              </button>

              <button
                type="button"
                className="pulse-btn-ghost"
                onClick={() => navigate('/')}
                style={{ textAlign: 'center' }}
              >
                {labels.forgotPassword.backToSignIn}
              </button>
            </form>
          )}

          {/* STEP 2 — Code + new password */}
          {step === 'code' && (
            <form onSubmit={handleSetPassword} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'left' }}>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: 0, textAlign: 'center' }}>
                {labels.forgotPassword.codeSentCaption.replace('{email}', email)}
              </p>

              <div aria-live="polite" style={{ minHeight: '1.4em' }}>
                {error && (
                  <p role="alert" style={{ color: 'var(--color-error)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
                    {error}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="fp-code" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
                  {labels.forgotPassword.codeLabel}
                </label>
                <input
                  ref={firstInputRef}
                  id="fp-code"
                  className="pulse-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>

              <div>
                <label htmlFor="fp-new-password" style={{ display: 'block', fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
                  {labels.forgotPassword.newPasswordLabel}
                </label>
                <input
                  id="fp-new-password"
                  className="pulse-input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>

              <button type="submit" className="pulse-btn pulse-btn-primary" disabled={submitting || !code.trim() || !newPassword}>
                {submitting ? '…' : labels.forgotPassword.setPasswordButton}
              </button>

              <div style={{ textAlign: 'center' }}>
                {resendStatus === 'sent' ? (
                  <span aria-live="polite" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-success)' }}>
                    {labels.forgotPassword.codeResent}
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label="Resend verification code"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-interactive)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                    onClick={handleResend}
                    disabled={submitting}
                  >
                    {labels.forgotPassword.resendCode}
                  </button>
                )}
              </div>
            </form>
          )}

          {/* STEP 3 — Success */}
          {step === 'success' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'center', alignItems: 'center' }}>
              <span style={{ fontSize: '24px', color: 'var(--color-success)' }} aria-hidden="true">✓</span>
              <h1 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, margin: 0 }}>
                {labels.forgotPassword.successHeading}
              </h1>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: 0 }}>
                {labels.forgotPassword.successBody}
              </p>
              <button
                type="button"
                className="pulse-btn pulse-btn-primary"
                style={{ width: '100%' }}
                onClick={() => navigate('/')}
              >
                {labels.forgotPassword.successCta}
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
