import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { updatePassword } from 'aws-amplify/auth';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { labels } from '../config/labels-registry';
import ReportModal, { type ReportType } from '../components/ReportModal';
import styles from './Settings.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Settings {
  displayName: string | null;
  email: string | null;
  tier: string;
  usage: { itemCount: number; sessionCount: number };
  features: { maxActiveItems: number; maxSessionsPerItem: number };
  preferences: { theme?: 'light' | 'dark' | 'system' };
}

interface SettingsResponse {
  data: Settings;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function UsageBar({ used, max }: { used: number; max: number }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const fillClass = pct >= 100
    ? styles.usageFillFull
    : pct >= 80
      ? styles.usageFillWarning
      : styles.usageFill;

  return (
    <div className={styles.usageTrack} role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
      <div className={fillClass} style={{ width: `${pct}%` }} />
    </div>
  );
}

function mapCognitoPasswordError(err: unknown): string {
  const msg = (err as Error)?.message ?? '';
  if (msg.includes('NotAuthorizedException') || msg.includes('Incorrect username or password')) {
    return labels.settings.wrongCurrentPassword;
  }
  if (msg.includes('same') || msg.includes('previous')) {
    return labels.settings.newPasswordSameAsCurrent;
  }
  if (msg.includes('8 characters') || msg.includes('too short')) {
    return labels.settings.passwordTooShort;
  }
  if (msg.includes('uppercase')) {
    return labels.settings.passwordMissingUppercase;
  }
  if (msg.includes('number') || msg.includes('numeric')) {
    return labels.settings.passwordMissingNumber;
  }
  if (msg.includes('symbol') || msg.includes('special')) {
    return labels.settings.passwordMissingSymbol;
  }
  return labels.settings.passwordGenericError;
}

// ─── Delete Account Modal ─────────────────────────────────────────────────────

interface DeleteModalProps {
  email: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
  error: string;
}

function DeleteModal({ email, onConfirm, onCancel, isDeleting, error }: DeleteModalProps) {
  const [typed, setTyped] = useState('');
  const headingId = 'delete-modal-heading';
  const descId = 'delete-modal-desc';
  const firstFocusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const canDelete = typed === email;

  return (
    <div className={styles.modalOverlay} aria-modal="true" role="dialog" aria-labelledby={headingId}>
      <div className={styles.modalCard}>
        <h2 id={headingId} className={styles.modalHeading}>{labels.settings.deleteModalHeading}</h2>
        <p id={descId} className={styles.modalBody}>{labels.settings.deleteModalBody}</p>

        <div className={styles.modalField}>
          <label htmlFor="delete-email-confirm" className={styles.modalLabel}>
            {labels.settings.deleteEmailLabel}
          </label>
          <input
            ref={firstFocusRef}
            id="delete-email-confirm"
            className={styles.modalInput}
            type="email"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={email}
            autoComplete="off"
            aria-describedby={descId}
            disabled={isDeleting}
          />
        </div>

        {error && (
          <p className={styles.modalError} aria-live="polite" role="alert">{error}</p>
        )}

        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.deleteConfirmButton}
            onClick={onConfirm}
            disabled={!canDelete || isDeleting}
            aria-disabled={!canDelete || isDeleting}
          >
            {isDeleting ? labels.settings.deleteLoadingButton : labels.settings.deleteConfirmButton}
          </button>
          <button
            type="button"
            className={styles.modalCancelButton}
            onClick={onCancel}
            disabled={isDeleting}
          >
            {labels.settings.deleteCancelButton}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Settings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { signOut } = useAuth();
  const { theme, setTheme } = useTheme();

  // Theme save state
  const [themeSaveState, setThemeSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Display name edit
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  // Change password
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [passwordError, setPasswordError] = useState('');

  // Delete account modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  // Report modal
  const [reportModalType, setReportModalType] = useState<ReportType | null>(null);

  const { data, isLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  const themeMutation = useAuthedMutation<unknown, { preferences: { theme: string } }>(
    '/api/manage/settings',
    'PUT',
    {
      onSuccess: () => {
        setThemeSaveState('saved');
        setTimeout(() => setThemeSaveState('idle'), 1500);
        queryClient.invalidateQueries({ queryKey: ['settings'] });
      },
      onError: () => setThemeSaveState('idle'),
    }
  );

  useEffect(() => {
    document.title = labels.settings.documentTitle;
  }, []);

  // ── Theme ──────────────────────────────────────────────────────────────────

  async function handleThemeChange(t: 'light' | 'dark' | 'system') {
    setTheme(t);
    setThemeSaveState('saving');
    themeMutation.mutate({ preferences: { theme: t } });
  }

  // ── Display name ───────────────────────────────────────────────────────────

  function startEditName() {
    setNameValue(s?.displayName ?? '');
    setEditingName(true);
  }

  async function saveDisplayName() {
    if (nameSaving) return;
    const trimmed = nameValue.trim();
    if (trimmed === (s?.displayName ?? '')) { setEditingName(false); return; }
    setNameSaving(true);
    try {
      await authedMutate('/api/manage/settings', 'PUT', { displayName: trimmed }, navigate);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } finally {
      setNameSaving(false);
      setEditingName(false);
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); saveDisplayName(); }
    if (e.key === 'Escape') { setEditingName(false); }
  }

  // ── Change password ────────────────────────────────────────────────────────

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword) return;
    setPasswordStatus('saving');
    setPasswordError('');
    try {
      await updatePassword({ oldPassword: currentPassword, newPassword });
      setPasswordStatus('saved');
      setCurrentPassword('');
      setNewPassword('');
      setTimeout(() => {
        setPasswordStatus('idle');
        setPasswordOpen(false);
      }, 2000);
    } catch (err) {
      setPasswordError(mapCognitoPasswordError(err));
      setPasswordStatus('error');
    }
  }

