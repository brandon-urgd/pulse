import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from './useAuthedQuery';
import { useAuthedMutation, authedMutate } from './useAuthedMutation';
import { labels } from '../config/labels-registry';
import { useCan } from './useCan';
import type { Section } from '../components/SectionPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemStatus = 'draft' | 'active' | 'closed' | 'revised';
export type DocumentStatus = 'none' | 'scanning' | 'extracting' | 'ready' | 'rejected' | 'extraction_failed';
export type FileUploadStatus = 'uploading' | 'scanning' | 'extracting' | 'ready' | 'rejected' | 'extraction_failed' | 'error';

export interface FileUploadState {
  status: FileUploadStatus;
  error?: string;
}

export interface Item {
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
  itemType?: 'document' | 'image';
  isExample?: boolean;
  sectionMap?: {
    sections: Section[];
    totalSubstantiveSections: number;
    analyzedAt: string;
  };
  feedbackSections?: string[];
  sectionDepthPreferences?: Record<string, 'deep' | 'explore' | 'skim'>;
  coverageMap?: Record<string, { sessionCount: number; avgDepth?: string; reviewerIds?: string[] }>;
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

export interface PreviewData {
  url: string;
  contentType: string;
  filename: string;
  originalUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function utcToLocalDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function appendTimezoneOffset(dateStr: string): string {
  if (!dateStr) return dateStr;
  if (/[Z+-]\d{2}:\d{2}$/.test(dateStr) || dateStr.endsWith('Z')) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const minutes = String(absOffset % 60).padStart(2, '0');
  const base = dateStr.length === 16 ? `${dateStr}:00` : dateStr;
  return `${base}${sign}${hours}:${minutes}`;
}

export function fileStatusLabel(status: FileUploadStatus): string {
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

export { todayIso };

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseItemFormOptions {
  itemId?: string;
  onClose: () => void;
}

export function useItemForm({ itemId, onClose }: UseItemFormOptions) {
  const isEditMode = Boolean(itemId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Form state ────────────────────────────────────────────────────────────
  const [itemName, setItemName]       = useState('');
  const [description, setDescription] = useState('');
  const [closeDate, setCloseDate]     = useState('');
  const [content, setContent]         = useState('');

  // ── UI state ──────────────────────────────────────────────────────────────
  const [formError, setFormError]             = useState('');
  const [isLocked, setIsLocked]               = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError]         = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [savedItem, setSavedItem]             = useState<{ itemId: string; itemName: string } | null>(null);

  // ── Upload state ──────────────────────────────────────────────────────────
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileUploadState>>({});
  const [isUploading, setIsUploading]   = useState(false);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const mountedRef    = useRef(true);
  const savedItemId   = useRef<string | null>(itemId ?? null);
  const [savedItemIdState, setSavedItemIdState] = useState<string | null>(itemId ?? null);
  const autoSaved     = useRef(false);
  const uploadingCreate = useRef(false);

  // ── Document preview state ────────────────────────────────────────────────
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [loadingPreviewFile, setLoadingPreviewFile] = useState<string | null>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);

  // ── Session preview state ─────────────────────────────────────────────────
  const [isSessionPreviewLoading, setIsSessionPreviewLoading] = useState(false);
  const [sessionPreviewError, setSessionPreviewError]         = useState('');
  const [sessionPreviewPopupBlocked, setSessionPreviewPopupBlocked] = useState(false);

  // ── Self-review state ─────────────────────────────────────────────────────
  const [isSelfReviewLoading, setIsSelfReviewLoading] = useState(false);
  const [selfReviewError, setSelfReviewError]         = useState('');
  const [selfReviewExistingId, setSelfReviewExistingId] = useState<string | null>(null);

  // ── Section analysis state ────────────────────────────────────────────────
  const [sectionAnalysisTimedOut, setSectionAnalysisTimedOut] = useState(false);

  // ── Time limit state ──────────────────────────────────────────────────────
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number | null>(null);
  const { limit: sessionTimeLimit } = useCan('sessionTimeLimitMinutes');
  const { limit: maxUploadMb } = useCan('maxUploadSizeMb');

  // ── Monthly item creation limit ───────────────────────────────────────────
  const { limit: monthlyItemsLimit } = useCan('monthlyItemsCreated');
  const settingsCache = queryClient.getQueryData<{ data: { usageCounters?: Record<string, { count: number; periodStart?: string }> } }>(['settings']);
  const monthlyItemsCount = settingsCache?.data?.usageCounters?.monthlyItemsCreated?.count ?? 0;
  const monthlyItemsPeriodStart = settingsCache?.data?.usageCounters?.monthlyItemsCreated?.periodStart;
  const monthlyItemsAtLimit = monthlyItemsLimit !== null && monthlyItemsCount >= monthlyItemsLimit;
  const monthlyItemsNearLimit = monthlyItemsLimit !== null && !monthlyItemsAtLimit && (monthlyItemsLimit - monthlyItemsCount) <= 1;
  const monthlyItemsResetDate = monthlyItemsPeriodStart
    ? (() => { const d = new Date(monthlyItemsPeriodStart); const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); return next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); })()
    : '';

