import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import ItemDetailModal from './ItemDetailModal';
import InviteModal from './InviteModal';
import styles from './Items.module.css';

interface Item {
  itemId: string;
  itemName: string;
  description: string;
  status: 'draft' | 'active' | 'closed' | 'revised';
  sessionCount: number;
  closeDate: string;
  updatedAt: string;
  createdAt?: string;
  hasPulseCheck?: boolean;
}

type SortField = 'name' | 'created' | 'dueDate';
type SortDir = 'asc' | 'desc';

const SORT_STORAGE_KEY = 'pulse_items_sort';

function loadSort(): { field: SortField; dir: SortDir } {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { field: 'created', dir: 'desc' };
}

function saveSort(field: SortField, dir: SortDir) {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field, dir })); } catch { /* ignore */ }
}

function sortItems(items: Item[], field: SortField, dir: SortDir): Item[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    if (field === 'name') {
      cmp = (a.itemName ?? '').localeCompare(b.itemName ?? '');
    } else if (field === 'created') {
      cmp = (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '');
    } else if (field === 'dueDate') {
      cmp = (a.closeDate ?? '').localeCompare(b.closeDate ?? '');
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

interface ItemsResponse {
  data: Item[];
}

const STATUS_CLASS: Record<Item['status'], string> = {
  draft: styles.statusDraft,
  active: styles.statusActive,
  closed: styles.statusClosed,
  revised: styles.statusRevised,
};

const STATUS_LABEL: Record<Item['status'], string> = {
  draft: labels.items.statusDraft,
  active: labels.items.statusActive,
  closed: labels.items.statusClosed,
  revised: labels.items.statusRevised,
};

function formatCloseDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

// ─── Pulse Check button helpers ───────────────────────────────────────────────

function pulseCheckButtonLabel(item: Item): string {
  if (item.status === 'draft') return labels.items.pulseCheckButton;
  if (item.status === 'active') return labels.items.pulseCheckInProgress;
  if (item.status === 'closed' && !item.hasPulseCheck) return labels.items.pulseCheckStart;
  return labels.items.pulseCheckReview;
}

function pulseCheckButtonClass(item: Item): string {
  if (item.status === 'draft') return styles.actionPulseCheckDisabled;
  if (item.status === 'closed' && !item.hasPulseCheck) return styles.actionPulseCheckReady;
  return styles.actionPulseCheck;
}

function pulseCheckAriaLabel(item: Item): string {
  return `${pulseCheckButtonLabel(item)} — ${item.itemName}`;
}

// ─── Item card ────────────────────────────────────────────────────────────────

interface ItemCardProps {
  item: Item;
  onOpen: () => void;
  onInvite: () => void;
  onPulseCheck: () => void;
  onDeleted: () => void;
}

function ItemCard({ item, onOpen, onInvite, onPulseCheck, onDeleted }: ItemCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    try {
      await authedMutate(`/api/manage/items/${item.itemId}`, 'DELETE', undefined, navigate);
      queryClient.invalidateQueries({ queryKey: ['items'] });
      onDeleted();
    } catch {
      setDeleteError('Delete failed. Try again.');
      setDeleting(false);
    }
  }

  return (
    <li className={`${styles.itemCard} ${STATUS_CLASS[item.status]}`}>
      {/* Content area — clickable to edit */}
      <button
        type="button"
        className={styles.cardContent}
        onClick={onOpen}
        aria-label={`Edit ${item.itemName}`}
      >
        <div className={styles.cardTop}>
          <span className={styles.itemName}>{item.itemName}</span>
          <span className={`${styles.statusBadge} ${STATUS_CLASS[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
        </div>
        <p className={styles.descriptionExcerpt}>
          {(item.description?.length ?? 0) > 120
            ? `${item.description.slice(0, 120)}…`
            : (item.description ?? '')}
        </p>
        <div className={styles.cardMeta}>
          <span className={styles.sessionCount}>
            {labels.items.sessionCount.replace('{count}', String(item.sessionCount))}
          </span>
          <span className={styles.closeDate}>
            {labels.items.closeDate} {formatCloseDate(item.closeDate)}
          </span>
        </div>
      </button>

      {/* Action row */}
      <div className={styles.cardActions}>
        <button type="button" className={styles.actionEdit} onClick={onOpen}>
          Edit
        </button>
        {item.status !== 'closed' && item.status !== 'revised' && (
          <button type="button" className={styles.actionInvite} onClick={onInvite}>
            {labels.items.inviteButton}
          </button>
        )}
        {item.status !== 'draft' && (
          <button
            type="button"
            className={pulseCheckButtonClass(item)}
            onClick={onPulseCheck}
            aria-label={pulseCheckAriaLabel(item)}
          >
            {pulseCheckButtonLabel(item)}
          </button>
        )}
        {confirming ? (
          <div className={styles.deleteConfirmRow}>
            {deleteError && <span className={styles.deleteErrMsg}>{deleteError}</span>}
            <button
              type="button"
              className={styles.actionCancelConfirm}
              onClick={() => { setConfirming(false); setDeleteError(''); }}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.actionDeleteConfirm}
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? '…' : 'Confirm delete'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.actionDelete}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${item.itemName}`}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Items() {
  const { data, isLoading, isError, refetch } = useAuthedQuery<ItemsResponse>(
    ['items'],
    '/api/manage/items'
  );
  const navigate = useNavigate();

  const [modalTarget, setModalTarget] = useState<string | 'new' | null>(null);
  const [inviteTarget, setInviteTarget] = useState<Item | null>(null);

  const [sortField, setSortField] = useState<SortField>(() => loadSort().field);
  const [sortDir, setSortDir] = useState<SortDir>(() => loadSort().dir);

  function handleSort(field: SortField) {
    const newDir: SortDir = sortField === field && sortDir === 'asc' ? 'desc' : 'asc';
    setSortField(field);
    setSortDir(newDir);
    saveSort(field, newDir);
  }

  useEffect(() => {
    document.title = labels.items.documentTitle;
  }, []);

  const rawItems = data?.data ?? [];
  const items = useMemo(() => sortItems(rawItems, sortField, sortDir), [rawItems, sortField, sortDir]);

  if (isLoading) return <div className={styles.container} aria-busy="true" />;

  if (isError) {
    return (
      <div className={styles.container}>
        <p role="alert" aria-live="polite" className={styles.error}>{labels.items.loadError}</p>
        <button type="button" onClick={() => refetch()} className={styles.retryButton}>
          {labels.items.retryButton}
        </button>
      </div>
    );
  }

  const sortLabel = (field: SortField, label: string) => {
    const active = sortField === field;
    const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    return `${label}${arrow}`;
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>{labels.items.title}</h1>
        <button type="button" className={styles.newItemButton} onClick={() => setModalTarget('new')}>
          {labels.items.newItemButton}
        </button>
      </div>

      {rawItems.length > 0 && (
        <div className={styles.sortBar} role="group" aria-label="Sort items">
          <span className={styles.sortLabel}>Sort:</span>
          {(['name', 'created', 'dueDate'] as SortField[]).map((f) => {
            const labelMap: Record<SortField, string> = { name: 'Name', created: 'Created', dueDate: 'Due date' };
            return (
              <button
                key={f}
                type="button"
                className={`${styles.sortButton} ${sortField === f ? styles.sortButtonActive : ''}`}
                onClick={() => handleSort(f)}
                aria-pressed={sortField === f}
              >
                {sortLabel(f, labelMap[f])}
              </button>
            );
          })}
        </div>
      )}

      {items.length === 0 ? (
        <div className={styles.emptyState}><p>{labels.items.emptyState}</p></div>
      ) : (
        <ul className={styles.itemList}>
          {items.map((item) => (
            <ItemCard
              key={item.itemId}
              item={item}
              onOpen={() => setModalTarget(item.itemId)}
              onInvite={() => setInviteTarget(item)}
              onPulseCheck={() => navigate(`/admin/pulse-check/${item.itemId}`)}
              onDeleted={() => {}}
            />
          ))}
        </ul>
      )}

      {modalTarget !== null && (
        <ItemDetailModal
          itemId={modalTarget === 'new' ? undefined : modalTarget}
          onClose={() => setModalTarget(null)}
        />
      )}

      {inviteTarget !== null && (
        <InviteModal
          itemId={inviteTarget.itemId}
          itemName={inviteTarget.itemName}
          onClose={() => setInviteTarget(null)}
        />
      )}
    </div>
  );
}
