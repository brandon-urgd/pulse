import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import InviteModal from './InviteModal';
import DocumentPreviewPanel from '../components/DocumentPreviewPanel';
import styles from './ItemDetailModal.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type ItemStatus = 'draft' | 'active' | 'closed' | 'revised';
type DocumentStatus = 'none' | 'scanning' | 'extracting' | 'ready' | 'rejected' | 'extraction_failed';
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
  data: { uploadUrl: string; key: string };
}

interface DocumentUrlResponse {
  data: { url: string; contentType: string; filename: string; originalUrl?: string };
}

interface Props {
  itemId?: string;       // undefined = create mode
  onClose: () => void;
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
    case 'uploading':         return labels.itemDetail.uploadStatusUploading;
    case 'scanning':          return labels.itemDetail.uploadStatusScanning;
    case 'extracting':        return labels.itemDetail.uploadStatusExtracting;
    case 'ready':             return labels.itemDetail.uploadStatusReady;
    case 'rejected':          return labels.itemDetail.uploadStatusRejected;
    case 'extraction_failed': return labels.itemDetail.uploadStatusExtractionFailed;
    case 'error':             return labels.itemDetail.uploadStatusError;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ItemDetailModal({ itemId, onClose }: Props) {
  const isEditMode = Boolean(itemId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Form state
  const [itemName, setItemName]       = useState('');
  const [description, setDescription] = useState('');
  const [closeDate, setCloseDate]     = useState('');
  const [content, setContent]         = useState('');

  // UI state
  const [formError, setFormError]         = useState('');
  const [isLocked, setIsLocked]           = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError]     = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [savedItem, setSavedItem]         = useState<{ itemId: string; itemName: string } | null>(null);
  // Upload state
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileUploadState>>({});
  const [isUploading, setIsUploading]   = useState(false);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const mountedRef    = useRef(true);
  const savedItemId   = useRef<string | null>(itemId ?? null);
  const autoSaved     = useRef(false);
  const uploadingCreate = useRef(false);

  // Document preview state (file viewer panel)
  interface PreviewData { url: string; contentType: string; filename: string; originalUrl?: string }
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [loadingPreviewFile, setLoadingPreviewFile] = useState<string | null>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);

  // Session preview state
  const [isSessionPreviewLoading, setIsSessionPreviewLoading] = useState(false);
  const [sessionPreviewError, setSessionPreviewError] = useState('');
  const [sessionPreviewPopupBlocked, setSessionPreviewPopupBlocked] = useState(false);

  // Self-review state
  const [isSelfReviewLoading, setIsSelfReviewLoading] = useState(false);
  const [selfReviewError, setSelfReviewError] = useState('');

  // Time limit state (for session preview / self-review)
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number | null>(null);

  // Self-review "start over" confirm state
  const [selfReviewExistingId, setSelfReviewExistingId] = useState<string | null>(null);

  // ── Derived upload state ────────────────────────────────────────────────────
  // True while any file is still in-flight (uploading/scanning/extracting)
  const isAnyFileInFlight = Object.values(fileStatuses).some(
    (s) => s.status === 'uploading' || s.status === 'scanning' || s.status === 'extracting'
  );

