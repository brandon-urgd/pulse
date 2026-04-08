import { useNavigate } from 'react-router-dom';
import ItemDetailModal from './ItemDetailModal';

/**
 * Full-page create item form for mobile viewports.
 * Renders the same ItemDetailModal form in page mode
 * instead of a modal overlay. Desktop users continue to use
 * the modal from the Items list page.
 */
export default function ItemNewPage() {
  const navigate = useNavigate();

  return (
    <ItemDetailModal
      onClose={() => navigate('/admin/items')}
      variant="page"
    />
  );
}
