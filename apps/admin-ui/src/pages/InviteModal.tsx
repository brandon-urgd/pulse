import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './InviteModal.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = 'not_started' | 'in_progress' | 'completed' | 'expired';

interface Session {
  sessionId: string;
  reviewerEmail: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt?: string;
}

interface Props {
  itemId: string;
  itemName: string;
  onClose: () => void;
  skipLabel?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'not_started': return labels.invitation.statusNotStarted;
    case 'in_progress':  return labels.invitation.statusInProgress;
    case 'completed':    return labels.invitation.statusCompleted;
    case 'expired':      return labels.invitation.statusExpired;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InviteModal({ itemId, itemName, onClose, skipLabel }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [inviteEmails, setInviteEmails] = useState('');
  const [inviteError, setInviteError]   = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [isInviting, setIsInviting]     = useState(false);

  const [resendingId, setResendingId]   = useState<string | null>(null);
  const [resendMessages, setResendMessages] = useState<Record<string, string>>({});
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelMessages, setCancelMessages] = useState<Record<string, string>>({});

  const [extendDate, setExtendDate]     = useState('');
  const [isExtending, setIsExtending]   = useState(false);
  const [extendMessage, setExtendMessage] = useState('');

  const { data: sessionsData, refetch: refetchSessions } = useAuthedQuery<{ data: Session[] }>(
    ['sessions', itemId],
    `/api/manage/items/${itemId}/sessions`,
    { staleTime: 0 }
  );
  const sessions = sessionsData?.data ?? [];

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError('');
    setInviteSuccess('');

    const emails = inviteEmails.split(',').map(s => s.trim()).filter(Boolean);
    if (!emails.length) {
      setInviteError('Please enter at least one email address.');
      return;
    }

