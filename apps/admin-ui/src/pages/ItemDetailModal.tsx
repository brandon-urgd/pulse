import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
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
  sessionCount: number;
  updatedAt: string;
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

interface Props {
  itemId?: string;       // undefined = create mode
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

  // Upload state
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileUploadState>>({});
  const [isUploading, setIsUploading]   = useState(false);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const mountedRef    = useRef(true);
  const savedItemId   = useRef<string | null>(itemId ?? null);
  const autoSaved     = useRef(false);
  const uploadingCreate = useRef(false);

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
        // Extract filename from documentKey if available, otherwise use a generic key
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
        if (!uploadingCreate.current) onClose();
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
          closeDate: closeDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
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
          await queryClient.refetchQueries({ queryKey: ['item', targetItemId] });
          const refreshed = queryClient.getQueryData<Item>(['item', targetItemId]);
          const status = (refreshed?.documentStatus ?? 'none') as DocumentStatus;
          if (!mountedRef.current) { resolve(); return; }
          if (status === 'ready' || status === 'rejected' || status === 'extraction_failed') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: status as FileUploadStatus } }));
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
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <h2 id="item-modal-title" className={styles.modalTitle}>
            {isEditMode ? labels.itemDetail.editHeading : labels.itemDetail.newHeading}
          </h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className={styles.modalBody}>
          {isEditMode && itemLoading ? (
            <div className={styles.loading} aria-busy="true" />
          ) : (
            <>
              {isLocked && (
                <p className={styles.lockedNotice} role="status">
                  {labels.itemDetail.readOnlyNotice}
                </p>
              )}

              <form onSubmit={handleSubmit} noValidate className={styles.form}>
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
                    type="date"
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

                    {Object.entries(fileStatuses).map(([name, state]) => (
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
                  </div>
                </div>

                {formError && (
                  <p className={styles.formError} role="alert" aria-live="polite">
                    {formError}
                  </p>
                )}

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
                    <button type="submit" className={styles.saveButton} disabled={isSaving}>
                      {isSaving ? '…' : labels.itemDetail.saveButton}
                    </button>
                  )}
                </div>
              </form>
            </>
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
    </div>
  );
}
