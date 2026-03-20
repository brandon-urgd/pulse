import { Link } from 'react-router-dom';
import styles from './PulseCheckIndex.module.css';

/**
 * Empty state shown when navigating to /admin/pulse-check without an itemId.
 * Pulse Check is item-scoped — this guides the user to select an item first.
 */
export default function PulseCheckIndex() {
  return (
    <div className={styles.container}>
      <p className={styles.heading}>Select an item to view its Pulse Check.</p>
      <Link to="/admin/items" className={styles.link}>
        Go to Items →
      </Link>
    </div>
  );
}
