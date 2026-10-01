import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { onEvent } from '../lib/sse';
import { useDialog } from './DialogProvider';

// A small corner note when a staff notification arrives live (migration 053 —
// e.g. a sales agent gave a custom discount). Mounted once in App, like
// PhoneAlerts, so it follows the admin across every page and renders nothing
// itself. Never blocks the page: the stored copy on the Notifications page is
// the record, this is only the heads-up.
export default function NotificationAlerts() {
  const { staff } = useAuth();
  const isAdmin = roleAllowed(staff?.role, ['admin']);
  const dialog = useDialog();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAdmin) return undefined;
    return onEvent('notification', e => {
      let n;
      try {
        n = JSON.parse(e.data);
      } catch {
        return;
      }
      dialog.notify({
        title: n.title,
        message: n.body,
        tone: 'warning',
        action: n.order_id
          ? { label: 'Open order', onClick: () => navigate(`/orders?open=${n.order_id}`) }
          : n.quotation_id
            ? { label: 'Open quotation', onClick: () => navigate(`/quotations?open=${n.quotation_id}`) }
            : { label: 'View all', onClick: () => navigate('/notifications') },
      });
    });
  }, [isAdmin, dialog, navigate]);

  return null;
}