  function cancelPasswordChange() {
    setPasswordOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setPasswordStatus('idle');
    setPasswordError('');
  }

  // ── Sign out ───────────────────────────────────────────────────────────────

  async function handleSignOut() {
    await signOut();
    navigate('/admin/login', { replace: true });
  }

  // ── Delete account ─────────────────────────────────────────────────────────

  async function handleDeleteConfirm() {
    setIsDeleting(true);
    setDeleteError('');
    try {
      await authedMutate('/api/manage/account', 'DELETE', { confirmEmail: s?.email }, navigate);
      await signOut();
      navigate('/', { replace: true });
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 404) {
        // Cognito user already deleted — treat as success
        await signOut();
        navigate('/', { replace: true });
        return;
      }
      setDeleteError(labels.settings.deleteServerError);
      setIsDeleting(false);
    }
  }

  function handleDeleteCancel() {
    setShowDeleteModal(false);
    setDeleteError('');
    setTimeout(() => deleteButtonRef.current?.focus(), 50);
  }

  const s = data?.data;
  const itemCount    = s?.usage?.itemCount    ?? 0;
  const sessionCount = s?.usage?.sessionCount ?? 0;
  const maxItems     = s?.features?.maxActiveItems    ?? 1;
  const maxSessions  = s?.features?.maxSessionsPerItem ?? 5;

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>{labels.settings.title}</h1>

      {/* ── Account ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.accountSection}</h2>
        <div className={styles.fieldGrid}>
          {isLoading ? (
            <>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.emailLabel}</span>
                <div className={`${styles.skeleton} ${styles.skeletonMed}`} />
              </div>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.tierLabel}</span>
                <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
              </div>
            </>
          ) : (
            <>
              {s?.email && (
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>{labels.settings.emailLabel}</span>
                  <span className={styles.fieldValue}>{s.email}</span>
                </div>
              )}
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.displayNameLabel}</span>
                {editingName ? (
                  <div className={styles.inlineEditRow}>
                    <input
                      className={styles.inlineNameInput}
                      value={nameValue}
                      onChange={e => setNameValue(e.target.value)}
                      onKeyDown={handleNameKeyDown}
                      disabled={nameSaving}
                      autoFocus
                      maxLength={255}
                      placeholder={labels.settings.displayNamePlaceholder}
                      aria-label={labels.settings.displayNameLabel}
                    />
                    <button type="button" className={styles.inlineSaveButton} onClick={saveDisplayName} disabled={nameSaving}>
                      {nameSaving ? labels.settings.savingName : labels.settings.saveButton}
                    </button>
                    <button type="button" className={styles.inlineCancelButton} onClick={() => setEditingName(false)} disabled={nameSaving}>
                      {labels.settings.cancelButton}
                    </button>
                  </div>
                ) : (
                  <div className={styles.inlineEditRow}>
                    <span className={styles.fieldValue}>{s?.displayName ?? labels.settings.displayNameAdd}</span>
                    <button type="button" className={styles.editButton} onClick={startEditName}>
                      {labels.settings.editButton}
                    </button>
                  </div>
                )}
              </div>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.tierLabel}</span>
                <span>
                  <span className={styles.tierBadge}>
                    {s?.tier === 'free' ? labels.settings.tierFree : (s?.tier ?? labels.settings.tierFree)}
                  </span>
                </span>
              </div>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.changePasswordHeading}</span>
                {passwordOpen ? (
                  <form onSubmit={handleChangePassword} noValidate className={styles.passwordInlineForm}>
                    <input
                      type="password"
                      className={styles.passwordInlineInput}
                      value={currentPassword}
                      onChange={e => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                      placeholder={labels.settings.currentPasswordLabel}
                      disabled={passwordStatus === 'saving'}
                      autoFocus
                      aria-label={labels.settings.currentPasswordLabel}
                    />
                    <input
                      type="password"
                      className={styles.passwordInlineInput}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder={labels.settings.newPasswordLabel}
                      disabled={passwordStatus === 'saving'}
                      aria-label={labels.settings.newPasswordLabel}
                    />
                    <div className={styles.passwordInlineActions}>
                      <button
                        type="submit"
                        className={styles.inlineSaveButton}
                        disabled={passwordStatus === 'saving' || !currentPassword || !newPassword}
                      >
                        {passwordStatus === 'saving' ? labels.settings.updatingPassword : labels.settings.updatePasswordButton}
                      </button>
                      <button type="button" className={styles.inlineCancelButton} onClick={cancelPasswordChange} disabled={passwordStatus === 'saving'}>
                        {labels.settings.cancelButton}
                      </button>
                    </div>
                    {passwordStatus === 'saved' && (
                      <p className={styles.passwordSuccess} aria-live="polite">{labels.settings.passwordUpdated}</p>
                    )}
                    {passwordStatus === 'error' && passwordError && (
                      <p className={styles.passwordError} role="alert" aria-live="polite">{passwordError}</p>
                    )}
                  </form>
                ) : (
                  <div className={styles.inlineEditRow}>
                    <span className={styles.fieldValue}>••••••••</span>
                    <button type="button" className={styles.editButton} onClick={() => setPasswordOpen(true)}>
                      Change
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Usage ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.usageSection}</h2>
        {isLoading ? (
          <div className={styles.fieldGrid}>
            <div className={`${styles.skeleton} ${styles.skeletonMed}`} style={{ height: 40 }} />
            <div className={`${styles.skeleton} ${styles.skeletonMed}`} style={{ height: 40 }} />
          </div>
        ) : (
          <div className={styles.fieldGrid}>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>{labels.settings.itemsLabel}</span>
                <span className={styles.usageCount}>
                  {labels.settings.itemsUsage
                    .replace('{used}', String(itemCount))
                    .replace('{max}', String(maxItems))}
                </span>
              </div>
              <UsageBar used={itemCount} max={maxItems} />
            </div>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>{labels.settings.sessionsLabel}</span>
                <span className={styles.usageCount}>
                  {labels.settings.sessionsUsage
                    .replace('{used}', String(sessionCount))
                    .replace('{max}', String(maxSessions))}
                </span>
              </div>
              <UsageBar used={sessionCount} max={maxSessions} />
            </div>
          </div>
        )}
      </section>

      {/* ── Appearance ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.themeSection}</h2>
        <div className={styles.themeGroup} role="group" aria-label={labels.settings.themeLabel}>
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => handleThemeChange(t)}
              aria-pressed={theme === t}
              className={`${styles.themeButton} ${theme === t ? styles.themeButtonActive : ''}`}
            >
              {labels.settings[`theme${t.charAt(0).toUpperCase() + t.slice(1)}` as 'themeLight' | 'themeDark' | 'themeSystem']}
            </button>
          ))}
        </div>
        {themeSaveState !== 'idle' && (
          <p className={styles.themeSaving} aria-live="polite">
            {themeSaveState === 'saving' ? labels.settings.themeSaving : labels.settings.themeSaved}
          </p>
        )}
      </section>

      {/* ── Sign out ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Account actions</h2>
        <div className={styles.actionsSection}>
          <button type="button" className={styles.signOutButton} onClick={handleSignOut}>
            {labels.settings.signOutButton}
          </button>
        </div>
      </section>

      {/* ── Support ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.support.sectionHeading}</h2>
        <div className={styles.fieldGrid}>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{labels.support.contactLink}</span>
            <div className={styles.inlineEditRow}>
              <button type="button" className={styles.supportActionButton} onClick={() => setReportModalType('general-inquiry')}>
                Open
              </button>
            </div>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{labels.support.bugLink}</span>
            <div className={styles.inlineEditRow}>
              <button type="button" className={styles.supportActionButton} onClick={() => setReportModalType('bug-report')}>
                Open
              </button>
            </div>
          </div>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{labels.support.featureLink}</span>
            <div className={styles.inlineEditRow}>
              <button type="button" className={styles.supportActionButton} onClick={() => setReportModalType('feature-request')}>
                Open
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Privacy ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.support.privacySectionHeading}</h2>
        <div className={styles.fieldGrid}>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{labels.support.privacyLink}</span>
            <div className={styles.inlineEditRow}>
              <button type="button" className={styles.supportActionButton} onClick={() => setReportModalType('privacy-question')}>
                Open
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Danger Zone ── */}
      <section className={styles.section}>
        <h2 className={`${styles.sectionHeading} ${styles.dangerHeading}`}>{labels.settings.dangerZoneHeading}</h2>
        <div className={styles.dangerZone}>
          <p className={styles.dangerDescription}>{labels.settings.dangerZoneDescription}</p>
          <button
            ref={deleteButtonRef}
            type="button"
            className={styles.deleteButton}
            onClick={() => setShowDeleteModal(true)}
          >
            {labels.settings.deleteAccountButton}
          </button>
        </div>
      </section>

      {/* ── Delete modal ── */}
      {showDeleteModal && (
        <DeleteModal
          email={s?.email ?? ''}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
          isDeleting={isDeleting}
          error={deleteError}
        />
      )}

      {/* ── Report modal ── */}
      {reportModalType && (
        <ReportModal
          type={reportModalType}
          prefillName={s?.displayName ?? ''}
          prefillEmail={s?.email ?? ''}
          onClose={() => setReportModalType(null)}
        />
      )}
    </div>
  );
}
