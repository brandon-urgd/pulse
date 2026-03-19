import { useEffect, useState } from 'react';
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

// ─── Item card ────────────────────────────────────────────────────────────────

interface ItemCardProps {
  item: Item;
  onOpen: () => void;
  onInvite: () => void;
  onDeleted: () => void;
}

function ItemCard({ item, onOpen, onInvite, onDeleted }: ItemCardProps) {
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
        <button type="button" className={styles.actionInvite} onClick={onInvite}>
          {labels.items.inviteButton}
        </button>
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

  const [modalTarget, setModalTarget] = useState<string | 'new' | null>(null);
  const [inviteTarget, setInviteTarget] = useState<Item | null>(null);

  useEffect(() => {
    document.title = labels.items.documentTitle;
  }, []);

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

  const items = data?.data ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>{labels.items.title}</h1>
        <button type="button" className={styles.newItemButton} onClick={() => setModalTarget('new')}>
          {labels.items.newItemButton}
        </button>
      </div>

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
