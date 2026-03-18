import { useEffect, useState } from 'react';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { labels } from '../config/labels-registry';
import ItemDetailModal from './ItemDetailModal';
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
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function Items() {
  const { data, isLoading, isError, refetch } = useAuthedQuery<ItemsResponse>(
    ['items'],
    '/api/manage/items'
  );

  // null = closed, 'new' = create, string = edit itemId
  const [modalTarget, setModalTarget] = useState<string | 'new' | null>(null);

  useEffect(() => {
    document.title = labels.items.documentTitle;
  }, []);

  if (isLoading) {
    return <div className={styles.container} aria-busy="true" />;
  }

  if (isError) {
    return (
      <div className={styles.container}>
        <p role="alert" aria-live="polite" className={styles.error}>
          {labels.items.loadError}
        </p>
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
        <button
          type="button"
          className={styles.newItemButton}
          onClick={() => setModalTarget('new')}
        >
          {labels.items.newItemButton}
        </button>
      </div>

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p>{labels.items.emptyState}</p>
        </div>
      ) : (
        <ul className={styles.itemList}>
          {items.map((item) => (
            <li
              key={item.itemId}
              className={`${styles.itemCard} ${STATUS_CLASS[item.status]}`}
              onClick={() => setModalTarget(item.itemId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setModalTarget(item.itemId);
              }}
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
              </div>
            </li>
          ))}
        </ul>
      )}

      {modalTarget !== null && (
        <ItemDetailModal
          itemId={modalTarget === 'new' ? undefined : modalTarget}
          onClose={() => setModalTarget(null)}
        />
      )}
    </div>
  );
}
