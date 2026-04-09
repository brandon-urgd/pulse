import { useNavigate, useParams } from 'react-router-dom';
import ItemDetailModal from './ItemDetailModal';

/**
 * Item detail page — renders the item form in full-page mode.
 * Used for the /admin/items/:itemId route (back-links from Pulse Check,
 * Session Report, and Revision pages land here).
 *
 * Refactored from a standalone 860-line component to a thin wrapper
 * around ItemDetailModal in page mode, sharing the useItemForm hook.
 */
export default function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();

  return (
    <ItemDetailModal
      itemId={itemId}
      onClose={() => navigate('/admin/items', { state: { returnFocusId: itemId } })}
      variant="page"
    />
  );
}
