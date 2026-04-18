import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useCan } from '../hooks/useCan';
import { getItemActions } from '../utils/itemActions';
import styles from './InviteModal.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = 'not_started' | 'in_progress' | 'completed' | 'expired' | 'discarded' | 'cancelled';

interface Session {
  sessionId: string;
  reviewerEmail: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt?: string;
  isPublic?: boolean;
  isSelfReview?: boolean;
  sessionName?: string;
}

interface PublicQrResult {
  qrCodeUrl: string;
  pulseCode: string;
  sessionLink: string;
  sessionName?: string | null;
}

interface Props {
  itemId: string;
  itemName: string;
  itemStatus?: 'draft' | 'active' | 'closed' | 'revised';
  hasCompletedRevision?: boolean;
  onClose: () => void;
  skipLabel?: string;
  onSelfReview?: () => void;
}

function nowDatetimeLocal(): string {
  // Returns current datetime in "YYYY-MM-DDTHH:MM" format for datetime-local inputs
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'not_started': return labels.invitation.statusNotStarted;
    case 'in_progress':  return labels.invitation.statusInProgress;
    case 'completed':    return labels.invitation.statusCompleted;
    case 'expired':      return labels.invitation.statusExpired;
    case 'discarded':    return labels.invitation.statusDiscarded;
    case 'cancelled':   return labels.invitation.statusCancelled;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InviteModal({ itemId, itemName, itemStatus, hasCompletedRevision, onClose, skipLabel, onSelfReview }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const focusTrapRef = useFocusTrap();

  // ── Reviewer invite state ──
  const [inviteEmails, setInviteEmails] = useState('');
  const [inviteError, setInviteError]   = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [isInviting, setIsInviting]     = useState(false);

  const [resendingId, setResendingId]   = useState<string | null>(null);
  const [resendMessages, setResendMessages] = useState<Record<string, string>>({});
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelMessages, setCancelMessages] = useState<Record<string, string>>({});

  // ── Extend deadline state ──
  const [extendDate, setExtendDate]     = useState('');
  const [isExtending, setIsExtending]   = useState(false);
  const [extendMessage, setExtendMessage] = useState('');

  // ── Public session create form state ──
  const [publicSessionDate, setPublicSessionDate] = useState('');
  const [publicSessionName, setPublicSessionName] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [publicSessionError, setPublicSessionError] = useState('');

  // ── View QR for existing public session ──
  const [viewingQrSessionId, setViewingQrSessionId] = useState<string | null>(null);
  const [viewingQrResult, setViewingQrResult] = useState<PublicQrResult | null>(null);
  const [viewingQrError, setViewingQrError] = useState('');
  const [isLoadingQr, setIsLoadingQr] = useState(false);

  // ── End public session state ──
  const [endingSessionId, setEndingSessionId] = useState<string | null>(null);
  const [endSessionMessages, setEndSessionMessages] = useState<Record<string, string>>({});

  // ── Session cap limit ──
  const { limit: maxSessionsPerItem } = useCan('maxSessionsPerItem');
  const { allowed: canCreatePublicSessions } = useCan('publicSessions');
  const { allowed: canSelfReview } = useCan('selfReview');

  // ── Derive item actions for Zone 3 ──
  const itemActions = itemStatus
    ? getItemActions({ status: itemStatus, hasPulseCheck: true, hasCompletedRevision })
    : [];
  const showRevisionsLink = itemActions.includes('revisions');

  const { data: sessionsData, refetch: refetchSessions } = useAuthedQuery<{ data: Session[] }>(
    ['sessions', itemId],
    `/api/manage/items/${itemId}/sessions`,
    { staleTime: 0 }
  );
  const sessions = sessionsData?.data ?? [];
  // For self-reviews, only show the most recent one (hide cancelled/discarded predecessors)
  const latestSelfReview = sessions
    .filter(s => s.isSelfReview)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const privateSessions = sessions.filter(s =>
    !s.isPublic && (!s.isSelfReview || s.sessionId === latestSelfReview?.sessionId)
  );
  const publicSessions  = sessions.filter(s => s.isPublic);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Esc to close (stable ref avoids listener churn on every render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

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
      queryClient.setQueryData<{ data: Session[] }>(['sessions', itemId], (old) => ({
        data: (old?.data ?? []).map(s =>
          s.sessionId === sessionId ? { ...s, status: 'cancelled' as SessionStatus } : s
        ),
      }));
      queryClient.invalidateQueries({ queryKey: ['sessions', itemId] });
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
      const body: Record<string, string> = { closeDate: new Date(publicSessionDate).toISOString() };
      if (publicSessionName.trim()) body.sessionName = publicSessionName.trim();

      await authedMutate(
        `/api/manage/items/${itemId}/public-session`,
        'POST',
        body,
        navigate
      );
      setPublicSessionDate('');
      setPublicSessionName('');
      queryClient.invalidateQueries({ queryKey: ['sessions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      refetchSessions();
    } catch {
      setPublicSessionError(labels.invitation.publicSessionError);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleViewQr(sessionId: string) {
    if (viewingQrSessionId === sessionId) {
      setViewingQrSessionId(null);
      setViewingQrResult(null);
      return;
    }
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

  async function handleEndPublicSession(sessionId: string) {
    setEndSessionMessages(prev => ({ ...prev, [sessionId]: '' }));
    setEndingSessionId(sessionId);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/sessions/${sessionId}/expire`,
        'PUT',
        {},
        navigate
      );
      setEndSessionMessages(prev => ({ ...prev, [sessionId]: labels.invitation.publicSessionEndSuccess }));
      const endedAt = new Date().toISOString();
      queryClient.setQueryData<{ data: Session[] }>(['sessions', itemId], (old) => ({
        data: (old?.data ?? []).map(s =>
          s.sessionId === sessionId ? { ...s, status: 'expired' as SessionStatus, expiresAt: endedAt } : s
        ),
      }));
      queryClient.invalidateQueries({ queryKey: ['items'] });
    } catch {
      setEndSessionMessages(prev => ({ ...prev, [sessionId]: labels.invitation.publicSessionEndError }));
    } finally {
      setEndingSessionId(null);
    }
  }

  async function handleExtendDeadline(e: React.FormEvent) {
    e.preventDefault();
    setExtendMessage('');
    if (!extendDate) return;

    setIsExtending(true);
    try {
      // datetime-local gives "2026-04-15T14:30" in the user's local time with no timezone.
      // Convert to UTC ISO 8601 so the Lambda compares against the correct time.
      const closeDateUTC = new Date(extendDate).toISOString();
      await authedMutate(`/api/manage/items/${itemId}/deadline`, 'PUT', { closeDate: closeDateUTC }, navigate);
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={focusTrapRef}
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
              {labels.inviteModal.title}
            </h2>
            <p className={styles.itemName}>{itemName}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Body */}
        <div className={styles.modalBody}>

          {/* ═══ Zone 1: Create Sessions ═══ */}
          <section className={styles.zone} aria-labelledby="zone-create-sessions">
            <h3 id="zone-create-sessions" className={styles.zoneHeading}>Create Sessions</h3>

            {/* Invite reviewers email form */}
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
                <p role="alert" aria-live="polite" className={inviteError ? styles.error : styles.success}>
                  {inviteError || inviteSuccess}
                </p>
              )}
              <button type="submit" className={styles.primaryButton} disabled={isInviting}>
                {isInviting ? labels.invitation.inviting : labels.invitation.inviteButton}
              </button>
            </form>

            {/* Self-review button — hidden for tiers without selfReview */}
            {onSelfReview && canSelfReview && (
              <div className={styles.selfReviewZoneRow}>
                <button type="button" className={styles.selfReviewButton} onClick={onSelfReview}>
                  {labels.itemDetail.selfReviewButton}
                </button>
              </div>
            )}

            {/* Create public session form — hidden for tiers without publicSessions */}
            {canCreatePublicSessions && (
              <>
                <div className={styles.publicSessionDivider} />
                <h4 className={styles.subHeading}>{labels.invitation.publicSessionTitle}</h4>
                <p className={styles.hint}>{labels.invitation.publicSessionDescription}</p>
                {maxSessionsPerItem !== null && (
                  <p className={styles.publicSessionLimitHint}>
                    {labels.invitation.publicSessionLimitHint.replace('{max}', String(maxSessionsPerItem))}
                  </p>
                )}
                <form onSubmit={handleGeneratePublicSession} noValidate className={styles.publicSessionPanel}>
                  <label htmlFor="publicSessionName" className={styles.label}>
                    {labels.invitation.publicSessionNameLabel}
                  </label>
                  <p className={styles.hint}>{labels.invitation.publicSessionNameHint}</p>
                  <input
                    id="publicSessionName"
                    type="text"
                    className={styles.publicSessionNameInput}
                    value={publicSessionName}
                    onChange={e => setPublicSessionName(e.target.value)}
                    placeholder={labels.invitation.publicSessionNamePlaceholder}
                    disabled={isGenerating}
                    maxLength={100}
                  />
                  <label htmlFor="publicSessionDate" className={styles.label} style={{ marginTop: '0.5rem' }}>
                    {labels.invitation.publicSessionDeadlineLabel}
                  </label>
                  <div className={styles.extendRow}>
                    <input
                      id="publicSessionDate"
                      type="datetime-local"
                      className={styles.input}
                      value={publicSessionDate}
                      onChange={e => setPublicSessionDate(e.target.value)}
                      min={nowDatetimeLocal()}
                      disabled={isGenerating}
                    />
                    <button
                      type="submit"
                      className={styles.primaryButton}
                      disabled={isGenerating || !publicSessionDate}
                    >
                      {isGenerating ? labels.invitation.publicSessionGenerating : labels.invitation.publicSessionGenerateButton}
                    </button>
                  </div>
                  {publicSessionError && (
                    <p role="alert" aria-live="polite" className={styles.error}>{publicSessionError}</p>
                  )}
                </form>
              </>
            )}
          </section>

          {/* ═══ Zone 2: Active Sessions ═══ */}
          <section className={styles.zone} aria-labelledby="zone-active-sessions">
            <h3 id="zone-active-sessions" className={styles.zoneHeading}>Active Sessions</h3>

            {/* Private sessions list */}
            {privateSessions.length > 0 && (
              <>
                <h4 className={styles.subHeading}>Reviewer Sessions</h4>
                <ul className={styles.sessionList} aria-label="Reviewer sessions">
                {privateSessions.map(session => (
                  <li key={session.sessionId} className={styles.sessionRow}>
                    <div className={styles.sessionInfo}>
                      <span className={styles.maskedEmail}>{session.reviewerEmail}</span>
                      <span className={`${styles.statusBadge} ${styles[`status_${session.status}`]}`}>
                        {sessionStatusLabel(session.status)}
                      </span>
                      {session.isSelfReview && (
                        <span className={styles.selfReviewBadge}>
                          Self-review
                        </span>
                      )}
                    </div>
                    <div className={styles.sessionMeta}>
                      <span className={styles.sessionDate}>
                        Invited {new Date(session.createdAt).toLocaleDateString()}
                      </span>
                      {!session.isSelfReview && (session.status === 'not_started' || session.status === 'discarded') && (
                        <div className={styles.sessionActions}>
                          <button
                            type="button"
                            className={styles.resendButton}
                            onClick={() => handleResend(session.sessionId)}
                            disabled={resendingId === session.sessionId || cancellingId === session.sessionId}
                          >
                            {resendingId === session.sessionId ? labels.invitation.resending : labels.invitation.resendButton}
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
                      <p aria-live="polite" className={styles.resendMessage}>{resendMessages[session.sessionId]}</p>
                    )}
                    {cancelMessages[session.sessionId] && (
                      <p aria-live="polite" className={styles.error}>{cancelMessages[session.sessionId]}</p>
                    )}
                  </li>
                ))}
              </ul>
              </>
            )}

            {privateSessions.length === 0 && publicSessions.length === 0 && (
              <p className={styles.emptyState}>{labels.invitation.noSessions}</p>
            )}

            <p className={styles.retentionNotice}>{labels.retention.shortNotice}</p>

            {/* Public sessions list */}
            {publicSessions.length > 0 && (
              <>
                <h4 className={styles.subHeading} style={{ marginTop: 'var(--space-4)' }}>{labels.invitation.publicSessionSectionTitle}</h4>
                <ul className={styles.sessionList} aria-label="Public sessions">
                  {publicSessions.map(session => (
                    <li key={session.sessionId} className={styles.sessionRow}>
                      <div className={styles.sessionInfo}>
                        <span className={styles.maskedEmail}>
                          {session.sessionName ?? labels.invitation.publicSessionBadge}
                        </span>
                        <span className={styles.publicSessionBadge}>Public</span>
                        <span className={`${styles.statusBadge} ${styles[`status_${session.status}`]}`}>
                          {sessionStatusLabel(session.status)}
                        </span>
                      </div>
                      <div className={styles.sessionMeta}>
                        {session.expiresAt && (
                          <span className={styles.sessionEndDate}>
                            {labels.invitation.publicSessionEndsLabel} {formatDeadline(session.expiresAt)}
                          </span>
                        )}
                        <div className={styles.sessionActions}>
                          <button
                            type="button"
                            className={styles.resendButton}
                            onClick={() => handleViewQr(session.sessionId)}
                            disabled={(isLoadingQr && viewingQrSessionId === session.sessionId) || session.status === 'expired'}
                            style={session.status === 'expired' ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
                          >
                            {isLoadingQr && viewingQrSessionId === session.sessionId
                              ? '…'
                              : viewingQrSessionId === session.sessionId
                                ? labels.invitation.publicSessionHideQr
                                : labels.invitation.publicSessionViewQr}
                          </button>
                          {(session.status === 'not_started' || session.status === 'in_progress') && (
                            <button
                              type="button"
                              className={styles.endSessionButton}
                              onClick={() => handleEndPublicSession(session.sessionId)}
                              disabled={endingSessionId === session.sessionId}
                            >
                              {endingSessionId === session.sessionId
                                ? labels.invitation.publicSessionEnding
                                : labels.invitation.publicSessionEndButton}
                            </button>
                          )}
                        </div>
                      </div>
                      {endSessionMessages[session.sessionId] && (
                        <p aria-live="polite" className={styles.resendMessage}>{endSessionMessages[session.sessionId]}</p>
                      )}
                      {/* Inline QR panel */}
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
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {publicSessions.length === 0 && (
              <p className={styles.emptyState} style={{ marginTop: '0.75rem' }}>{labels.invitation.noPublicSessions}</p>
            )}
          </section>

          {/* ═══ Zone 3: Item Actions ═══ */}
          <section className={styles.zone} aria-labelledby="zone-item-actions">
            <h3 id="zone-item-actions" className={styles.zoneHeading}>Item Actions</h3>

            {/* Extend deadline */}
            <form onSubmit={handleExtendDeadline} noValidate className={styles.extendForm}>
              <label htmlFor="extendDate" className={styles.label}>
                {labels.invitation.extendDeadlineLabel}
              </label>
              <div className={styles.extendRow}>
                <input
                  id="extendDate"
                  type="datetime-local"
                  className={styles.input}
                  value={extendDate}
                  onChange={e => setExtendDate(e.target.value)}
                  min={nowDatetimeLocal()}
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

            {/* Revisions link — shown for closed/revised items with completed revisions */}
            {showRevisionsLink && (
              <div className={styles.revisionsLinkRow}>
                <Link to={`/admin/items/${itemId}/revisions`} className={styles.revisionsLink}>
                  {labels.itemCard.revisions}
                </Link>
              </div>
            )}

            {/* Pulse Check link — shown for active items (Close & Run) and closed/revised items */}
            {itemStatus && itemStatus !== 'draft' && (
              <div className={styles.revisionsLinkRow}>
                <Link to={`/admin/pulse-check/${itemId}`} className={styles.revisionsLink}>
                  {labels.itemCard.pulseCheck}
                </Link>
              </div>
            )}
          </section>

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