  // Per-file time limits accumulate as each file resolves to ready.
  // We track them in a ref so pollFileStatus can update without re-renders.
  const perFileTimeLimits = useRef<Record<string, number>>({});
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
      if (itemData.recommendedTimeLimitMinutes && timeLimitMinutes === null) {
        setTimeLimitMinutes(itemData.recommendedTimeLimitMinutes);
      }
      if (itemData.documentStatus && itemData.documentStatus !== 'none') {
        const fileName = itemData.documentKey
          ? itemData.documentKey.split('/').pop() ?? '_loaded'
          : '_loaded';
        setFileStatuses({ [fileName]: { status: itemData.documentStatus as FileUploadStatus } });
      }
    }
  }, [itemData]);

  // ── Mount / unmount tracking ────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Esc to close ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  // ── Mutations ───────────────────────────────────────────────────────────────
  const createMutation = useAuthedMutation<{ data: Item }, CreateItemPayload>(
    '/api/manage/items',
    'POST',
    {
      onSuccess: (resp) => {
        savedItemId.current = resp.data.itemId;
        autoSaved.current = true;
        queryClient.invalidateQueries({ queryKey: ['items'] });
        if (!uploadingCreate.current) {
          // After creating a new item, prompt to invite reviewers
          setSavedItem({ itemId: resp.data.itemId, itemName: resp.data.itemName });
          setShowInviteModal(true);
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
        onClose();
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
        onClose();
      },
      onError: () => setDeleteError(labels.itemDetail.deleteError),
    }
  );

  // ── Handlers ────────────────────────────────────────────────────────────────
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
    } else if (savedItemId.current) {
      // Item was auto-created during file upload — update it instead of creating a duplicate
      authedMutate(`/api/manage/items/${savedItemId.current}`, 'PUT', payload, navigate)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['items'] });
          queryClient.invalidateQueries({ queryKey: ['item', savedItemId.current] });
          onClose();
        })
        .catch(() => setFormError(labels.itemDetail.saveError));
    } else {
      createMutation.mutate(payload);
    }
  }

  async function handleCancel() {
    if (!isEditMode && autoSaved.current && savedItemId.current) {
      try {
        await authedMutate(`/api/manage/items/${savedItemId.current}`, 'DELETE', undefined, navigate);
        queryClient.invalidateQueries({ queryKey: ['items'] });
      } catch { /* best-effort */ }
    }
    onClose();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    setFormError('');
    setIsUploading(true);
    setFileStatuses((prev) => {
      const next = { ...prev };
      for (const f of files) next[f.name] = { status: 'uploading' };
      return next;
    });

    try {
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
          // Fetch directly — in create mode the React Query cache has no entry for this item yet
          const resp = await authedMutate(`/api/manage/items/${targetItemId}`, 'GET', undefined, navigate) as { data: Item };
          const refreshed = resp?.data;
          const status = (refreshed?.documentStatus ?? 'none') as DocumentStatus;
          if (!mountedRef.current) { resolve(); return; }
          if (status === 'ready' || status === 'rejected' || status === 'extraction_failed') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: status as FileUploadStatus } }));
            // Accumulate per-file time limits and sum them (capped at 60 min)
            if (status === 'ready' && refreshed?.recommendedTimeLimitMinutes) {
              perFileTimeLimits.current[fileName] = refreshed.recommendedTimeLimitMinutes;
              const total = Object.values(perFileTimeLimits.current).reduce((a, b) => a + b, 0);
              setTimeLimitMinutes(Math.min(60, total));
            }
            // Also update the query cache so edit mode picks it up immediately
            queryClient.setQueryData(['item', targetItemId], { data: refreshed });
            resolve();
            return;
          }
          if (status === 'extracting') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: 'extracting' } }));
          }
        } catch { /* keep polling */ }
        if (mountedRef.current) setTimeout(poll, 2000);
        else resolve();
      }
      setTimeout(poll, 2000);
    });
  }

  // ── Preview handler ─────────────────────────────────────────────────────────
  async function handlePreviewClick(fileName: string, e: React.MouseEvent | React.KeyboardEvent) {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId) return;
    setLoadingPreviewFile(fileName);
    previewTriggerRef.current = e.currentTarget as HTMLElement;
    try {
      const resp = await authedMutate(
        `/api/manage/items/${targetItemId}/document-url`,
        'GET',
        undefined,
        navigate
      ) as DocumentUrlResponse;
      setPreviewData({
        url: resp.data.url,
        contentType: resp.data.contentType,
        filename: resp.data.filename,
        originalUrl: resp.data.originalUrl,
      });
    } catch { /* silently fail */ }
    finally {
      setLoadingPreviewFile(null);
    }
  }

  // ── Session preview handler ─────────────────────────────────────────────────
  async function handleSessionPreview() {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId || isSessionPreviewLoading) return;
    setIsSessionPreviewLoading(true);
    setSessionPreviewError('');
    setSessionPreviewPopupBlocked(false);
    try {
      const resp = await authedMutate(
        `/api/manage/items/${targetItemId}/preview-session`,
        'GET',
        timeLimitMinutes != null ? { timeLimitMinutes } : undefined,
        navigate
      ) as { data: { previewUrl: string } };
      const newTab = window.open(resp.data.previewUrl, '_blank', 'noopener,noreferrer');
      if (!newTab) setSessionPreviewPopupBlocked(true);
    } catch {
      setSessionPreviewError(labels.itemDetail.previewSessionError);
    } finally {
      setIsSessionPreviewLoading(false);
    }
  }

  // ── Self-review handler ──────────────────────────────────────────────────────
  async function handleSelfReview(forceSessionId?: string) {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId || isSelfReviewLoading) return;
    setIsSelfReviewLoading(true);
    setSelfReviewError('');
    setSelfReviewExistingId(null);
    try {
      // If starting over, delete the existing session first
      if (forceSessionId) {
        await authedMutate(
          `/api/manage/items/${targetItemId}/sessions/${forceSessionId}`,
          'DELETE',
          undefined,
          navigate
        );
      }
      const resp = await authedMutate(
        `/api/manage/items/${targetItemId}/self-review`,
        'POST',
        { ...(timeLimitMinutes != null ? { timeLimitMinutes } : {}) },
        navigate
      ) as { data: { sessionId: string; sessionUrl: string } };
      window.open(resp.data.sessionUrl, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const body = (err as { body?: { existingSessionId?: string } }).body;
      if (status === 409 && body?.existingSessionId) {
        // Existing self-review — surface "start over" prompt
        setSelfReviewExistingId(body.existingSessionId);
      } else if (status === 403) {
        setSelfReviewError(labels.itemDetail.selfReviewLimitError);
      } else {
        setSelfReviewError(labels.itemDetail.selfReviewError);
      }
    } finally {
      setIsSelfReviewLoading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const isSaving  = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-modal-title"
    >
      <div className={`${styles.modal} ${previewData ? styles.modalExpanded : ''}`}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <h2 id="item-modal-title" className={styles.modalTitle}>
            {isEditMode ? labels.itemDetail.editHeading : labels.itemDetail.newHeading}
          </h2>
          {isEditMode && (
            <>
              {timeLimitMinutes != null && (
                <div className={styles.headerTimeLimitRow}>
                  <label htmlFor="headerTimeLimitInput" className={styles.headerTimeLimitLabel}>
                    {labels.itemDetail.timeLimitLabel}
                  </label>
                  <input
                    id="headerTimeLimitInput"
                    type="number"
                    min={5}
                    max={60}
                    step={5}
                    className={styles.timeLimitInput}
                    value={timeLimitMinutes}
                    onChange={(e) => {
                      const v = Math.min(60, Math.max(5, Number(e.target.value)));
                      setTimeLimitMinutes(v);
                    }}
                  />
                  <span className={styles.timeLimitUnit}>{labels.itemDetail.timeLimitUnit}</span>
                </div>
              )}
              {(itemData?.status === 'draft' || itemData?.status === 'active') && (
                <button
                  type="button"
                  className={styles.headerActionSelfReview}
                  onClick={() => handleSelfReview()}
                  disabled={isSelfReviewLoading}
                  title={labels.itemDetail.selfReviewTooltip}
                >
                  {isSelfReviewLoading ? labels.itemDetail.selfReviewLoading : labels.itemDetail.selfReviewButton}
                </button>
              )}
              <button
                type="button"
                className={styles.headerActionPreview}
                onClick={handleSessionPreview}
                disabled={isSessionPreviewLoading}
              >
                {isSessionPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Session preview inline feedback */}
        {sessionPreviewError && (
          <p className={styles.formError} role="alert" aria-live="polite">{sessionPreviewError}</p>
        )}
        {sessionPreviewPopupBlocked && (
          <p className={styles.previewNotice} aria-live="polite">{labels.itemDetail.previewSessionPopupBlocked}</p>
        )}
        {selfReviewError && (
          <p className={styles.formError} role="alert" aria-live="polite">{selfReviewError}</p>
        )}
        {selfReviewExistingId && (
          <div className={styles.selfReviewResetBanner} role="alert">
            <span>{labels.itemDetail.selfReviewExistsNotice}</span>
            <button
              type="button"
              className={styles.selfReviewResetConfirm}
              onClick={() => handleSelfReview(selfReviewExistingId)}
              disabled={isSelfReviewLoading}
            >
              {labels.itemDetail.selfReviewStartOver}
            </button>
            <button
              type="button"
              className={styles.selfReviewResetCancel}
              onClick={() => setSelfReviewExistingId(null)}
            >
              {labels.itemDetail.selfReviewStartOverCancel}
            </button>
          </div>
        )}

        {/* Inner layout — flex row when preview is open, flex column always */}
        <div className={previewData ? styles.modalInner : styles.modalSinglePane}>
          {/* Form pane */}
          <div className={previewData ? styles.modalFormPane : styles.modalFormSingle}>
            {/* Body */}
            <div className={styles.modalBody}>
              {isEditMode && itemLoading ? (
                <div className={styles.loading} aria-busy="true" />
              ) : (
                <>
                  {isLocked && (
                    <p className={styles.lockedNotice} role="status">
                      🔒 {labels.itemDetail.readOnlyNotice}
                    </p>
                  )}

                  <form id="item-detail-form" onSubmit={handleSubmit} noValidate className={styles.form}>
                    <div className={styles.field}>
                      <label htmlFor="itemName" className={styles.label}>
                        {labels.itemDetail.fieldName} <span className={styles.required} aria-hidden="true">*</span>
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

                    <div className={styles.field}>
                      <label htmlFor="description" className={styles.label}>
                        {labels.itemDetail.fieldDescription} <span className={styles.required} aria-hidden="true">*</span>
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

                    <div className={styles.field}>
                      <label htmlFor="closeDate" className={styles.label}>
                        {labels.itemDetail.fieldCloseDate} <span className={styles.required} aria-hidden="true">*</span>
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

                    <div className={styles.field}>
                      <label className={styles.label}>{labels.itemDetail.fieldContent}</label>
                      <p className={styles.contentHint}>{labels.itemDetail.fieldContentHint}</p>

                      <label htmlFor="content" className={styles.subLabel}>
                        {labels.itemDetail.contentPasteLabel}
                      </label>
                      <textarea
                        id="content"
                        className={styles.contentTextarea}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        rows={8}
                        disabled={isLocked}
                        placeholder={labels.itemDetail.fieldContentPlaceholder}
                      />

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
                        <label
                          htmlFor="fileUpload"
                          className={`${styles.fileLabel} ${(isUploading || isLocked) ? styles.fileLabelDisabled : ''}`}
                        >
                          {isUploading ? labels.itemDetail.uploadStatusUploading : labels.itemDetail.uploadChooseFile}
                        </label>

                        {Object.entries(fileStatuses).map(([name, state]) => {
                          const isReady = state.status === 'ready';
                          const isLoadingThis = loadingPreviewFile === name;
                          return (
                            <div
                              key={name}
                              className={`${styles.fileStatusRow} ${isReady ? styles.fileStatusRowClickable : ''}`}
                              aria-live="polite"
                              role={isReady ? 'button' : undefined}
                              tabIndex={isReady ? 0 : undefined}
                              aria-label={isReady ? labels.itemDetail.previewAriaLabel.replace('{filename}', name) : undefined}
                              onClick={isReady ? (e) => handlePreviewClick(name, e) : undefined}
                              onKeyDown={isReady ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handlePreviewClick(name, e);
                                }
                              } : undefined}
                            >
                              <span className={styles.fileName}>{name}</span>
                              <span className={`${styles.fileStatusBadge} ${
                                state.status === 'ready' ? styles.docStatusReady
                                : state.status === 'rejected' || state.status === 'extraction_failed' || state.status === 'error' ? styles.docStatusError
                                : styles.docStatusPending
                              }`}>
                                {fileStatusLabel(state.status)}
                              </span>
                              {isReady && (
                                <span className={styles.previewLinkText}>
                                  {isLoadingThis ? '…' : labels.itemDetail.previewLink}
                                </span>
                              )}
                            </div>
                          );
                        })}

                        {/* Time limit + preview CTA — shown once a file is ready, create mode only */}
                        {!isEditMode && Object.values(fileStatuses).some(s => s.status === 'ready') && (
                          <div className={styles.uploadReadyCtas}>
                            <div className={styles.timeLimitRow}>
                              <label htmlFor="timeLimitInput" className={styles.timeLimitLabel}>
                                {labels.itemDetail.timeLimitLabel}
                              </label>
                              <input
                                id="timeLimitInput"
                                type="number"
                                min={5}
                                max={60}
                                step={5}
                                className={styles.timeLimitInput}
                                value={timeLimitMinutes ?? 30}
                                onChange={(e) => {
                                  const v = Math.min(60, Math.max(5, Number(e.target.value)));
                                  setTimeLimitMinutes(v);
                                }}
                              />
                              <span className={styles.timeLimitUnit}>{labels.itemDetail.timeLimitUnit}</span>
                            </div>
                            <button
                              type="button"
                              className={styles.uploadCtaPreview}
                              onClick={handleSessionPreview}
                              disabled={isSessionPreviewLoading}
                            >
                              {isSessionPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {formError && (
                      <p className={styles.formError} role="alert" aria-live="polite">
                        {formError}
                      </p>
                    )}
                  </form>
                </>
              )}
            </div>

            {/* Actions — pinned footer outside scrollable body */}
            {!(isEditMode && itemLoading) && (
              <div className={styles.actions}>
                {isEditMode && (
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={() => setShowDeleteModal(true)}
                    disabled={isDeleting}
                  >
                    {labels.itemDetail.deleteButton}
                  </button>
                )}
                <div className={styles.actionsSpacer} />
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  {labels.itemDetail.cancelButton}
                </button>
                {!isLocked && (
                  <button
                    type="submit"
                    form="item-detail-form"
                    className={styles.saveButton}
                    disabled={isSaving || isAnyFileInFlight}
                    title={isAnyFileInFlight ? 'Waiting for document to finish processing…' : undefined}
                  >
                    {isSaving ? '…' : isAnyFileInFlight ? 'Processing…' : labels.itemDetail.saveButton}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Preview pane */}
          {previewData && (
            <DocumentPreviewPanel
              url={previewData.url}
              contentType={previewData.contentType}
              filename={previewData.filename}
              originalUrl={previewData.originalUrl}
              onClose={() => setPreviewData(null)}
              triggerRef={previewTriggerRef as React.RefObject<HTMLElement | null>}
            />
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {showDeleteModal && (
        <div
          className={styles.confirmOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-modal-title"
        >
          <div className={styles.confirmModal}>
            <h3 id="delete-modal-title" className={styles.confirmTitle}>
              {labels.itemDetail.deleteConfirmTitle}
            </h3>
            <p className={styles.confirmMessage}>
              {labels.itemDetail.deleteConfirmMessage.replace('{itemName}', itemName)}
            </p>
            {deleteError && (
              <p className={styles.formError} role="alert">{deleteError}</p>
            )}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => { setShowDeleteModal(false); setDeleteError(''); }}
                disabled={isDeleting}
              >
                {labels.itemDetail.deleteConfirmCancel}
              </button>
              <button
                type="button"
                className={styles.destructiveButton}
                onClick={() => { setDeleteError(''); deleteMutation.mutate(undefined); }}
                disabled={isDeleting}
              >
                {labels.itemDetail.deleteConfirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-save invite flow — shown after creating a new item */}
      {showInviteModal && savedItem && (
        <InviteModal
          itemId={savedItem.itemId}
          itemName={savedItem.itemName}
          onClose={() => { setShowInviteModal(false); onClose(); }}
          skipLabel="Skip for now"
          onSelfReview={async () => {
            setShowInviteModal(false);
            await handleSelfReview();
            onClose();
          }}
        />
      )}
    </div>
  );
}