    setIsInviting(true);
    try {
      const result = await authedMutate(
        `/api/manage/items/${itemId}/invite`, 'POST', { emails }, navigate
      ) as { data: { sessions: Array<{ sessionId: string; reviewerEmail?: string }> } } | null;
      setInviteEmails('');
      setInviteSuccess(labels.invitation.inviteSuccess);

      // Optimistically append new sessions so they appear immediately
      if (result?.data?.sessions?.length) {
        const newSessions: Session[] = result.data.sessions.map((s, i) => ({
          sessionId: s.sessionId,
          reviewerEmail: emails[i] ?? s.reviewerEmail ?? '',
          status: 'not_started' as SessionStatus,
          createdAt: new Date().toISOString(),
        }));
        queryClient.setQueryData<{ data: Session[] }>(['sessions', itemId], (old) => ({
          data: [...(old?.data ?? []), ...newSessions],
        }));
      }

      // Background refetch to get masked emails from server
      refetchSessions();
      queryClient.invalidateQueries({ queryKey: ['items'] });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      setInviteError(status === 403 ? labels.invitation.inviteLimitError : labels.invitation.inviteError);
    } finally {
      setIsInviting(false);
    }
  }

  async function handleCancel(sessionId: string) {
    setCancelMessages(prev => ({ ...prev, [sessionId]: '' }));
    setCancellingId(sessionId);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/sessions/${sessionId}`,
        'DELETE',
        undefined,
        navigate
      );
      // Remove from list optimistically
      queryClient.setQueryData<{ data: Session[] }>(['sessions', itemId], (old) => ({
        data: (old?.data ?? []).filter(s => s.sessionId !== sessionId),
      }));
      queryClient.invalidateQueries({ queryKey: ['items'] });
    } catch {
      setCancelMessages(prev => ({ ...prev, [sessionId]: 'Failed to cancel. Try again.' }));
    } finally {
      setCancellingId(null);
    }
  }

  async function handleResend(sessionId: string) {
    setResendMessages(prev => ({ ...prev, [sessionId]: '' }));
    setResendingId(sessionId);
    try {
      await authedMutate(`/api/manage/items/${itemId}/sessions/${sessionId}/resend`, 'POST', {}, navigate);
      setResendMessages(prev => ({ ...prev, [sessionId]: labels.invitation.resendSuccess }));
    } catch {
      setResendMessages(prev => ({ ...prev, [sessionId]: labels.invitation.resendError }));
    } finally {
      setResendingId(null);
    }
  }

  async function handleExtendDeadline(e: React.FormEvent) {
    e.preventDefault();
    setExtendMessage('');
    if (!extendDate) return;

    setIsExtending(true);
    try {
      await authedMutate(`/api/manage/items/${itemId}/deadline`, 'PUT', { closeDate: extendDate }, navigate);
      setExtendMessage(labels.invitation.extendSuccess);
      setExtendDate('');
      refetchSessions();
      queryClient.invalidateQueries({ queryKey: ['items'] });
    } catch {
      setExtendMessage(labels.invitation.extendError);
    } finally {
      setIsExtending(false);
    }
  }

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
    >
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <div>
            <h2 id="invite-modal-title" className={styles.modalTitle}>
              {labels.invitation.sectionTitle}
            </h2>
            <p className={styles.itemName}>{itemName}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Body */}
        <div className={styles.modalBody}>
          {/* Invite form */}
          <form onSubmit={handleInvite} noValidate className={styles.inviteForm}>
            <label htmlFor="inviteEmails" className={styles.label}>
              {labels.invitation.emailsLabel}
            </label>
            <p className={styles.hint}>{labels.invitation.emailsHint}</p>
            <textarea
              id="inviteEmails"
              className={styles.textarea}
              value={inviteEmails}
              onChange={e => setInviteEmails(e.target.value)}
              rows={2}
              placeholder={labels.invitation.emailsPlaceholder}
              disabled={isInviting}
            />
            {(inviteError || inviteSuccess) && (
              <p
                role="alert"
                aria-live="polite"
                className={inviteError ? styles.error : styles.success}
              >
                {inviteError || inviteSuccess}
              </p>
            )}
            <button type="submit" className={styles.primaryButton} disabled={isInviting}>
              {isInviting ? labels.invitation.inviting : labels.invitation.inviteButton}
            </button>
          </form>

          <hr className={styles.divider} />

          {/* Session list */}
          <h3 className={styles.subHeading}>{labels.invitation.sectionTitle}</h3>
          {sessions.length === 0 ? (
            <p className={styles.emptyState}>{labels.invitation.noSessions}</p>
          ) : (
            <ul className={styles.sessionList} aria-label="Reviewer sessions">
              {sessions.map(session => (
                <li key={session.sessionId} className={styles.sessionRow}>
                  <div className={styles.sessionInfo}>
                    <span className={styles.maskedEmail}>{session.reviewerEmail}</span>
                    <span className={`${styles.statusBadge} ${styles[`status_${session.status}`]}`}>
                      {sessionStatusLabel(session.status)}
                    </span>
                  </div>
                  <div className={styles.sessionMeta}>
                    <span className={styles.sessionDate}>
                      Invited {new Date(session.createdAt).toLocaleDateString()}
                    </span>
                    {session.status === 'not_started' && (
                      <div className={styles.sessionActions}>
                        <button
                          type="button"
                          className={styles.resendButton}
                          onClick={() => handleResend(session.sessionId)}
                          disabled={resendingId === session.sessionId || cancellingId === session.sessionId}
                        >
                          {resendingId === session.sessionId
                            ? labels.invitation.resending
                            : labels.invitation.resendButton}
                        </button>
                        <button
                          type="button"
                          className={styles.cancelInviteButton}
                          onClick={() => handleCancel(session.sessionId)}
                          disabled={cancellingId === session.sessionId || resendingId === session.sessionId}
                        >
                          {cancellingId === session.sessionId ? '…' : 'Cancel invite'}
                        </button>
                      </div>
                    )}
                  </div>
                  {resendMessages[session.sessionId] && (
                    <p aria-live="polite" className={styles.resendMessage}>
                      {resendMessages[session.sessionId]}
                    </p>
                  )}
                  {cancelMessages[session.sessionId] && (
                    <p aria-live="polite" className={styles.error}>
                      {cancelMessages[session.sessionId]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <hr className={styles.divider} />

          {/* Extend deadline */}
          <form onSubmit={handleExtendDeadline} noValidate className={styles.extendForm}>
            <h3 className={styles.subHeading}>{labels.invitation.extendDeadlineTitle}</h3>
            <label htmlFor="extendDate" className={styles.label}>
              {labels.invitation.extendDeadlineLabel}
            </label>
            <div className={styles.extendRow}>
              <input
                id="extendDate"
                type="date"
                className={styles.input}
                value={extendDate}
                onChange={e => setExtendDate(e.target.value)}
                min={todayIso()}
                disabled={isExtending}
              />
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={isExtending || !extendDate}
              >
                {isExtending ? labels.invitation.extending : labels.invitation.extendDeadlineButton}
              </button>
            </div>
            {extendMessage && (
              <p aria-live="polite" className={styles.success}>{extendMessage}</p>
            )}
          </form>

          {skipLabel && (
            <div className={styles.skipRow}>
              <button type="button" className={styles.skipButton} onClick={onClose}>
                {skipLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