  // ── Section preferences state ─────────────────────────────────────────────
  const [feedbackSections, setFeedbackSections] = useState<string[]>([]);
  const [sectionDepthPreferences, setSectionDepthPreferences] = useState<Record<string, 'deep' | 'explore' | 'skim'>>({});
  const sectionsInitialized = useRef(false);

  // ── Derived upload state ──────────────────────────────────────────────────
  const isAnyFileInFlight = Object.values(fileStatuses).some(
    (s) => s.status === 'uploading' || s.status === 'scanning' || s.status === 'extracting'
  );
  const perFileTimeLimits = useRef<Record<string, number>>({});

  // ── Load item ─────────────────────────────────────────────────────────────
  const activeItemId = itemId ?? savedItemIdState;
  const { data: itemResp, isLoading: itemLoading } = useAuthedQuery<{ data: Item }>(
    ['item', activeItemId],
    `/api/manage/items/${activeItemId}`,
    { enabled: !!activeItemId }
  );
  const itemData = itemResp?.data;

  useEffect(() => {
    if (itemData) {
      if (isEditMode) {
        setItemName(itemData.itemName);
        setDescription(itemData.description);
        setCloseDate(itemData.closeDate ? utcToLocalDatetimeLocal(itemData.closeDate) : '');
        setContent(itemData.content ?? '');
      }
      setIsLocked(itemData.status !== 'draft');
      if (itemData.recommendedTimeLimitMinutes && timeLimitMinutes === null) {
        const brackets = labels.itemDetail.timeLimitBrackets
          .filter((b) => sessionTimeLimit === null || b.value <= sessionTimeLimit);
        const raw = itemData.recommendedTimeLimitMinutes;
        const snapped = brackets.reduce((best, b) =>
          Math.abs(b.value - raw) < Math.abs(best.value - raw) ? b : best
        ).value;
        setTimeLimitMinutes(snapped);
      } else if (!itemData.recommendedTimeLimitMinutes && timeLimitMinutes === null && itemData.content) {
        const words = itemData.content.trim().split(/\s+/).length;
        const rawMinutes = Math.max(5, Math.min(60, Math.round(words / 130)));
        const brackets = labels.itemDetail.timeLimitBrackets
          .filter((b) => sessionTimeLimit === null || b.value <= sessionTimeLimit);
        const snapped = brackets.reduce((best, b) =>
          Math.abs(b.value - rawMinutes) < Math.abs(best.value - rawMinutes) ? b : best
        ).value;
        setTimeLimitMinutes(snapped);
      }
      if (itemData.documentStatus && itemData.documentStatus !== 'none') {
        const fileName = itemData.documentKey
          ? itemData.documentKey.split('/').pop() ?? '_loaded'
          : '_loaded';
        setFileStatuses({ [fileName]: { status: itemData.documentStatus as FileUploadStatus } });
      }
      if (itemData.sectionMap?.sections && !sectionsInitialized.current) {
        sectionsInitialized.current = true;
        const defaultIncluded = itemData.feedbackSections
          ?? itemData.sectionMap.sections
              .filter((s) => s.classification === 'substantive')
              .map((s) => s.id);
        setFeedbackSections(defaultIncluded);

        const defaultDepths = itemData.sectionDepthPreferences
          ?? Object.fromEntries(
              itemData.sectionMap.sections.map((s) => [
                s.id,
                s.classification === 'substantive' ? 'explore' as const : 'skim' as const,
              ])
            );
        setSectionDepthPreferences(defaultDepths);
      }
    }
  }, [itemData]);

