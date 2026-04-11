import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useItemForm, fileStatusLabel, todayIso } from '../hooks/useItemForm';
import { useCan } from '../hooks/useCan';
import { labels } from '../config/labels-registry';
import InviteModal from './InviteModal';
import DocumentPreviewPanel from '../components/DocumentPreviewPanel';
import SectionPanel from '../components/SectionPanel';
import CoverageIndicator from '../components/CoverageIndicator';
import { PulseWaveLoader } from '../components/PulseWaveLoader';
import AssessmentHelper from '../components/AssessmentHelper';
import { authedMutate } from '../hooks/useAuthedMutation';
import styles from './ItemDetailModal.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  itemId?: string;       // undefined = create mode
  onClose: () => void;
  /** Render as a full page instead of a modal overlay (used on mobile) */
  variant?: 'modal' | 'page';
}

// ─── Dirty tracking helper ────────────────────────────────────────────────────

/** Returns true when any form field has been touched relative to the loaded item. */
function useIsDirty(form: ReturnType<typeof useItemForm>, isEditMode: boolean): boolean {
  const initial = useRef<{ name: string; desc: string; close: string; content: string } | null>(null);

  useEffect(() => {
    if (isEditMode && form.itemData) {
      initial.current = {
        name: form.itemData.itemName,
        desc: form.itemData.description,
        close: form.itemData.closeDate ?? '',
        content: form.itemData.content ?? '',
      };
    }
  }, [form.itemData, isEditMode]);

  // For create mode, dirty = any field has content
  if (!isEditMode) {
    return !!(form.itemName.trim() || form.description.trim() || form.content.trim());
  }

  // For edit mode, dirty = any field differs from loaded values
  if (!initial.current) return false;
  return (
    form.itemName !== initial.current.name ||
    form.description !== initial.current.desc ||
    form.content !== initial.current.content
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ItemDetailModal({ itemId, onClose, variant = 'modal' }: Props) {
  const isPageMode = variant === 'page';

  const form = useItemForm({ itemId, onClose });
  const isDirty = useIsDirty(form, form.isEditMode);

  // ── Session cap warning ─────────────────────────────────────────────────────
  const { limit: maxSessionsPerItem } = useCan('maxSessionsPerItem');
  const sessionCount = form.itemData?.sessionCount ?? 0;
  const showSessionCapWarning = maxSessionsPerItem !== null
    && sessionCount >= maxSessionsPerItem - 3
    && sessionCount < maxSessionsPerItem;

  // ── Unsaved changes confirmation (page mode only) ───────────────────────────
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const discardResolveRef = useRef<((discard: boolean) => void) | null>(null);

  const handlePageBack = useCallback(() => {
    if (isDirty) {
      setShowDiscardDialog(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  function handleDiscardConfirm() {
    setShowDiscardDialog(false);
    discardResolveRef.current = null;
    onClose();
  }

  function handleDiscardCancel() {
    setShowDiscardDialog(false);
    discardResolveRef.current = null;
  }

  // Warn on browser back / tab close when dirty in page mode
  useEffect(() => {
    if (!isPageMode || !isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isPageMode, isDirty]);

  // ── Focus trap for modal mode ───────────────────────────────────────────────
  const focusTrapRef = useFocusTrap(!isPageMode && !form.showInviteModal);

  // ── Page mode: focus header on mount ────────────────────────────────────────
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isPageMode && headerRef.current) {
      headerRef.current.focus();
    }
  }, [isPageMode]);

  // ── Lock body scroll while modal is open ────────────────────────────────────
  useEffect(() => {
    if (isPageMode) return;
    const scrollY = window.scrollY;
    const prevOverflow = document.body.style.overflow;
    const prevPosition = document.body.style.position;
    const prevTop = document.body.style.top;
    const prevWidth = document.body.style.width;

    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.position = prevPosition;
      document.body.style.top = prevTop;
      document.body.style.width = prevWidth;
      window.scrollTo(0, scrollY);
    };
  }, []);

  // ── Esc to close (stable ref avoids listener churn on every render) ────────
  const handleCancelRef = useRef<() => void | Promise<void>>(form.handleCancel);
  handleCancelRef.current = isPageMode ? handlePageBack : form.handleCancel;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleCancelRef.current(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      ref={isPageMode ? undefined : focusTrapRef}
      className={isPageMode ? styles.pageWrapper : styles.overlay}
      onClick={isPageMode ? undefined : (e) => { if (e.target === e.currentTarget) form.handleCancel(); }}
      role={isPageMode ? undefined : 'dialog'}
      aria-modal={isPageMode ? undefined : true}
      aria-labelledby="item-modal-title"
    >
      <div className={`${isPageMode ? styles.pageCard : styles.modal} ${(form.previewData || form.showSectionsPane) ? styles.modalExpanded : ''}`}>
        {/* Header */}
        <div
          className={styles.modalHeader}
          ref={isPageMode ? headerRef : undefined}
          tabIndex={isPageMode ? -1 : undefined}
          aria-label={isPageMode ? (form.isEditMode ? form.itemName || 'Edit item' : 'New item') : undefined}
        >
          <h2 id="item-modal-title" className={styles.modalTitle}>
            {form.isEditMode ? labels.itemDetail.editHeading : labels.itemDetail.newHeading}
          </h2>
          {showSessionCapWarning && (
            <span className={styles.sessionCapWarning} role="status" aria-live="polite">
              {labels.itemDetail.sessionCapWarning
                .replace('{used}', String(sessionCount))
                .replace('{max}', String(maxSessionsPerItem))}
            </span>
          )}
          {(form.isEditMode || form.savedItemId.current) && !form.showSectionsPane && (
            <>
              {form.timeLimitMinutes != null && (form.isEditMode || !Object.values(form.fileStatuses).some(s => s.status === 'ready')) && (
                <div className={styles.headerTimeLimitWrapper}>
                  <div className={styles.headerTimeLimitRow}>
                    <label htmlFor="headerTimeLimitSelect" className={styles.headerTimeLimitLabel}>
                      {labels.itemDetail.timeLimitLabel}
                    </label>
                    <select
                      id="headerTimeLimitSelect"
                      className={styles.timeLimitSelect}
                      value={form.timeLimitMinutes}
                      onChange={(e) => form.setTimeLimitMinutes(Number(e.target.value))}
                    >
                      {labels.itemDetail.timeLimitBrackets
                        .filter((b) => form.sessionTimeLimit === null || b.value <= form.sessionTimeLimit)
                        .map((b) => (
                        <option key={b.value} value={b.value}>{b.label}</option>
                      ))}
                    </select>
                  </div>
                  <p className={styles.timeLimitHint}>{labels.itemDetail.timeLimitHint}</p>
                </div>
              )}
              {(form.itemData?.status === 'draft' || form.itemData?.status === 'active') && !form.isExampleItem && (
                <button
                  type="button"
                  className={styles.headerActionSelfReview}
                  onClick={() => form.handleSelfReview()}
                  disabled={form.isSelfReviewLoading}
                  title={labels.itemDetail.selfReviewTooltip}
                >
                  {form.isSelfReviewLoading ? labels.itemDetail.selfReviewLoading : labels.itemDetail.selfReviewButton}
                </button>
              )}
              {!form.isExampleItem && (
                <button
                  type="button"
                  className={styles.headerActionPreview}
                  onClick={form.handleSessionPreview}
                  disabled={form.isSessionPreviewLoading}
                >
                  {form.isSessionPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
                </button>
              )}
            </>
          )}
          {isPageMode ? (
            <button
              type="button"
              className={styles.backButton}
              onClick={handlePageBack}
              aria-label="Back to items"
            >
              ← Back
            </button>
          ) : (
            <button
              type="button"
              className={styles.closeButton}
              onClick={form.handleCancel}
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* Session preview inline feedback */}
        {form.sessionPreviewError && (
          <p className={styles.formError} role="alert" aria-live="polite">{form.sessionPreviewError}</p>
        )}
        {form.sessionPreviewPopupBlocked && (
          <p className={styles.previewNotice} aria-live="polite">{labels.itemDetail.previewSessionPopupBlocked}</p>
        )}
        {form.selfReviewError && (
          <p className={styles.formError} role="alert" aria-live="polite">{form.selfReviewError}</p>
        )}
        {form.selfReviewExistingId && (
          <div className={styles.selfReviewResetBanner} role="alert">
            <span>{labels.itemDetail.selfReviewExistsNotice}</span>
            <button
              type="button"
              className={styles.selfReviewResetConfirm}
              onClick={() => form.handleSelfReview(form.selfReviewExistingId!)}
              disabled={form.isSelfReviewLoading}
            >
              {labels.itemDetail.selfReviewStartOver}
            </button>
            <button
              type="button"
              className={styles.selfReviewResetCancel}
              onClick={() => form.setSelfReviewExistingId(null)}
            >
              {labels.itemDetail.selfReviewStartOverCancel}
            </button>
          </div>
        )}

        {/* Inner layout — flex row when right pane is open */}
        <div className={(form.previewData || form.showSectionsPane) ? styles.modalInner : styles.modalSinglePane}>
          {/* Form pane */}
          <div className={(form.previewData || form.showSectionsPane) ? styles.modalFormPane : styles.modalFormSingle}>
            {/* Body */}
            <div className={styles.modalBody}>
              {form.isEditMode && form.itemLoading ? (
                <div className={styles.loading} aria-busy="true"><span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Loading item…</span></div>
              ) : (
                <>
                  {form.isLocked && (
                    <p className={styles.lockedNotice} role="status">
                      🔒 {labels.itemDetail.readOnlyNotice}
                    </p>
                  )}

                  {form.isExampleItem && (
                    <div className={styles.exampleCallout} role="status">
                      <p className={styles.exampleCalloutText}>
                        {labels.itemDetail.exampleCallout}
                      </p>
                    </div>
                  )}

                  <form id="item-detail-form" onSubmit={form.handleSubmit} noValidate className={styles.form}>
                    <div className={styles.field}>
                      <label htmlFor="itemName" className={styles.label}>
                        {labels.itemDetail.fieldName} <span className={styles.required} aria-hidden="true">*</span>
                      </label>
                      <input
                        id="itemName"
                        type="text"
                        className={styles.input}
                        value={form.itemName}
                        onChange={(e) => form.setItemName(e.target.value)}
                        maxLength={200}
                        required
                        disabled={form.isLocked}
                        placeholder={labels.itemDetail.fieldNamePlaceholder}
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
                        value={form.closeDate}
                        onChange={(e) => form.setCloseDate(e.target.value)}
                        min={todayIso()}
                        required
                        disabled={form.isLocked}
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
                        value={form.content}
                        onChange={(e) => form.setContent(e.target.value)}
                        rows={8}
                        disabled={form.isLocked}
                        placeholder={labels.itemDetail.fieldContentPlaceholder}
                      />

                      <label className={styles.subLabel}>{labels.itemDetail.contentUploadLabel}</label>
                      <div className={styles.uploadArea}>
                        <p className={styles.uploadHint}>
                          {`Accepts .md, .txt, .pdf, .docx, or images (.jpg, .png, .webp, .gif) — max ${form.maxUploadMb ?? 10} MB. Uploading a new file replaces the previous one.`}
                        </p>
                        <input
                          ref={form.fileInputRef}
                          type="file"
                          id="fileUpload"
                          className={styles.fileInput}
                          accept=".md,.txt,.pdf,.docx,.jpg,.jpeg,.png,.webp,.gif"
                          onChange={form.handleFileChange}
                          disabled={form.isUploading || form.isLocked}
                          aria-label={labels.itemDetail.uploadChooseFile}
                        />
                        <label
                          htmlFor="fileUpload"
                          className={`${styles.fileLabel} ${(form.isUploading || form.isLocked) ? styles.fileLabelDisabled : ''}`}
                        >
                          {form.isUploading ? labels.itemDetail.uploadStatusUploading : labels.itemDetail.uploadChooseFile}
                        </label>

                        {Object.entries(form.fileStatuses).map(([name, state]) => {
                          const isReady = state.status === 'ready';
                          const isInFlight = state.status === 'uploading' || state.status === 'scanning' || state.status === 'extracting';
                          const isLoadingThis = form.loadingPreviewFile === name;
                          return (
                            <div
                              key={name}
                              className={`${styles.fileStatusRow} ${isReady ? styles.fileStatusRowClickable : ''}`}
                              aria-live="polite"
                              role={isReady ? 'button' : undefined}
                              tabIndex={isReady ? 0 : undefined}
                              aria-label={isReady ? labels.itemDetail.previewAriaLabel.replace('{filename}', name) : undefined}
                              onClick={isReady ? (e) => form.handlePreviewClick(name, e) : undefined}
                              onKeyDown={isReady ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  form.handlePreviewClick(name, e);
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
                              {!isInFlight && !form.isLocked && (
                                <button
                                  type="button"
                                  className={styles.fileRemoveButton}
                                  onClick={(e) => { e.stopPropagation(); form.handleRemoveFile(); }}
                                  aria-label={`Remove ${name}`}
                                >×</button>
                              )}
                            </div>
                          );
                        })}

                        {/* Time limit + preview CTA — moved to sections pane when visible */}
                        {!form.showSectionsPane && !form.isEditMode && Object.values(form.fileStatuses).some(s => s.status === 'ready') && (
                          <div className={styles.uploadReadyCtas}>
                            <div className={styles.timeLimitRow}>
                              <label htmlFor="timeLimitSelect" className={styles.timeLimitLabel}>
                                {labels.itemDetail.timeLimitLabel}
                              </label>
                              <select
                                id="timeLimitSelect"
                                className={styles.timeLimitSelect}
                                value={form.timeLimitMinutes ?? 17}
                                onChange={(e) => form.setTimeLimitMinutes(Number(e.target.value))}
                              >
                                {labels.itemDetail.timeLimitBrackets
                                  .filter((b) => form.sessionTimeLimit === null || b.value <= form.sessionTimeLimit)
                                  .map((b) => (
                                  <option key={b.value} value={b.value}>{b.label}</option>
                                ))}
                              </select>
                              <p className={styles.timeLimitHint}>{labels.itemDetail.timeLimitHint}</p>
                            </div>
                            <button
                              type="button"
                              className={styles.uploadCtaPreview}
                              onClick={form.handleSessionPreview}
                              disabled={form.isSessionPreviewLoading}
                            >
                              {form.isSessionPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={styles.field}>
                      <label htmlFor="description" className={styles.label}>
                        {labels.itemDetail.fieldDescription} <span className={styles.required} aria-hidden="true">*</span>
                      </label>
                      <p className={styles.subLabel}>{labels.itemDetail.fieldDescriptionHint}</p>
                      <textarea
                        id="description"
                        className={styles.textarea}
                        value={form.description}
                        onChange={(e) => form.setDescription(e.target.value)}
                        maxLength={2000}
                        rows={8}
                        required
                        disabled={form.isLocked}
                        placeholder={labels.itemDetail.fieldDescriptionPlaceholder}
                      />
                      <span className={styles.charCount}>{form.description.length}/2,000</span>
                      <AssessmentHelper
                        itemId={form.savedItemId.current ?? itemId ?? null}
                        itemType={form.itemData?.itemType ?? 'document'}
                        description={form.description}
                        hasDocument={Object.values(form.fileStatuses).some((s) => s.status === 'ready')}
                        onUseSuggestion={(text) => form.setDescription(text)}
                        onEditSuggestion={(text) => {
                          form.setDescription(text);
                          setTimeout(() => {
                            const el = document.getElementById('description') as HTMLTextAreaElement | null;
                            el?.focus();
                          }, 50);
                        }}
                        onAppendExample={(text) => {
                          form.setDescription((prev) => prev ? `${prev}\n${text}` : text);
                        }}
                      />
                    </div>

                    <p className={styles.retentionNotice}>
                      {labels.retention.shortNotice} {labels.retention.archiveNotice}
                    </p>

                    {form.formError && (
                      <p className={styles.formError} role="alert" aria-live="polite">
                        {form.formError}
                      </p>
                    )}
                  </form>
                </>
              )}
            </div>

            {/* Actions — pinned footer outside scrollable body */}
            {!(form.isEditMode && form.itemLoading) && (
              <div className={styles.actions}>
                {form.isEditMode && !form.isExampleItem && (
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={() => form.setShowDeleteModal(true)}
                    disabled={form.isDeleting}
                  >
                    {labels.itemDetail.deleteButton}
                  </button>
                )}
                <div className={styles.actionsSpacer} />
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={form.handleCancel}
                  disabled={form.isSaving}
                >
                  {labels.itemDetail.cancelButton}
                </button>
                {!form.isLocked && !form.isExampleItem && (
                  <button
                    type="submit"
                    form="item-detail-form"
                    className={styles.saveButton}
                    disabled={form.isSaving || form.isAnyFileInFlight || (!form.isEditMode && form.monthlyItemsAtLimit)}
                    title={form.isAnyFileInFlight ? 'Waiting for document to finish processing…' : (!form.isEditMode && form.monthlyItemsAtLimit) ? labels.plan.monthlyLimitReached.replace('{resetDate}', form.monthlyItemsResetDate) : undefined}
                  >
                    {form.isSaving ? '…' : form.isAnyFileInFlight ? 'Processing…'
                      : (!form.isEditMode && !form.savedItemId.current && form.content.trim().length > 0) ? 'Next'
                      : labels.itemDetail.saveButton}
                  </button>
                )}
                {!form.isEditMode && form.monthlyItemsAtLimit && (
                  <p className={styles.formError} role="status">
                    {labels.plan.monthlyLimitReached.replace('{resetDate}', form.monthlyItemsResetDate)}
                  </p>
                )}
                {!form.isEditMode && form.monthlyItemsNearLimit && !form.monthlyItemsAtLimit && (
                  <p className={styles.limitNotice} role="status">
                    {labels.plan.monthlyLimitNear
                      .replace('{remaining}', String(form.monthlyItemsLimit! - form.monthlyItemsCount))
                      .replace('{resetDate}', form.monthlyItemsResetDate)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Preview pane — takes priority over sections pane */}
          {form.previewData && (
            <DocumentPreviewPanel
              url={form.previewData.url}
              contentType={form.previewData.contentType}
              filename={form.previewData.filename}
              originalUrl={form.previewData.originalUrl}
              onClose={() => form.setPreviewData(null)}
              triggerRef={form.previewTriggerRef as React.RefObject<HTMLElement | null>}
            />
          )}

          {/* Sections pane — shown when sectionMap or file ready, hidden when preview is open */}
          {!form.previewData && form.showSectionsPane && (
            <div className={styles.sectionsPane} role="region" aria-label="Document analysis">
              {/* Time selector */}
              {form.timeLimitMinutes != null && (
                <div className={styles.sectionsPaneBlock}>
                  <div className={styles.timeLimitRow}>
                    <label htmlFor="sectionsPaneTimeSelect" className={styles.timeLimitLabel}>
                      {labels.itemDetail.timeLimitLabel}
                    </label>
                    <select
                      id="sectionsPaneTimeSelect"
                      className={styles.timeLimitSelect}
                      value={form.timeLimitMinutes}
                      onChange={(e) => form.setTimeLimitMinutes(Number(e.target.value))}
                    >
                      {labels.itemDetail.timeLimitBrackets
                        .filter((b) => form.sessionTimeLimit === null || b.value <= form.sessionTimeLimit)
                        .map((b) => (
                        <option key={b.value} value={b.value}>{b.label}</option>
                      ))}
                    </select>
                  </div>
                  <p className={styles.timeLimitHint}>{labels.itemDetail.timeLimitHint}</p>
                </div>
              )}

              {/* Preview + Self-review buttons */}
              <div className={styles.sectionsPaneActions}>
                {!form.isExampleItem && (
                  <button
                    type="button"
                    className={styles.uploadCtaPreview}
                    onClick={form.handleSessionPreview}
                    disabled={form.isSessionPreviewLoading}
                  >
                    {form.isSessionPreviewLoading ? labels.itemDetail.previewSessionLoading : labels.itemDetail.previewSessionButton}
                  </button>
                )}
                {(form.itemData?.status === 'draft' || form.itemData?.status === 'active') && !form.isExampleItem && (
                  <button
                    type="button"
                    className={styles.headerActionSelfReview}
                    onClick={() => form.handleSelfReview()}
                    disabled={form.isSelfReviewLoading}
                    title={labels.itemDetail.selfReviewTooltip}
                  >
                    {form.isSelfReviewLoading ? labels.itemDetail.selfReviewLoading : labels.itemDetail.selfReviewButton}
                  </button>
                )}
              </div>

              {/* Section panel — or loading indicator while analyzing */}
              {form.hasSections ? (
                <SectionPanel
                  sections={form.itemData!.sectionMap!.sections}
                  feedbackSections={form.feedbackSections}
                  sectionDepthPreferences={form.sectionDepthPreferences}
                  onToggleSection={form.handleToggleSection}
                  onChangeDepth={form.handleChangeDepth}
                  disabled={form.isLocked}
                />
              ) : (
                <div className={styles.sectionsPaneBlock}>
                  {form.sectionAnalysisTimedOut ? (
                    <p className={styles.timeLimitHint}>{labels.itemDetail.analysisTimeout}</p>
                  ) : (
                    <PulseWaveLoader text={labels.itemDetail.analyzingDocument} />
                  )}
                </div>
              )}

              {/* Coverage indicator */}
              {form.itemData?.coverageMap && form.itemData?.sectionMap?.sections && form.itemData.sessionCount > 0 && (
                <CoverageIndicator
                  sections={form.itemData.sectionMap.sections
                    .filter((s) => form.feedbackSections.includes(s.id))
                    .map((s) => ({ id: s.id, title: s.title }))}
                  coverageMap={form.itemData.coverageMap}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {form.showDeleteModal && (
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
              {labels.itemDetail.deleteConfirmMessage.replace('{itemName}', form.itemName)}
            </p>
            {form.deleteError && (
              <p className={styles.formError} role="alert">{form.deleteError}</p>
            )}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => { form.setShowDeleteModal(false); form.setDeleteError(''); }}
                disabled={form.isDeleting}
              >
                {labels.itemDetail.deleteConfirmCancel}
              </button>
              <button
                type="button"
                className={styles.destructiveButton}
                onClick={() => { form.setDeleteError(''); form.deleteMutation.mutate(undefined); }}
                disabled={form.isDeleting}
              >
                {labels.itemDetail.deleteConfirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-save invite flow — shown after creating a new item */}
      {form.showInviteModal && form.savedItem && (
        <InviteModal
          itemId={form.savedItem.itemId}
          itemName={form.savedItem.itemName}
          onClose={() => { form.setShowInviteModal(false); onClose(); }}
          skipLabel="Skip for now"
          onSelfReview={async () => {
            const newTab = window.open('', '_blank');
            form.setShowInviteModal(false);
            const targetItemId = form.savedItemId.current ?? itemId;
            if (!targetItemId || !newTab) {
              if (newTab) newTab.close();
              onClose();
              return;
            }
            try {
              const resp = await authedMutate(
                `/api/manage/items/${targetItemId}/self-review`,
                'POST',
                { ...(form.timeLimitMinutes != null ? { timeLimitMinutes: form.timeLimitMinutes } : {}) },
                form.navigate
              ) as { data: { sessionId: string; sessionUrl: string } };
              newTab.location.href = resp.data.sessionUrl;
            } catch {
              newTab.close();
            }
            onClose();
          }}
        />
      )}

      {/* Unsaved changes confirmation — page mode only */}
      {showDiscardDialog && (
        <div
          className={styles.discardOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="discard-dialog-title"
        >
          <div className={styles.discardModal}>
            <h3 id="discard-dialog-title" className={styles.discardTitle}>
              Discard changes?
            </h3>
            <p className={styles.discardMessage}>
              You have unsaved changes. Are you sure you want to leave?
            </p>
            <div className={styles.discardActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={handleDiscardCancel}
                autoFocus
              >
                Keep editing
              </button>
              <button
                type="button"
                className={styles.destructiveButton}
                onClick={handleDiscardConfirm}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
