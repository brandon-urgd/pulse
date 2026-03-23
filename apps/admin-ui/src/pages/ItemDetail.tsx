import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  documentKey?: string;
  sessionCount: number;
  updatedAt: string;
  recommendedTimeLimitMinutes?: number;
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
  // Returns current datetime in "YYYY-MM-DDTHH:MM" format for datetime-local inputs
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
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

  // Preview session state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewPopupBlocked, setPreviewPopupBlocked] = useState(false);

  // Self-review session state
  const [isSelfReviewLoading, setIsSelfReviewLoading] = useState(false);
  const [selfReviewError, setSelfReviewError] = useState('');

  // Close item state — removed (flow moved to Pulse Check page)

  // Upload state — per-file map: filename → { status, error }
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileUploadState>>({});
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  // After auto-save in create mode, we get a real itemId to upload against
  const savedItemId = useRef<string | null>(itemId ?? null);
  // Track whether the item was auto-saved (so cancel can clean it up)
  const autoSaved = useRef(false);

  // Time limit state
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number | null>(null);
  const perFileTimeLimits = useRef<Record<string, number>>({});

  // True while any file is still in-flight
  const isAnyFileInFlight = Object.values(fileStatuses).some(
    (s) => s.status === 'uploading' || s.status === 'scanning' || s.status === 'extracting'
  );

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
      setCloseDate(itemData.closeDate?.slice(0, 16) ?? '');
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

  // ── Preview session ─────────────────────────────────────────────────────────
  async function handlePreview() {
    if (!itemId || isPreviewLoading) return;
    setIsPreviewLoading(true);
    setPreviewError('');
    setPreviewPopupBlocked(false);

    // Open window synchronously inside the gesture so mobile browsers don't block it
    const newTab = window.open('', '_blank', 'noopener,noreferrer');
    if (!newTab) {
      setPreviewPopupBlocked(true);
      setIsPreviewLoading(false);
      return;
    }

    try {
      const resp = await authedMutate(
        `/api/manage/items/${itemId}/preview-session`,
        'GET',
        timeLimitMinutes != null ? { timeLimitMinutes } : undefined,
        navigate
      ) as { data: { previewUrl: string } };

      newTab.location.href = resp.data.previewUrl;
    } catch {
      newTab.close();
      setPreviewError(labels.itemDetail.previewSessionError);
    } finally {
      setIsPreviewLoading(false);
    }
  }

  // ── Self-review session ─────────────────────────────────────────────────────
  async function handleSelfReview() {
    if (!itemId || isSelfReviewLoading) return;
    setIsSelfReviewLoading(true);
    setSelfReviewError('');

    // Open window synchronously inside the gesture so mobile browsers don't block it
    const newTab = window.open('', '_blank', 'noopener,noreferrer');
    if (!newTab) {
      setSelfReviewError(labels.itemDetail.selfReviewError);
      setIsSelfReviewLoading(false);
      return;
    }

    try {
      const resp = await authedMutate(
        `/api/manage/items/${itemId}/self-review`,
        'POST',
        {},
        navigate
      ) as { data: { sessionId: string; sessionUrl: string } };

      newTab.location.href = resp.data.sessionUrl;
    } catch (err: unknown) {
      newTab.close();
      const status = (err as { status?: number }).status ?? 500;
      setSelfReviewError(
        status === 403
          ? labels.itemDetail.selfReviewLimitError
          : labels.itemDetail.selfReviewError
      );
    } finally {
      setIsSelfReviewLoading(false);
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
    if (!closeDate || new Date(closeDate).getTime() <= Date.now()) {
      setFormError('Close date must be a future date and time.');
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
          closeDate: closeDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
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
            if (status === 'ready' && refreshed?.data?.recommendedTimeLimitMinutes) {
              perFileTimeLimits.current[fileName] = refreshed.data.recommendedTimeLimitMinutes;
              const total = Object.values(perFileTimeLimits.current).reduce((a, b) => a + b, 0);
              const brackets = labels.itemDetail.timeLimitBrackets;
              const snapped = brackets.reduce((best, b) =>
                Math.abs(b.value - total) < Math.abs(best.value - total) ? b : best
              ).value;
              setTimeLimitMinutes(snapped);
            }
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

  // ── Remove document ─────────────────────────────────────────────────────────
  async function handleRemoveFile() {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId || isAnyFileInFlight) return;
    try {
      await authedMutate(`/api/manage/items/${targetItemId}/document`, 'DELETE', undefined, navigate);
      setFileStatuses({});
      perFileTimeLimits.current = {};
      setTimeLimitMinutes(null);
      queryClient.invalidateQueries({ queryKey: ['item', targetItemId] });
    } catch {
      setFormError('Failed to remove document. Please try again.');
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  function handleDeleteConfirm() {    setDeleteError('');
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
            {itemData?.status !== 'closed' && itemData?.status !== 'revised' && (
              <button
                type="button"
                className={styles.headerActionInvite}
                onClick={() => setShowInviteModal(true)}
              >
                {labels.items.inviteButton}
              </button>
            )}
            {(itemData?.status === 'draft' || itemData?.status === 'active') && (
              <button
                type="button"
                className={styles.headerActionSelfReview}
                onClick={handleSelfReview}
                disabled={isSelfReviewLoading}
                title={labels.itemDetail.selfReviewTooltip}
              >
                {isSelfReviewLoading ? labels.itemDetail.selfReviewLoading : labels.itemDetail.selfReviewButton}
              </button>
            )}
            <button
              type="button"
              className={styles.headerActionPreview}
              onClick={handlePreview}
              disabled={isPreviewLoading}
            >
              {isPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
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

      {/* Preview session inline feedback */}
      {previewError && (
        <p className={styles.formError} role="alert" aria-live="polite">
          {previewError}
        </p>
      )}
      {previewPopupBlocked && (
        <p className={styles.previewNotice} aria-live="polite">
          {labels.itemDetail.previewSessionPopupBlocked}
        </p>
      )}

      {/* Self-review inline feedback */}
      {selfReviewError && (
        <p className={styles.formError} role="alert" aria-live="polite">
          {selfReviewError}
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
            type="datetime-local"
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
                {state.status !== 'uploading' && state.status !== 'scanning' && state.status !== 'extracting' && !isLocked && (
                  <button
                    type="button"
                    className={styles.fileRemoveButton}
                    onClick={() => handleRemoveFile()}
                    aria-label={`Remove ${name}`}
                  >×</button>
                )}
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

            {/* Time limit + preview CTA — shown once a file is ready, create mode only */}
            {!isEditMode && Object.values(fileStatuses).some(s => s.status === 'ready') && (
              <div className={styles.uploadReadyCtas}>
                <div className={styles.timeLimitRow}>
                  <label htmlFor="timeLimitSelect" className={styles.timeLimitLabel}>
                    {labels.itemDetail.timeLimitLabel}
                  </label>
                  <select
                    id="timeLimitSelect"
                    className={styles.timeLimitSelect}
                    value={timeLimitMinutes ?? 17}
                    onChange={(e) => setTimeLimitMinutes(Number(e.target.value))}
                  >
                    {labels.itemDetail.timeLimitBrackets.map((b) => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className={styles.uploadCtaPreview}
                  onClick={handlePreview}
                  disabled={isPreviewLoading}
                >
                  {isPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
                </button>
              </div>
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
            <button type="submit" className={styles.saveButton} disabled={isSaving || isAnyFileInFlight}>
              {isSaving ? '…' : isAnyFileInFlight ? 'Processing…' : labels.itemDetail.saveButton}
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
