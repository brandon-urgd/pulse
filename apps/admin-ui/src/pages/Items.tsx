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

// ─── Swipeable card ───────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 60; // px to trigger reveal
const REVEAL_WIDTH    = 80; // px width of delete zone

interface SwipeCardProps {
  item: Item;
  onOpen: () => void;
  onInvite: () => void;
  onDeleted: () => void;
}

function SwipeCard({ item, onOpen, onInvite, onDeleted }: SwipeCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [offset, setOffset]       = useState(0);       // current translateX (negative = swiped left)
  const [revealed, setRevealed]   = useState(false);   // delete button fully visible
  const [confirming, setConfirming] = useState(false); // confirm strip showing
  const [deleting, setDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const startX   = useRef<number | null>(null);
  const startOff = useRef(0);
  const dragging = useRef(false);

  // ── pointer helpers ────────────────────────────────────────────────────────
  function beginDrag(clientX: number) {
    startX.current  = clientX;
    startOff.current = offset;
    dragging.current = false;
  }

  function moveDrag(clientX: number) {
    if (startX.current === null) return;
    const delta = clientX - startX.current;
    if (Math.abs(delta) > 5) dragging.current = true;
    const next = Math.max(-REVEAL_WIDTH, Math.min(0, startOff.current + delta));
    setOffset(next);
  }

  function endDrag() {
    if (startX.current === null) return;
    startX.current = null;
    if (offset < -SWIPE_THRESHOLD) {
      setOffset(-REVEAL_WIDTH);
      setRevealed(true);
    } else {
      setOffset(0);
      setRevealed(false);
    }
  }

  // ── touch ──────────────────────────────────────────────────────────────────
  function onTouchStart(e: React.TouchEvent) { beginDrag(e.touches[0].clientX); }
  function onTouchMove(e: React.TouchEvent)  { moveDrag(e.touches[0].clientX); }
  function onTouchEnd()                       { endDrag(); }

  // ── mouse ──────────────────────────────────────────────────────────────────
  function onMouseDown(e: React.MouseEvent) { beginDrag(e.clientX); }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) { if (startX.current !== null) moveDrag(e.clientX); }
    function onMouseUp()                { if (startX.current !== null) endDrag(); }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  });

  function handleCardClick() {
    if (dragging.current) return; // was a drag, not a tap
    if (revealed) {
      // tap on card while revealed → snap back
      setOffset(0);
      setRevealed(false);
      setConfirming(false);
      return;
    }
    onOpen();
  }

  async function handleConfirmDelete() {
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
    <li className={styles.swipeWrapper}>
      {/* Delete reveal layer */}
      <div className={styles.deleteReveal}>
        {confirming ? (
          <div className={styles.confirmStrip}>
            {deleteError && <span className={styles.deleteErrMsg}>{deleteError}</span>}
            <button
              type="button"
              className={styles.confirmCancelBtn}
              onClick={() => { setConfirming(false); setOffset(0); setRevealed(false); }}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.confirmDeleteBtn}
              onClick={handleConfirmDelete}
              disabled={deleting}
            >
              {deleting ? '…' : 'Delete'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.deleteRevealBtn}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${item.itemName}`}
          >
            🗑
          </button>
        )}
      </div>

      {/* Card */}
      <div
        className={`${styles.itemCard} ${STATUS_CLASS[item.status]}`}
        style={{ transform: `translateX(${offset}px)`, transition: startX.current ? 'none' : 'transform 0.25s ease' }}
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCardClick(); }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
      >
        <div className={styles.itemMain}>
          <span className={styles.itemName}>{item.itemName}</span>
          <p className={styles.descriptionExcerpt}>
            {(item.description?.length ?? 0) > 100
              ? `${item.description.slice(0, 100)}…`
              : (item.description ?? '')}
          </p>
        </div>
        <div className={styles.itemMeta}>
          <span className={`${styles.statusBadge} ${STATUS_CLASS[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
          <span className={styles.sessionCount}>
            {labels.items.sessionCount.replace('{count}', String(item.sessionCount))}
          </span>
          <span className={styles.closeDate}>
            {labels.items.closeDate} {formatCloseDate(item.closeDate)}
          </span>
          <button
            type="button"
            className={styles.inviteButton}
            onClick={(e) => { e.stopPropagation(); onInvite(); }}
            aria-label={`Invite reviewers for ${item.itemName}`}
          >
            {labels.items.inviteButton}
          </button>
        </div>
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
            <SwipeCard
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
