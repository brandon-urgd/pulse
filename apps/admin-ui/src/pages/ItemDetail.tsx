import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import InviteModal from './InviteModal';
import styles from './ItemDetail.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type ItemStatus = 'draft' | 'active' | 'closed' | 'revised';
type DocumentStatus =
  | 'none'
  | 'scanning'
  | 'extracting'
  | 'ready'
  | 'rejected'
  | 'extraction_failed';

type FileUploadStatus = 'uploading' | 'scanning' | 'extracting' | 'ready' | 'rejected' | 'extraction_failed' | 'error';
type SessionStatus = 'not_started' | 'in_progress' | 'completed' | 'expired' | 'discarded';

interface FileUploadState {
  status: FileUploadStatus;
  error?: string;
}

interface Item {
  itemId: string;
  itemName: string;
  description: string;
  status: ItemStatus;
  closeDate: string;
  content?: string;
  documentStatus?: DocumentStatus;
  sessionCount: number;
  updatedAt: string;
}

interface Session {
  sessionId: string;
  reviewerEmail: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt?: string;
  isPublic?: boolean;
}

interface CreateItemPayload {
  itemName: string;
  description: string;
  closeDate: string;
  content?: string;
}

interface UpdateItemPayload {
  itemName: string;
  description: string;
  closeDate: string;
  content?: string;
}

interface UploadUrlResponse {
  data: {
    uploadUrl: string;
    key: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fileStatusLabel(status: FileUploadStatus): string {
  switch (status) {
    case 'uploading': return labels.itemDetail.uploadStatusUploading;
    case 'scanning': return labels.itemDetail.uploadStatusScanning;
    case 'extracting': return labels.itemDetail.uploadStatusExtracting;
    case 'ready': return labels.itemDetail.uploadStatusReady;
    case 'rejected': return labels.itemDetail.uploadStatusRejected;
    case 'extraction_failed': return labels.itemDetail.uploadStatusExtractionFailed;
    case 'error': return labels.itemDetail.uploadStatusError;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const isEditMode = Boolean(itemId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Form state
  const [itemName, setItemName] = useState('');
  const [description, setDescription] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [content, setContent] = useState('');

  // UI state
  const [formError, setFormError] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);

  // Invitation state
  const [inviteEmails, setInviteEmails] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendMessages, setResendMessages] = useState<Record<string, string>>({});
  const [extendDate, setExtendDate] = useState('');
  const [isExtending, setIsExtending] = useState(false);
  const [extendMessage, setExtendMessage] = useState('');

  // Close item state — removed (flow moved to Pulse Check page)

  // Cancel session state
  const [cancellingSessionId, setCancellingSessionId] = useState<string | null>(null);
  const [cancelMessages, setCancelMessages] = useState<Record<string, string>>({});

  // Upload state — per-file map: filename → { status, error }
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileUploadState>>({});
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  // After auto-save in create mode, we get a real itemId to upload against
  const savedItemId = useRef<string | null>(itemId ?? null);
  // Track whether the item was auto-saved (so cancel can clean it up)
  const autoSaved = useRef(false);

  // ── Load item in edit mode ──────────────────────────────────────────────────
  const { data: itemResp, isLoading: itemLoading } = useAuthedQuery<{ data: Item }>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: isEditMode }
  );
  const itemData = itemResp?.data;

  useEffect(() => {
    if (itemData) {
      setItemName(itemData.itemName);
      setDescription(itemData.description);
      setCloseDate(itemData.closeDate?.slice(0, 10) ?? '');
      setContent(itemData.content ?? '');
      setIsLocked(itemData.status !== 'draft');
      if (itemData.documentStatus && itemData.documentStatus !== 'none') {
        setFileStatuses({ _loaded: { status: itemData.documentStatus as FileUploadStatus } });
      }
    }
  }, [itemData]);

