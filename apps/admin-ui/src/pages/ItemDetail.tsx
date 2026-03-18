import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
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

interface UploadUrlPayload {
  fileName: string;
  fileSize: number;
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

function docStatusMessage(status: DocumentStatus): string {
  switch (status) {
    case 'scanning':
      return labels.itemDetail.uploadStatusScanning;
    case 'extracting':
      return labels.itemDetail.uploadStatusExtracting;
    case 'ready':
      return labels.itemDetail.uploadStatusReady;
    case 'rejected':
      return labels.itemDetail.uploadStatusRejected;
    case 'extraction_failed':
      return labels.itemDetail.uploadStatusExtractionFailed;
    default:
      return '';
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
  const [contentMode, setContentMode] = useState<'textarea' | 'upload'>('textarea');

  // UI state
  const [formError, setFormError] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Upload state
  const [uploadDocStatus, setUploadDocStatus] = useState<DocumentStatus>('none');
  const [isUploading, setIsUploading] = useState(false);
  const isPolling = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load item in edit mode ──────────────────────────────────────────────────
  const { data: itemData, isLoading: itemLoading } = useAuthedQuery<Item>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: isEditMode }
  );

  useEffect(() => {
    if (itemData) {
      setItemName(itemData.itemName);
      setDescription(itemData.description);
      setCloseDate(itemData.closeDate?.slice(0, 10) ?? '');
      setContent(itemData.content ?? '');
      setIsLocked(itemData.status !== 'draft');
      if (itemData.documentStatus && itemData.documentStatus !== 'none') {
        setUploadDocStatus(itemData.documentStatus);
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
    return () => {
      isPolling.current = false;
    };
  }, []);

  // ── Mutations ───────────────────────────────────────────────────────────────
  const createMutation = useAuthedMutation<Item, CreateItemPayload>(
    '/api/manage/items',
    'POST',
    {
      onSuccess: (created) => {
        queryClient.invalidateQueries({ queryKey: ['items'] });
        navigate(`/admin/items/${created.itemId}`);
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

  const uploadUrlMutation = useAuthedMutation<UploadUrlResponse, UploadUrlPayload>(
    `/api/manage/items/${itemId}/upload-url`,
    'POST'
  );

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
    const file = e.target.files?.[0];
    if (!file || !itemId) return;

    setFormError('');
    setIsUploading(true);
    setUploadDocStatus('scanning');

    try {
      // 1. Get presigned URL — Lambda returns { data: { uploadUrl, key } }
      const response = await uploadUrlMutation.mutateAsync({
        fileName: file.name,
        fileSize: file.size,
      });
      const uploadUrl = response.data.uploadUrl;;

      // 2. Upload directly to S3 (no auth header — presigned)
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });

      if (!putRes.ok) {
        throw new Error('Upload failed');
      }

      // 3. Poll for documentStatus
      startPolling();
    } catch {
      setFormError(labels.itemDetail.saveError);
      setUploadDocStatus('none');
    } finally {
      setIsUploading(false);
      // Reset file input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function startPolling() {
    isPolling.current = true;

    async function poll() {
      if (!isPolling.current) return;

      await queryClient.invalidateQueries({ queryKey: ['item', itemId] });
      const refreshed = queryClient.getQueryData<Item>(['item', itemId]);
      const status = (refreshed?.documentStatus ?? 'none') as DocumentStatus;
      setUploadDocStatus(status);

      if (status === 'ready' || status === 'rejected' || status === 'extraction_failed') {
        isPolling.current = false;
        return;
      }

      setTimeout(poll, 2000);
    }

    setTimeout(poll, 2000);
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
      <h1 className={styles.heading}>
        {isEditMode ? labels.itemDetail.editHeading : labels.itemDetail.newHeading}
      </h1>

      {isLocked && (
        <p className={styles.lockedNotice} role="status">
          {labels.itemDetail.readOnlyNotice}
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
          <div className={styles.contentHeader}>
            <label className={styles.label}>{labels.itemDetail.fieldContent}</label>
            {isEditMode && !isLocked && (
              <div className={styles.contentToggle} role="group" aria-label="Content input mode">
                <button
                  type="button"
                  className={`${styles.toggleBtn} ${contentMode === 'textarea' ? styles.toggleActive : ''}`}
                  onClick={() => setContentMode('textarea')}
                >
                  {labels.itemDetail.contentModeTextarea}
                </button>
                <button
                  type="button"
                  className={`${styles.toggleBtn} ${contentMode === 'upload' ? styles.toggleActive : ''}`}
                  onClick={() => setContentMode('upload')}
                >
                  {labels.itemDetail.contentModeUpload}
                </button>
              </div>
            )}
          </div>

          {contentMode === 'textarea' || !isEditMode ? (
            <textarea
              id="content"
              className={styles.contentTextarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              disabled={isLocked}
              placeholder={labels.itemDetail.fieldContentPlaceholder}
            />
          ) : (
            <div className={styles.uploadArea}>
              {!isEditMode ? (
                <p className={styles.uploadHint}>{labels.itemDetail.uploadOnlyEditMode}</p>
              ) : (
                <>
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
                  <label htmlFor="fileUpload" className={styles.fileLabel}>
                    {labels.itemDetail.uploadChooseFile}
                  </label>

                  {uploadDocStatus !== 'none' && (
                    <p
                      className={`${styles.docStatus} ${
                        uploadDocStatus === 'ready'
                          ? styles.docStatusReady
                          : uploadDocStatus === 'rejected' || uploadDocStatus === 'extraction_failed'
                          ? styles.docStatusError
                          : styles.docStatusPending
                      }`}
                      aria-live="polite"
                    >
                      {docStatusMessage(uploadDocStatus)}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
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
              onClick={() => navigate('/admin/items')}
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
    </div>
  );
}
