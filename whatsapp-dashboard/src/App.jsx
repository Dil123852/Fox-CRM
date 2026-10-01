import { useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { theme } from './lib/theme';
import Sidebar from './components/Sidebar';
import PhoneAlerts from './components/PhoneAlerts';
import NotificationAlerts from './components/NotificationAlerts';
import { DialogProvider, useDialog } from './components/DialogProvider';
import Login from './pages/Login';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Messages from './pages/Messages';
import OrdersPage from './components/OrdersPage';
import OrderDeliveryPage from './pages/OrderDeliveryPage';
import Reports from './pages/Reports';
import Warranty from './pages/Warranty';
import Inventory from './pages/Inventory';
import PromoCodes from './pages/PromoCodes';
import PromoCodesView from './pages/PromoCodesView';
import Team from './pages/Team';
import Calls from './pages/Calls';
import CallbackTracker from './pages/CallbackTracker';
import BulkMessages from './pages/BulkMessages';
import Users from './pages/Users';
import Oversight from './pages/Oversight';
import Notifications from './pages/Notifications';
import Quotations from './pages/Quotations';
import { isSuperAdmin, roleAllowed, SUPER_ADMIN } from './lib/roles';

// Delivery coordinators land on /orders instead of /leads — the default
// fallback below (both for a denied ProtectedRoute and the "/" redirect)
// has to route them somewhere they can actually reach, now that Pipeline
// and Chat are off-limits for that role (confirmed with the user).
function defaultRouteFor(role) {
  // A super admin lands on the oversight console — the screen that only they
  // can see, and the reason the role exists. Also LOAD-BEARING: the fallback
  // below is '/leads', whose own gate does not list super_admin, so without
  // this case a denied route would redirect to /leads, be denied again, and
  // loop forever. (The ProtectedRoute short-circuit prevents that too; this is
  // the belt to its braces.)
  if (isSuperAdmin(role)) return '/oversight';
  if (role === 'delivery_coordinator') return '/orders';
  // An inventory manager's job is stock, not the sales pipeline — land them
  // on the Inventory page now that one exists. (They still have access to
  // /leads; this is only about where "/" and a denied route send them.)
  if (role === 'inventory_manager') return '/inventory';
  return '/leads';
}

function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, staff } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // roleAllowed() folds in the super_admin case so that role passes every
  // gate without being listed on each <Route>. Mirrors requireRole() in the
  // backend and visible() in the Sidebar.
  if (!roleAllowed(staff?.role, roles)) return <Navigate to={defaultRouteFor(staff?.role)} replace />;
  return children;
}

function HomeRedirect() {
  const { staff } = useAuth();
  return <Navigate to={defaultRouteFor(staff?.role)} replace />;
}

// Pages report outcomes as { message, type: 'on' | 'off' } (the shape the old
// bottom toast took). They are shown as popups now:
//   'on'                      -> success, closes itself after 4s
//   'off' that is a failure   -> error, stays until OK
//   'off' otherwise           -> neutral notice ("AI paused for this chat"), closes itself
const FAILURE = /fail|could not|error/i;

function useNotify() {
  const dialog = useDialog();
  return useCallback(
    ({ message, type }) => {
      if (!message) return;
      if (type === 'on') dialog.alert({ title: message, tone: 'success', autoCloseMs: 4000 });
      else if (FAILURE.test(message)) dialog.alert({ title: message, tone: 'error' });
      else dialog.alert({ title: message, tone: 'info', autoCloseMs: 4000 });
    },
    [dialog]
  );
}

function AppRoutes() {
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const setToast = useNotify();
  const isLoginPage = location.pathname === '/login';

  if (isLoginPage) return <Login />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div style={s.shell} className="app-shell">
      <Sidebar />
      <div style={s.main}>
        {/* "Your phone is not connected to the CRM" — above every page. */}
        <PhoneAlerts />
        <NotificationAlerts />
        <Routes>
          <Route path="/"              element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
          <Route path="/leads"         element={<ProtectedRoute roles={['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer']}><Leads /></ProtectedRoute>} />
          <Route path="/leads/:id"     element={<ProtectedRoute roles={['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer']}><LeadDetail /></ProtectedRoute>} />
          <Route path="/customers"     element={<ProtectedRoute roles={['admin', 'viewer', 'sales_agent']}><Customers /></ProtectedRoute>} />
          <Route path="/customers/:id" element={<ProtectedRoute><CustomerDetail /></ProtectedRoute>} />
          <Route path="/messages"      element={<ProtectedRoute roles={['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer']}><Messages onToast={setToast} /></ProtectedRoute>} />
          <Route path="/orders"        element={<ProtectedRoute><OrdersPage onToast={setToast} /></ProtectedRoute>} />
          <Route path="/orders/:id/delivery" element={<ProtectedRoute roles={['delivery_coordinator']}><OrderDeliveryPage /></ProtectedRoute>} />
          <Route path="/reports"       element={<ProtectedRoute roles={['admin', 'viewer']}><Reports /></ProtectedRoute>} />
          <Route path="/warranty"      element={<ProtectedRoute roles={['admin', 'viewer', 'sales_agent']}><Warranty onToast={setToast} /></ProtectedRoute>} />
          <Route path="/inventory"     element={<ProtectedRoute roles={['admin', 'inventory_manager', 'viewer']}><Inventory onToast={setToast} /></ProtectedRoute>} />
          <Route path="/promo"        element={<ProtectedRoute roles={['admin', 'viewer']}><PromoCodes onToast={setToast} /></ProtectedRoute>} />
          {/* Read-only list for sales agents — no create/edit/delete, no influencers. */}
          <Route path="/promo-codes"  element={<ProtectedRoute roles={['sales_agent']}><PromoCodesView /></ProtectedRoute>} />
          <Route path="/team"         element={<ProtectedRoute roles={['admin', 'viewer']}><Team /></ProtectedRoute>} />
          <Route path="/calls"        element={<ProtectedRoute roles={['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer']}><Calls /></ProtectedRoute>} />
          <Route path="/callbacks"    element={<ProtectedRoute roles={['admin', 'sales_agent']}><CallbackTracker /></ProtectedRoute>} />
          <Route path="/bulk-messages" element={<ProtectedRoute roles={['admin']}><BulkMessages /></ProtectedRoute>} />
          <Route path="/users"        element={<ProtectedRoute roles={['admin']}><Users /></ProtectedRoute>} />
          <Route path="/oversight"    element={<ProtectedRoute roles={[SUPER_ADMIN]}><Oversight /></ProtectedRoute>} />
          {/* Admin-only in the nav because only admins receive any today (a
              custom discount given by a non-admin, migration 053). */}
          {/* Same roles as GET /api/quotations; only admin/sales_agent can edit. */}
          <Route path="/quotations"   element={<ProtectedRoute roles={['admin', 'sales_agent', 'viewer']}><Quotations /></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute roles={['admin']}><Notifications /></ProtectedRoute>} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* In-app confirm/alert dialogs for every page (replaces window.confirm/alert). */}
      <DialogProvider>
        <AppRoutes />
      </DialogProvider>
    </AuthProvider>
  );
}

const s = {
  shell: {
    display: 'flex', height: '100vh', overflow: 'hidden',
    background: theme.bg, fontFamily: theme.font,
  },
  // 100%, not 100vh: on wide screens index.css zooms .app-shell and divides
  // ITS height by the zoom factor, but a 100vh inside the zoomed shell is
  // zoomed again — the page rendered 15-30% taller than the window and its
  // bottom (pagination, last rows) was cut off. Filling the shell fits at any zoom.
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
};
