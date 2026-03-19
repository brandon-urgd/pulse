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
  isPublic?: boolean;
}

interface PublicQrResult {
  qrCodeUrl: string;
  pulseCode: string;
  sessionLink: string;
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

  // Public session sub-panel state
  const [showPublicSession, setShowPublicSession] = useState(false);
  const [publicSessionDate, setPublicSessionDate] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [publicSessionResult, setPublicSessionResult] = useState<{
    pulseCode: string;
    sessionLink: string;
    qrCodeUrl: string | null;
  } | null>(null);
  const [publicSessionError, setPublicSessionError] = useState('');

  // View QR for existing public session
  const [viewingQrSessionId, setViewingQrSessionId] = useState<string | null>(null);
  const [viewingQrResult, setViewingQrResult] = useState<PublicQrResult | null>(null);
  const [viewingQrError, setViewingQrError] = useState('');
  const [isLoadingQr, setIsLoadingQr] = useState(false);

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

  async function handleGeneratePublicSession(e: React.FormEvent) {
    e.preventDefault();
    setPublicSessionError('');
    if (!publicSessionDate) return;

    setIsGenerating(true);
    try {
      const result = await authedMutate(
        `/api/manage/items/${itemId}/public-session`,
        'POST',
        { closeDate: publicSessionDate },
        navigate
      ) as { sessionId: string; pulseCode: string; sessionLink: string; qrCodeUrl: string | null };
      setPublicSessionResult({
        pulseCode: result.pulseCode,
        sessionLink: result.sessionLink,
        qrCodeUrl: result.qrCodeUrl,
      });
      queryClient.invalidateQueries({ queryKey: ['sessions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    } catch {
      setPublicSessionError(labels.invitation.publicSessionError);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleViewQr(sessionId: string) {
    setViewingQrSessionId(sessionId);
    setViewingQrResult(null);
    setViewingQrError('');
    setIsLoadingQr(true);
    try {
      const { fetchAuthSession } = await import('aws-amplify/auth');
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString();
      if (!token) throw new Error('No token');
      const apiBase = import.meta.env.VITE_API_BASE_URL ?? '';
      const res = await fetch(`${apiBase}/api/manage/items/${itemId}/sessions/${sessionId}/qr`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw Object.assign(new Error('Failed'), { status: res.status });
      const data = await res.json() as PublicQrResult;
      setViewingQrResult(data);
    } catch {
      setViewingQrError(labels.invitation.publicSessionQrError);
    } finally {
      setIsLoadingQr(false);
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

          {/* Public session sub-panel */}
          {!showPublicSession ? (
            <div className={styles.publicSessionRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => { setShowPublicSession(true); setPublicSessionResult(null); setPublicSessionError(''); }}
              >
                {labels.invitation.publicSessionTitle}
              </button>
              <p className={styles.hint}>{labels.invitation.publicSessionDescription}</p>
            </div>
          ) : publicSessionResult ? (
            <div className={styles.publicSessionPanel}>
              <h3 className={styles.subHeading}>{labels.invitation.publicSessionTitle}</h3>
              {publicSessionResult.qrCodeUrl && (
                <div className={styles.qrWrapper}>
                  <img
                    src={publicSessionResult.qrCodeUrl}
                    alt="QR code for public session"
                    className={styles.qrImage}
                  />
                  <a
                    href={publicSessionResult.qrCodeUrl}
                    download="pulse-public-session-qr.png"
                    className={styles.downloadLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {labels.invitation.publicSessionDownloadQr}
                  </a>
                </div>
              )}
              <p className={styles.pulseCodeDisplay}>{publicSessionResult.pulseCode}</p>
              <p className={styles.sessionLinkText}>
                <a href={publicSessionResult.sessionLink} target="_blank" rel="noreferrer">
                  {publicSessionResult.sessionLink}
                </a>
              </p>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => { setShowPublicSession(false); setPublicSessionResult(null); setPublicSessionDate(''); }}
              >
                {labels.invitation.publicSessionDoneButton}
              </button>
            </div>
          ) : (
            <form onSubmit={handleGeneratePublicSession} noValidate className={styles.publicSessionPanel}>
              <h3 className={styles.subHeading}>{labels.invitation.publicSessionTitle}</h3>
              <p className={styles.hint}>{labels.invitation.publicSessionDescription}</p>
              <label htmlFor="publicSessionDate" className={styles.label}>
                {labels.invitation.publicSessionDeadlineLabel}
              </label>
              <div className={styles.extendRow}>
                <input
                  id="publicSessionDate"
                  type="date"
                  className={styles.input}
                  value={publicSessionDate}
                  onChange={e => setPublicSessionDate(e.target.value)}
                  min={todayIso()}
                  disabled={isGenerating}
                />
                <button
                  type="submit"
                  className={styles.primaryButton}
                  disabled={isGenerating || !publicSessionDate}
                >
                  {isGenerating ? labels.invitation.publicSessionGenerating : labels.invitation.publicSessionGenerateButton}
                </button>
                <button
                  type="button"
                  className={styles.skipButton}
                  onClick={() => { setShowPublicSession(false); setPublicSessionError(''); }}
                  disabled={isGenerating}
                >
                  Cancel
                </button>
              </div>
              {publicSessionError && (
                <p role="alert" aria-live="polite" className={styles.error}>{publicSessionError}</p>
              )}
            </form>
          )}

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
                    <span className={styles.maskedEmail}>
                      {session.isPublic ? labels.invitation.publicSessionBadge : session.reviewerEmail}
                    </span>
                    <span className={`${styles.statusBadge} ${styles[`status_${session.status}`]}`}>
                      {sessionStatusLabel(session.status)}
                    </span>
                  </div>
                  <div className={styles.sessionMeta}>
                    <span className={styles.sessionDate}>
                      Invited {new Date(session.createdAt).toLocaleDateString()}
                    </span>
                    {session.isPublic ? (
                      <button
                        type="button"
                        className={styles.resendButton}
                        onClick={() => handleViewQr(session.sessionId)}
                        disabled={isLoadingQr && viewingQrSessionId === session.sessionId}
                      >
                        {isLoadingQr && viewingQrSessionId === session.sessionId
                          ? '…'
                          : labels.invitation.publicSessionViewQr}
                      </button>
                    ) : session.status === 'not_started' ? (
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
                    ) : null}
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
                  {/* Inline QR viewer for this public session */}
                  {viewingQrSessionId === session.sessionId && (
                    <div className={styles.inlineQrPanel}>
                      {viewingQrError && (
                        <p role="alert" className={styles.error}>{viewingQrError}</p>
                      )}
                      {viewingQrResult && (
                        <>
                          {viewingQrResult.qrCodeUrl && (
                            <div className={styles.qrWrapper}>
                              <img
                                src={viewingQrResult.qrCodeUrl}
                                alt="QR code for public session"
                                className={styles.qrImage}
                              />
                              <a
                                href={viewingQrResult.qrCodeUrl}
                                download="pulse-public-session-qr.png"
                                className={styles.downloadLink}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {labels.invitation.publicSessionDownloadQr}
                              </a>
                            </div>
                          )}
                          <p className={styles.pulseCodeDisplay}>{viewingQrResult.pulseCode}</p>
                          <p className={styles.sessionLinkText}>
                            <a href={viewingQrResult.sessionLink} target="_blank" rel="noreferrer">
                              {viewingQrResult.sessionLink}
                            </a>
                          </p>
                        </>
                      )}
                      <button
                        type="button"
                        className={styles.skipButton}
                        onClick={() => { setViewingQrSessionId(null); setViewingQrResult(null); }}
                      >
                        {labels.invitation.publicSessionHideQr}
                      </button>
                    </div>
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

          <div className={styles.modalFooter}>
            {skipLabel && (
              <button type="button" className={styles.skipButton} onClick={onClose}>
                {skipLabel}
              </button>
            )}
            <button type="button" className={styles.secondaryButton} onClick={onClose}>
              {labels.invitation.closeButton}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