  // ── Mount / unmount tracking ──────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMutation = useAuthedMutation<{ data: Item }, CreateItemPayload>(
    '/api/manage/items',
    'POST',
    {
      onSuccess: (resp) => {
        savedItemId.current = resp.data.itemId;
        setSavedItemIdState(resp.data.itemId);
        autoSaved.current = true;
        queryClient.invalidateQueries({ queryKey: ['items'] });
        if (!uploadingCreate.current) {
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

  // ── Handlers ──────────────────────────────────────────────────────────────
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
      closeDate: appendTimezoneOffset(closeDate),
      ...(content.trim() ? { content: content.trim() } : {}),
      ...(feedbackSections.length > 0 ? { feedbackSections } : {}),
      ...(Object.keys(sectionDepthPreferences).length > 0 ? { sectionDepthPreferences } : {}),
      ...(timeLimitMinutes != null ? { recommendedTimeLimitMinutes: timeLimitMinutes } : {}),
    };

    if (isEditMode) {
      updateMutation.mutate(payload);
    } else if (savedItemId.current) {
      const targetId = savedItemId.current;
      authedMutate(`/api/manage/items/${targetId}`, 'PUT', payload, navigate)
        .then((resp) => {
          queryClient.invalidateQueries({ queryKey: ['items'] });
          queryClient.invalidateQueries({ queryKey: ['item', targetId] });
          const updated = (resp as { data: Item }).data;
          setSavedItem({ itemId: targetId, itemName: updated?.itemName ?? payload.itemName });
          setShowInviteModal(true);
        })
        .catch(() => setFormError(labels.itemDetail.saveError));
    } else {
      const hasPastedContent = content.trim().length > 0 && !Object.keys(fileStatuses).length;
      if (hasPastedContent) {
        uploadingCreate.current = true;
        createMutation.mutate(payload, {
          onSuccess: () => {
            uploadingCreate.current = false;
            const words = content.trim().split(/\s+/).length;
            const rawMinutes = Math.max(5, Math.min(60, Math.round(words / 130)));
            const brackets = labels.itemDetail.timeLimitBrackets
              .filter((b) => sessionTimeLimit === null || b.value <= sessionTimeLimit);
            const snapped = brackets.reduce((best, b) =>
              Math.abs(b.value - rawMinutes) < Math.abs(best.value - rawMinutes) ? b : best
            ).value;
            setTimeLimitMinutes(snapped);
            setFormError('');
            if (savedItemId.current) {
              pollForSectionMap(savedItemId.current);
            }
          },
        });
      } else {
        createMutation.mutate(payload);
      }
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
          closeDate: appendTimezoneOffset(closeDate) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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
          const resp = await authedMutate(`/api/manage/items/${targetItemId}`, 'GET', undefined, navigate) as { data: Item };
          const refreshed = resp?.data;
          const status = (refreshed?.documentStatus ?? 'none') as DocumentStatus;
          if (!mountedRef.current) { resolve(); return; }
          if (status === 'ready' || status === 'rejected' || status === 'extraction_failed') {
            setFileStatuses((prev) => ({ ...prev, [fileName]: { status: status as FileUploadStatus } }));
            if (status === 'ready' && refreshed?.recommendedTimeLimitMinutes) {
              perFileTimeLimits.current[fileName] = refreshed.recommendedTimeLimitMinutes;
              const total = Object.values(perFileTimeLimits.current).reduce((a, b) => a + b, 0);
              const brackets = labels.itemDetail.timeLimitBrackets
                .filter((b) => sessionTimeLimit === null || b.value <= sessionTimeLimit);
              const snapped = brackets.reduce((best, b) =>
                Math.abs(b.value - total) < Math.abs(best.value - total) ? b : best
              ).value;
              setTimeLimitMinutes(snapped);
            }
            queryClient.setQueryData(['item', targetItemId], { data: refreshed });
            resolve();
            if (status === 'ready' && !refreshed?.sectionMap) {
              pollForSectionMap(targetItemId);
            }
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

  function pollForSectionMap(targetItemId: string) {
    let attempts = 0;
    const maxAttempts = 15;
    setSectionAnalysisTimedOut(false);
    async function poll() {
      if (!mountedRef.current) return;
      if (attempts >= maxAttempts) {
        if (mountedRef.current) setSectionAnalysisTimedOut(true);
        return;
      }
      attempts++;
      try {
        const resp = await authedMutate(`/api/manage/items/${targetItemId}`, 'GET', undefined, navigate) as { data: Item };
        if (resp?.data?.sectionMap?.sections) {
          queryClient.setQueryData(['item', targetItemId], { data: resp.data });
          queryClient.invalidateQueries({ queryKey: ['item', targetItemId] });
          return;
        }
      } catch { /* keep polling */ }
      if (mountedRef.current) setTimeout(poll, 2000);
    }
    setTimeout(poll, 3000);
  }

  function recalcTimeFromSections(
    included: string[],
    depths: Record<string, 'deep' | 'explore' | 'skim'>
  ) {
    if (!itemData?.sectionMap?.sections || !itemData.recommendedTimeLimitMinutes) return;
    const allSections = itemData.sectionMap.sections;
    const totalWeight = allSections.reduce((sum, s) => sum + (s.classification === 'substantive' ? 2 : 1), 0);
    if (totalWeight === 0) return;

    const depthMultiplier: Record<string, number> = { deep: 1.5, explore: 1, skim: 0.5 };
    const includedWeight = allSections
      .filter((s) => included.includes(s.id))
      .reduce((sum, s) => {
        const base = s.classification === 'substantive' ? 2 : 1;
        const mult = depthMultiplier[depths[s.id] ?? 'explore'] ?? 1;
        return sum + base * mult;
      }, 0);

    const ratio = includedWeight / totalWeight;
    const rawMinutes = Math.max(5, Math.round(itemData.recommendedTimeLimitMinutes * ratio));
    const brackets = labels.itemDetail.timeLimitBrackets
      .filter((b) => sessionTimeLimit === null || b.value <= sessionTimeLimit);
    const snapped = brackets.reduce((best, b) =>
      Math.abs(b.value - rawMinutes) < Math.abs(best.value - rawMinutes) ? b : best
    ).value;
    setTimeLimitMinutes(snapped);
  }

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

  async function handleSessionPreview() {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId || isSessionPreviewLoading) return;
    setIsSessionPreviewLoading(true);
    setSessionPreviewError('');
    setSessionPreviewPopupBlocked(false);

    const newTab = window.open('', '_blank');
    if (!newTab) {
      setSessionPreviewPopupBlocked(true);
      setIsSessionPreviewLoading(false);
      return;
    }

    try {
      const resp = await authedMutate(
        `/api/manage/items/${targetItemId}/preview-session`,
        'GET',
        timeLimitMinutes != null ? { timeLimitMinutes } : undefined,
        navigate
      ) as { data: { previewUrl: string } };
      newTab.location.href = resp.data.previewUrl;
    } catch {
      newTab.close();
      setSessionPreviewError(labels.itemDetail.previewSessionError);
    } finally {
      setIsSessionPreviewLoading(false);
    }
  }

  async function handleSelfReview(forceSessionId?: string) {
    const targetItemId = savedItemId.current ?? itemId;
    if (!targetItemId || isSelfReviewLoading) return;
    setIsSelfReviewLoading(true);
    setSelfReviewError('');
    setSelfReviewExistingId(null);

    const newTab = window.open('', '_blank');
    if (!newTab) {
      setSelfReviewError(labels.itemDetail.selfReviewError);
      setIsSelfReviewLoading(false);
      return;
    }

    try {
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
      newTab.location.href = resp.data.sessionUrl;
    } catch (err: unknown) {
      newTab.close();
      const status = (err as { status?: number }).status ?? 500;
      const body = (err as { body?: { existingSessionId?: string } }).body;
      if (status === 409 && body?.existingSessionId) {
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

  function handleToggleSection(sectionId: string, included: boolean) {
    const next = included
      ? [...feedbackSections, sectionId]
      : feedbackSections.filter((id) => id !== sectionId);
    setFeedbackSections(next);
    recalcTimeFromSections(next, sectionDepthPreferences);
  }

  function handleChangeDepth(sectionId: string, depth: 'deep' | 'explore' | 'skim') {
    const next = { ...sectionDepthPreferences, [sectionId]: depth };
    setSectionDepthPreferences(next);
    recalcTimeFromSections(feedbackSections, next);
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const isSaving  = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;
  const isExampleItem = Boolean(itemData?.isExample);
  const hasSections = !!(itemData?.sectionMap?.sections && itemData.sectionMap.sections.length > 0);
  const hasFileReady = Object.values(fileStatuses).some(s => s.status === 'ready');
  const hasSavedContent = !!(savedItemId.current && content.trim().length > 0 && timeLimitMinutes != null);
  const isImageItem = itemData?.itemType === 'image';
  const showSectionsPane = !isImageItem && (hasSections || hasFileReady || hasSavedContent);

  return {
    // Identity
    isEditMode,
    isNew: !isEditMode,
    navigate,

    // Item data
    itemData,
    itemLoading,
    isExampleItem,

    // Form fields
    itemName, setItemName,
    description, setDescription,
    closeDate, setCloseDate,
    content, setContent,

    // UI state
    formError, setFormError,
    isLocked,
    showDeleteModal, setShowDeleteModal,
    deleteError, setDeleteError,
    showInviteModal, setShowInviteModal,
    savedItem, setSavedItem,

    // Upload state
    fileStatuses,
    isUploading,
    fileInputRef,
    isAnyFileInFlight,
    savedItemId,
    savedItemIdState,
    autoSaved,

    // Document preview
    previewData, setPreviewData,
    loadingPreviewFile,
    previewTriggerRef,

    // Session preview
    isSessionPreviewLoading,
    sessionPreviewError,
    sessionPreviewPopupBlocked,

    // Self-review
    isSelfReviewLoading,
    selfReviewError,
    selfReviewExistingId, setSelfReviewExistingId,

    // Section analysis
    sectionAnalysisTimedOut,

    // Time limit
    timeLimitMinutes, setTimeLimitMinutes,
    sessionTimeLimit,
    maxUploadMb,

    // Monthly limits
    monthlyItemsLimit,
    monthlyItemsCount,
    monthlyItemsAtLimit,
    monthlyItemsNearLimit,
    monthlyItemsResetDate,

    // Section preferences
    feedbackSections,
    sectionDepthPreferences,

    // Derived
    isSaving,
    isDeleting,
    hasSections,
    hasFileReady,
    showSectionsPane,

    // Handlers
    handleSubmit,
    handleCancel,
    handleFileChange,
    handleRemoveFile,
    handlePreviewClick,
    handleSessionPreview,
    handleSelfReview,
    handleToggleSection,
    handleChangeDepth,

    // Mutations (for post-save invite flow)
    deleteMutation,

    // Helpers
    todayIso,
  };
}