  // ── Document title ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isEditMode && itemName) {
      document.title = labels.itemDetail.editDocumentTitle.replace('{itemName}', itemName);
    } else {
      document.title = labels.itemDetail.newDocumentTitle;
    }
  }, [isEditMode, itemName]);

  // ── Cleanup poll on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Mutations ───────────────────────────────────────────────────────────────
  // Whether the current create is triggered by a file upload (suppress navigate)
  const uploadingCreate = useRef(false);

  const createMutation = useAuthedMutation<{ data: Item }, CreateItemPayload>(
    '/api/manage/items',
    'POST',
    {
      onSuccess: (resp) => {
        const created = resp.data;
        savedItemId.current = created.itemId;
        autoSaved.current = true;
        queryClient.invalidateQueries({ queryKey: ['items'] });
        // Only navigate if this wasn't triggered by an upload auto-save
        if (!uploadingCreate.current) {
          navigate(`/admin/items/${created.itemId}`);
        }
      },
      onError: (err) => {
        setFormError(labels.itemDetail.saveError);
        const status = (err as Error & { status?: number }).status;
        if (status === 409) setIsLocked(true);
      },
    }
  );

  const updateMutation = useAuthedMutation<Item, UpdateItemPayload>(
    `/api/manage/items/${itemId}`,
    'PUT',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['items'] });
        queryClient.invalidateQueries({ queryKey: ['item', itemId] });
      },
      onError: (err) => {
        const status = (err as Error & { status?: number }).status;
        if (status === 409) {
          setIsLocked(true);
          setFormError(labels.itemDetail.lockedError);
        } else {
          setFormError(labels.itemDetail.saveError);
        }
      },
    }
  );

  const deleteMutation = useAuthedMutation<null, undefined>(
    `/api/manage/items/${itemId}`,
    'DELETE',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['items'] });
        navigate('/admin/items');
      },
      onError: () => {
        setDeleteError(labels.itemDetail.deleteError);
      },
    }
  );

  // ── Sessions query (edit mode only) ────────────────────────────────────────
  const { data: sessionsData, refetch: refetchSessions } = useAuthedQuery<{ data: Session[] }>(
    ['sessions', itemId],
    `/api/manage/items/${itemId}/sessions`,
    { enabled: isEditMode }
  );
  const sessions = sessionsData?.data ?? [];

  // ── Invitation handlers ─────────────────────────────────────────────────────
  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError('');
    setInviteSuccess('');

    const emails = inviteEmails
      .split(',')
      .map(e => e.trim())
      .filter(Boolean);

    if (!emails.length) {
      setInviteError('Please enter at least one email address.');
      return;
    }

    setIsInviting(true);
    try {
      await authedMutate(`/api/manage/items/${itemId}/invite`, 'POST', { emails }, navigate);
      setInviteEmails('');
      setInviteSuccess(labels.invitation.inviteSuccess);
      refetchSessions();
      queryClient.invalidateQueries({ queryKey: ['item', itemId] });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 403) {
        setInviteError(labels.invitation.inviteLimitError);
      } else {
        setInviteError(labels.invitation.inviteError);
      }
    } finally {
      setIsInviting(false);
    }
  }

  async function handleResend(sessionId: string) {
    setResendMessages(prev => ({ ...prev, [sessionId]: '' }));
    setResendingId(sessionId);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/sessions/${sessionId}/resend`,
        'POST',
        {},
        navigate
      );
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
      queryClient.invalidateQueries({ queryKey: ['item', itemId] });
    } catch {
      setExtendMessage(labels.invitation.extendError);
    } finally {
      setIsExtending(false);
    }
  }

  function sessionStatusLabel(status: SessionStatus): string {
    switch (status) {
      case 'not_started': return labels.invitation.statusNotStarted;
      case 'in_progress': return labels.invitation.statusInProgress;
      case 'completed': return labels.invitation.statusCompleted;
      case 'expired': return labels.invitation.statusExpired;
      case 'discarded': return labels.invitation.statusDiscarded;
    }
  }

  async function handleCancelSession(sessionId: string) {
    setCancelMessages(prev => ({ ...prev, [sessionId]: '' }));
    setCancellingSessionId(sessionId);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/sessions/${sessionId}`,
        'DELETE',
        undefined,
        navigate
      );
      setCancelMessages(prev => ({ ...prev, [sessionId]: labels.itemDetail.cancelSessionSuccess }));
      refetchSessions();
    } catch {
      setCancelMessages(prev => ({ ...prev, [sessionId]: labels.itemDetail.cancelSessionError }));
    } finally {
      setCancellingSessionId(null);
    }
  }

  // ── Form submit ─────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!itemName.trim() || itemName.length > 200) {
      setFormError('Item name is required (1–200 characters).');
      return;
    }
    if (!description.trim() || description.length > 2000) {
      setFormError('Description is required (1–2000 characters).');
      return;
    }
    if (!closeDate || closeDate <= todayIso()) {
      setFormError('Close date must be a future date.');
      return;
    }

    const payload = {
      itemName: itemName.trim(),
      description: description.trim(),
      closeDate,
      ...(content.trim() ? { content: content.trim() } : {}),
    };

    if (isEditMode) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  }

  // ── File upload ─────────────────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    setFormError('');
    setIsUploading(true);

    // Initialise all files as 'uploading'
    setFileStatuses((prev) => {
      const next = { ...prev };
      for (const f of files) next[f.name] = { status: 'uploading' };
      return next;
    });

    try {
      // Auto-save in create mode to get an itemId — suppress the navigate in onSuccess
      let targetItemId = savedItemId.current;
      if (!targetItemId) {
        uploadingCreate.current = true;
        const createdResp = await createMutation.mutateAsync({
          itemName: itemName.trim() || 'Untitled',
          description: description.trim() || '(no description)',
          closeDate: closeDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          ...(content.trim() ? { content: content.trim() } : {}),
        });
        uploadingCreate.current = false;
        targetItemId = createdResp.data.itemId;
      }

      // Upload files sequentially
      for (const file of files) {
        try {
          setFileStatuses((prev) => ({ ...prev, [file.name]: { status: 'uploading' } }));

          const urlResp = await authedMutate(
            `/api/manage/items/${targetItemId}/upload-url`,
            'POST',
            { fileName: file.name, fileSize: file.size },
            navigate
          ) as UploadUrlResponse;

          const putRes = await fetch(urlResp.data.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
          });
          if (!putRes.ok) throw new Error('Upload failed');

          setFileStatuses((prev) => ({ ...prev, [file.name]: { status: 'scanning' } }));
          await pollFileStatus(targetItemId, file.name);
        } catch {
          setFileStatuses((prev) => ({ ...prev, [file.name]: { status: 'error' } }));
        }
      }

      // Navigate to edit mode after all uploads complete (if we were in create mode)
      if (!itemId && targetItemId) {
        navigate(`/admin/items/${targetItemId}`, { replace: true });
      }
    } catch {
      uploadingCreate.current = false;
      setFormError(labels.itemDetail.saveError);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function pollFileStatus(targetItemId: string, fileName: string): Promise<void> {
    return new Promise((resolve) => {
      async function poll() {
        if (!mountedRef.current) { resolve(); return; }

        try {
          // refetchQueries waits for the fetch to complete — no stale-read race
          await queryClient.refetchQueries({ queryKey: ['item', targetItemId] });
          const refreshed = queryClient.getQueryData<{ data: Item }>(['item', targetItemId]);
          const status = (refreshed?.data?.documentStatus ?? 'none') as DocumentStatus;

          if (!mountedRef.current) { resolve(); return; }

          if (status === 'ready' || status === 'rejected' || status === 'extraction_failed') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: status as FileUploadStatus } }));
            resolve();
            return;
          }

          if (status === 'extracting') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: 'extracting' } }));
          }
        } catch {
          // network error during poll — keep trying while mounted
        }

        if (mountedRef.current) setTimeout(poll, 2000);
        else resolve();
      }
      setTimeout(poll, 2000);
    });
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  function handleDeleteConfirm() {
    setDeleteError('');
    deleteMutation.mutate(undefined);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (isEditMode && itemLoading) {
    return <div className={styles.container} aria-busy="true" />;
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.heading}>
          {isEditMode ? labels.itemDetail.editHeading : labels.itemDetail.newHeading}
        </h1>
        {isEditMode && (
          <div className={styles.pageHeaderActions}>
            <button
              type="button"
              className={styles.headerActionInvite}
              onClick={() => setShowInviteModal(true)}
            >
              {labels.items.inviteButton}
            </button>
            <button
              type="button"
              className={styles.headerActionPulse}
              onClick={() => navigate(`/admin/pulse-check/${itemId}`)}
            >
              Pulse Check
            </button>
          </div>
        )}
      </div>

      {isLocked && (
        <p className={styles.lockedNotice} role="status">
          🔒 {labels.itemDetail.readOnlyNotice}
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate className={styles.form}>
        {/* Item name */}
        <div className={styles.field}>
          <label htmlFor="itemName" className={styles.label}>
            {labels.itemDetail.fieldName}
          </label>
          <input
            id="itemName"
            type="text"
            className={styles.input}
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            maxLength={200}
            required
            disabled={isLocked}
            placeholder={labels.itemDetail.fieldNamePlaceholder}
          />
        </div>

        {/* Description */}
        <div className={styles.field}>
          <label htmlFor="description" className={styles.label}>
            {labels.itemDetail.fieldDescription}
          </label>
          <p className={styles.subLabel}>{labels.itemDetail.fieldDescriptionHint}</p>
          <textarea
            id="description"
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
            required
            disabled={isLocked}
            placeholder={labels.itemDetail.fieldDescriptionPlaceholder}
          />
        </div>

        {/* Close date */}
        <div className={styles.field}>
          <label htmlFor="closeDate" className={styles.label}>
            {labels.itemDetail.fieldCloseDate}
          </label>
          <input
            id="closeDate"
            type="date"
            className={styles.input}
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
            min={todayIso()}
            required
            disabled={isLocked}
          />
        </div>

        {/* Content */}
        <div className={styles.field}>
          <label className={styles.label}>{labels.itemDetail.fieldContent}</label>
          <p className={styles.contentHint}>{labels.itemDetail.fieldContentHint}</p>

          {/* Paste area */}
          <label htmlFor="content" className={styles.subLabel}>
            {labels.itemDetail.contentPasteLabel}
          </label>
          <textarea
            id="content"
            className={styles.contentTextarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            disabled={isLocked}
            placeholder={labels.itemDetail.fieldContentPlaceholder}
          />

          {/* Upload area */}
          <label className={styles.subLabel}>{labels.itemDetail.contentUploadLabel}</label>
          <div className={styles.uploadArea}>
            <p className={styles.uploadHint}>{labels.itemDetail.uploadAcceptHint}</p>
            <input
              ref={fileInputRef}
              type="file"
              id="fileUpload"
              className={styles.fileInput}
              accept=".md,.txt,.pdf,.docx"
              multiple
              onChange={handleFileChange}
              disabled={isUploading || isLocked}
              aria-label={labels.itemDetail.uploadChooseFile}
            />
            <label htmlFor="fileUpload" className={`${styles.fileLabel} ${(isUploading || isLocked) ? styles.fileLabelDisabled : ''}`}>
              {isUploading ? labels.itemDetail.uploadStatusUploading : labels.itemDetail.uploadChooseFile}
            </label>

            {Object.entries(fileStatuses).filter(([name]) => name !== '_loaded').map(([name, state]) => (
              <div key={name} className={styles.fileStatusRow} aria-live="polite">
                <span className={styles.fileName}>{name}</span>
                <span className={`${styles.fileStatusBadge} ${
                  state.status === 'ready' ? styles.docStatusReady
                  : state.status === 'rejected' || state.status === 'extraction_failed' || state.status === 'error' ? styles.docStatusError
                  : styles.docStatusPending
                }`}>
                  {fileStatusLabel(state.status)}
                </span>
              </div>
            ))}

            {/* Show loaded status for edit mode when no new uploads */}
            {fileStatuses['_loaded'] && Object.keys(fileStatuses).length === 1 && (
              <p
                className={`${styles.docStatus} ${
                  fileStatuses['_loaded'].status === 'ready' ? styles.docStatusReady
                  : fileStatuses['_loaded'].status === 'rejected' || fileStatuses['_loaded'].status === 'extraction_failed' ? styles.docStatusError
                  : styles.docStatusPending
                }`}
                aria-live="polite"
              >
                {fileStatusLabel(fileStatuses['_loaded'].status)}
              </p>
            )}
          </div>
        </div>

        {/* Error */}
        {formError && (
          <p className={styles.formError} role="alert" aria-live="polite">
            {formError}
          </p>
        )}

        {/* Actions */}
        {!isLocked && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={async () => {
                // If auto-saved in create mode but user cancels, clean up the item
                if (!isEditMode && autoSaved.current && savedItemId.current) {
                  try {
                    await authedMutate(`/api/manage/items/${savedItemId.current}`, 'DELETE', undefined, navigate);
                    queryClient.invalidateQueries({ queryKey: ['items'] });
                  } catch { /* best-effort */ }
                }
                navigate('/admin/items');
              }}
            >
              {labels.itemDetail.cancelButton}
            </button>
            <button type="submit" className={styles.saveButton} disabled={isSaving}>
              {labels.itemDetail.saveButton}
            </button>
          </div>
        )}

        {isLocked && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => navigate('/admin/items')}
            >
              {labels.itemDetail.cancelButton}
            </button>
          </div>
        )}
      </form>

      {/* Invitation section — edit mode only, item must exist */}
      {isEditMode && (
        <section className={styles.invitationSection} aria-label={labels.invitation.sectionTitle}>
          <h2 className={styles.sectionHeading}>{labels.invitation.sectionTitle}</h2>

          {/* Invite form */}
          <form onSubmit={handleInvite} noValidate className={styles.inviteForm}>
            <label htmlFor="inviteEmails" className={styles.label}>
              {labels.invitation.emailsLabel}
            </label>
            <p className={styles.contentHint}>{labels.invitation.emailsHint}</p>
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
                className={inviteError ? styles.formError : styles.successMessage}
              >
                {inviteError || inviteSuccess}
              </p>
            )}
            <button
              type="submit"
              className={styles.saveButton}
              disabled={isInviting}
            >
              {isInviting ? labels.invitation.inviting : labels.invitation.inviteButton}
            </button>
          </form>

          {/* Session list */}
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
                      <button
                        type="button"
                        className={styles.resendButton}
                        onClick={() => handleResend(session.sessionId)}
                        disabled={resendingId === session.sessionId}
                      >
                        {resendingId === session.sessionId
                          ? labels.invitation.resending
                          : labels.invitation.resendButton}
                      </button>
                    )}
                    {session.status === 'not_started' && !session.isPublic && (
                      <button
                        type="button"
                        className={styles.cancelSessionButton}
                        onClick={() => handleCancelSession(session.sessionId)}
                        disabled={cancellingSessionId === session.sessionId}
                      >
                        {labels.itemDetail.cancelSessionButton}
                      </button>
                    )}
                    {session.status === 'completed' && (
                      <Link
                        to={`/admin/items/${itemId}/sessions/${session.sessionId}/report`}
                        className={styles.resendButton}
                      >
                        {labels.invitation.viewReportButton}
                      </Link>
                    )}
                  </div>
                  {resendMessages[session.sessionId] && (
                    <p aria-live="polite" className={styles.resendMessage}>
                      {resendMessages[session.sessionId]}
                    </p>
                  )}
                  {cancelMessages[session.sessionId] && (
                    <p aria-live="polite" className={styles.resendMessage}>
                      {cancelMessages[session.sessionId]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Extend deadline form */}
          <form onSubmit={handleExtendDeadline} noValidate className={styles.extendForm}>
            <h3 className={styles.subSectionHeading}>{labels.invitation.extendDeadlineTitle}</h3>
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
                className={styles.saveButton}
                disabled={isExtending || !extendDate}
              >
                {isExtending ? labels.invitation.extending : labels.invitation.extendDeadlineButton}
              </button>
            </div>
            {extendMessage && (
              <p aria-live="polite" className={styles.successMessage}>{extendMessage}</p>
            )}
          </form>
        </section>
      )}

      {/* Delete button — edit mode only */}
      {isEditMode && (
        <div className={styles.dangerZone}>
          <button
            type="button"
            className={styles.deleteButton}
            onClick={() => setShowDeleteModal(true)}
          >
            {labels.itemDetail.deleteButton}
          </button>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-modal-title"
        >
          <div className={styles.modal}>
            <h2 id="delete-modal-title" className={styles.modalTitle}>
              {labels.itemDetail.deleteConfirmTitle}
            </h2>
            <p className={styles.modalMessage}>
              {labels.itemDetail.deleteConfirmMessage.replace('{itemName}', itemName)}
            </p>
            {deleteError && (
              <p className={styles.formError} role="alert" aria-live="polite">
                {deleteError}
              </p>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteError('');
                }}
                disabled={isDeleting}
              >
                {labels.itemDetail.deleteConfirmCancel}
              </button>
              <button
                type="button"
                className={styles.destructiveButton}
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
              >
                {labels.itemDetail.deleteConfirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}

      {showInviteModal && itemId && (
        <InviteModal
          itemId={itemId}
          itemName={itemName}
          onClose={() => setShowInviteModal(false)}
        />
      )}
    </div>
  );
}
