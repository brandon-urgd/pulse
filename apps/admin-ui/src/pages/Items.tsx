import { useEffect } from 'react';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { labels } from '../config/labels-registry';
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

/**
 * Items page — lists all items or shows empty/error state.
 * Requirements: 3.18, 3.19
 */
export default function Items() {
  const { data, isLoading, isError, refetch } = useAuthedQuery<ItemsResponse>(
    ['items'],
    '/api/manage/items'
  );

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
        <div className={styles.newItemWrapper}>
          <button
            type="button"
            disabled
            className={styles.newItemButton}
            aria-describedby="new-item-tooltip"
          >
            {labels.items.newItemButton}
          </button>
          <span id="new-item-tooltip" role="tooltip" className={styles.tooltip}>
            {labels.items.newItemTooltip}
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p>{labels.items.emptyState}</p>
        </div>
      ) : (
        <ul className={styles.itemList}>
          {items.map((item) => (
            <li key={item.itemId} className={`${styles.itemCard} ${styles[`status-${item.status}`]}`}>
              <span className={styles.itemName}>{item.itemName}</span>
              <span className={styles.itemStatus}>{item.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
