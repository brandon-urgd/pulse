import { useNavigate, useParams } from 'react-router-dom';
import ItemDetailModal from './ItemDetailModal';

/**
 * Full-page edit item form for mobile viewports.
 * Reads the itemId from the URL and renders ItemDetailModal
 * in page mode instead of a modal overlay.
 */
export default function ItemEditPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();

  return (
    <ItemDetailModal
      itemId={itemId}
      onClose={() => navigate('/admin/items')}
      variant="page"
    />
  );
}
