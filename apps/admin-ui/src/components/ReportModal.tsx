import { useEffect, useRef, useState } from 'react';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './ReportModal.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReportType = 'bug-report' | 'feature-request' | 'general-inquiry' | 'privacy-question';

interface Props {
  type: ReportType;
  prefillName?: string;
  prefillEmail?: string;
  onClose: () => void;
}

const TYPE_OPTIONS: { value: ReportType; label: string }[] = [
  { value: 'general-inquiry',  label: labels.reportModal.titleContactSupport },
  { value: 'bug-report',       label: labels.reportModal.titleBugReport },
  { value: 'feature-request',  label: labels.reportModal.titleFeatureRequest },
  { value: 'privacy-question', label: labels.reportModal.titlePrivacyQuestion },
];

const TITLE_MAP: Record<ReportType, string> = {
  'general-inquiry':  labels.reportModal.titleContactSupport,
  'bug-report':       labels.reportModal.titleBugReport,
  'feature-request':  labels.reportModal.titleFeatureRequest,
  'privacy-question': labels.reportModal.titlePrivacyQuestion,
};

const MAX_CHARS = 5000;
const WARN_THRESHOLD = 200;

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReportModal({ type: initialType, prefillName = '', prefillEmail = '', onClose }: Props) {
  const [reportType, setReportType] = useState<ReportType>(initialType);
  const [message, setMessage] = useState('');
  const [name, setName] = useState(prefillName);
  const [email, setEmail] = useState(prefillEmail);
  const [submitted, setSubmitted] = useState(false);

  const headingId = 'report-modal-heading';
  const firstFocusRef = useRef<HTMLSelectElement>(null);

  // Focus trap
  useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const mutation = useAuthedMutation<unknown, { type: string; message: string; name?: string; email?: string }>(
    '/api/manage/report',
    'POST',
    {
      onSuccess: () => {
        setSubmitted(true);
        setTimeout(onClose, 2000);
      },
    }
  );

  const remaining = MAX_CHARS - message.length;
  const isOverLimit = remaining < 0;
  const isNearLimit = !isOverLimit && remaining <= WARN_THRESHOLD;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || isOverLimit || mutation.isPending) return;
    mutation.mutate({
      type: reportType,
      message: message.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
    });
  }

  const charCountClass = isOverLimit
    ? styles.charCountExceeded
    : isNearLimit
      ? styles.charCountWarning
      : styles.charCount;

  return (
    <div className={styles.overlay} aria-modal="true" role="dialog" aria-labelledby={headingId}>
      <div className={styles.modal}>
        {/* Title row */}
        <div className={styles.titleRow}>
          <h2 id={headingId} className={styles.title}>
            {TITLE_MAP[reportType]}
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {submitted ? (
          <p className={styles.success} aria-live="polite">{labels.reportModal.successMessage}</p>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            {/* Type selector */}
            <div className={styles.fieldGroup}>
              <label htmlFor="report-type" className={styles.label}>
                {labels.reportModal.typeLabel}
              </label>
              <select
                ref={firstFocusRef}
                id="report-type"
                className={styles.select}
                value={reportType}
                onChange={e => setReportType(e.target.value as ReportType)}
                disabled={mutation.isPending}
              >
                {TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Message */}
            <div className={styles.fieldGroup}>
              <label htmlFor="report-message" className={styles.label}>
                {labels.reportModal.messageLabel}
              </label>
              <textarea
                id="report-message"
                className={styles.textarea}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder={labels.reportModal.messagePlaceholder}
                disabled={mutation.isPending}
                required
                aria-describedby="report-char-count"
              />
              <span
                id="report-char-count"
                className={charCountClass}
                aria-live="polite"
              >
                {isOverLimit
                  ? labels.reportModal.charLimitExceeded
                  : labels.reportModal.charLimitWarning.replace('{remaining}', String(remaining))}
              </span>
            </div>

            {/* Optional name */}
            <div className={styles.fieldGroup}>
              <label htmlFor="report-name" className={styles.label}>
                {labels.reportModal.nameLabel}
              </label>
              <input
                id="report-name"
                type="text"
                className={styles.input}
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={mutation.isPending}
                autoComplete="name"
              />
            </div>

            {/* Optional email */}
            <div className={styles.fieldGroup}>
              <label htmlFor="report-email" className={styles.label}>
                {labels.reportModal.emailLabel}
              </label>
              <input
                id="report-email"
                type="email"
                className={styles.input}
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={mutation.isPending}
                autoComplete="email"
                aria-describedby="report-email-helper"
              />
              <span id="report-email-helper" className={styles.helper}>
                {labels.reportModal.emailHelper}
              </span>
            </div>

            {/* Error */}
            {mutation.isError && (
              <p className={styles.error} role="alert" aria-live="polite">
                {labels.reportModal.errorMessage}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={!message.trim() || isOverLimit || mutation.isPending}
            >
              {mutation.isPending
                ? labels.reportModal.submittingButton
                : labels.reportModal.submitButton}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
