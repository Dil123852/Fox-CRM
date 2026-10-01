import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LogOut, Bell, FileText, Smartphone } from 'lucide-react';
import {
  PipelineIcon, OrdersIcon, ChatsIcon, CallsIcon, CallbacksIcon, CustomersIcon,
  InsightsIcon, TeamIcon, InventoryIcon, WarrantyIcon, PromoIcon, BulkIcon,
  UserMgmtIcon, OversightIcon,
} from './navIcons';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { theme } from '../lib/theme';
import { roleAllowed, SUPER_ADMIN } from '../lib/roles';
import { useNotifications } from '../lib/notifications';
import ConnectPhoneModal, { OPEN_CONNECT_PHONE } from './ConnectPhoneModal';

// Deliberately SHORTER than lib/roles.js's ROLE_LABELS ('Inventory', not
// 'Inventory Manager'): this renders in the narrow sidebar footer, where the
// full label wraps. Kept local for that reason rather than imported.
const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  sales_agent: 'Sales Agent',
  inventory_manager: 'Inventory',
  delivery_coordinator: 'Delivery',
  finance: 'Finance',
  viewer: 'Viewer',
};

// Pipeline/Chats hidden from delivery_coordinator (confirmed with the
// user — that role's job is fulfillment on orders already placed, not the
// sales pipeline or customer chat); every other role keeps the same
// unrestricted access these two links always had.
const NOT_DELIVERY = ['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer'];
// Icons are the reference design's own glyphs (see navIcons.jsx), in the
// reference's own order.
const WORKSPACE_LINKS = [
  { to: '/leads',     label: 'Pipeline',  Icon: PipelineIcon,  countKey: 'leads', roles: NOT_DELIVERY },
  { to: '/orders',    label: 'Orders',    Icon: OrdersIcon,    countKey: 'orders' },
  // Quotations (migration 054) — same roles as GET /api/quotations.
  { to: '/quotations', label: 'Quotations', Icon: FileText,     roles: ['admin', 'sales_agent', 'viewer'] },
  { to: '/messages',  label: 'Chats',     Icon: ChatsIcon,     roles: NOT_DELIVERY },
  { to: '/calls',     label: 'Calls',     Icon: CallsIcon,     roles: NOT_DELIVERY },
  // Narrower than NOT_DELIVERY on purpose — a sales accountability worklist,
  // so admin/sales_agent only. Must stay in step with App.jsx's route gate and
  // GET /api/calls/callbacks, or the link renders and then 403s.
  { to: '/callbacks', label: 'Callbacks', Icon: CallbacksIcon, roles: ['admin', 'sales_agent'] },
  { to: '/customers', label: 'Customers', Icon: CustomersIcon, roles: ['admin', 'viewer', 'sales_agent'] },
  { to: '/reports',   label: 'Insights',  Icon: InsightsIcon,  roles: ['admin', 'viewer'] },
  { to: '/team',      label: 'Team',      Icon: TeamIcon,      roles: ['admin', 'viewer'] },
  // Admins are told here when a non-admin gives a custom discount (migration
  // 053). The count is UNREAD notifications, and it also shows as a dot on the
  // collapsed rail, since that is the whole point of the item.
  { to: '/notifications', label: 'Notifications', Icon: Bell, countKey: 'notifications', roles: ['admin'], alert: true },
];

const OPERATIONS_LINKS = [
  { to: '/inventory',      label: 'Inventory',       Icon: InventoryIcon, roles: ['admin', 'inventory_manager', 'viewer'] },
  { to: '/warranty',       label: 'Warranty',        Icon: WarrantyIcon,  roles: ['admin', 'viewer', 'sales_agent'] },
  { to: '/promo',          label: 'Promo codes',     Icon: PromoIcon,     roles: ['admin', 'viewer'] },
  // Sales agents get the read-only page instead (PromoCodesView.jsx).
  { to: '/promo-codes',    label: 'Promo codes',     Icon: PromoIcon,     roles: ['sales_agent'] },
  { to: '/bulk-messages',  label: 'Bulk Messages',   Icon: BulkIcon,      roles: ['admin'] },
  { to: '/users',          label: 'User Management', Icon: UserMgmtIcon,  roles: ['admin'] },
  // super_admin only, and the only nav item that role alone can see. Listed
  // explicitly rather than relying on the roleAllowed() short-circuit, so an
  // admin does not see a link that would immediately redirect them away.
  { to: '/oversight',      label: 'Oversight',       Icon: OversightIcon, roles: [SUPER_ADMIN] },
];

// The collapsed rail is sized to its widest content, not picked by eye: a nav
// row is 8px of nav padding either side + 7px of item padding either side + a
// 14px icon = 44px. 52 leaves 8px of slack around that, and comfortably clears
// the 24px footer avatar. Going much below this starts clipping the icons'
// hover/active background rather than just tightening the gutter.
const COLLAPSED_W = 52;
const EXPANDED_W  = 232;
// Must equal the page topbar's height (LeadsPage `p.topbar`). The sidebar's
// brand divider and the topbar's bottom border meet at the sidebar seam, so a
// mismatch shows as two horizontal rules at slightly different heights. Pinned
// to an explicit height rather than left to add up from padding, which is how
// they drifted 4px apart in the first place.
const HEADER_H = 44;

// A hover-driven drawer: the sidebar always reserves COLLAPSED_W of real
// layout space (icons only, never pushes the main content), and on hover it
// absolutely-positions itself over the content and grows to EXPANDED_W to
// reveal labels — mouse-out snaps it back to icon-only.
export default function Sidebar() {
  const { staff, logout } = useAuth();
  const [counts, setCounts] = useState({ leads: 0, orders: 0 });
  const [expanded, setExpanded] = useState(false);
  const { unread } = useNotifications(roleAllowed(staff?.role, ['admin']));
  // "Connect my phone" (QR sign-in for the Call Tracker app, migration 056).
  // Only for the roles the server lets pair a phone. Also opened from the
  // "your phone is not connected" popup via a window event (PhoneAlerts).
  const canPairPhone = roleAllowed(staff?.role, ['admin', 'sales_agent']);
  const [connectOpen, setConnectOpen] = useState(false);
  useEffect(() => {
    if (!canPairPhone) return undefined;
    const open = () => setConnectOpen(true);
    window.addEventListener(OPEN_CONNECT_PHONE, open);
    return () => window.removeEventListener(OPEN_CONNECT_PHONE, open);
  }, [canPairPhone]);

  useEffect(() => {
    // delivery_coordinator can't read /api/leads (403) — skip the call
    // rather than let it fail silently every mount.
    if (staff?.role !== 'delivery_coordinator') {
      apiFetch('/api/leads').then(r => r.json()).then(d => setCounts(c => ({ ...c, leads: (d.leads || []).length }))).catch(() => {});
    }
    apiFetch('/api/orders').then(r => r.json()).then(d => setCounts(c => ({ ...c, orders: (d.orders || []).length }))).catch(() => {});
  }, [staff?.role]);

  // roleAllowed() folds in the super_admin case, so that role sees every nav
  // item without being listed on each one — the same short-circuit the backend
  // does in requireRole() and App.jsx does in ProtectedRoute. All three must
  // agree or a link renders and then 403s.
  const visible = link => roleAllowed(staff?.role, link.roles);
  const countFor = key => (key === 'notifications' ? unread : counts[key]);

  return (
    <div style={s.rail}>
      <aside
        style={{ ...s.sidebar, width: expanded ? EXPANDED_W : COLLAPSED_W }}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
      >
        <div style={{ ...s.brand, justifyContent: expanded ? 'flex-start' : 'center', padding: expanded ? '0 12px' : 0 }}>
          <div style={s.brandMark}>
            <img src="https://res.cloudinary.com/ciqslzrw/image/upload/v1787141453/magnific_make-a-cartoonize-version_mEQy2OxhJQ.jpg_ymmudd.jpg" alt="Nidikumba" style={s.brandLogo} />
          </div>
          {expanded && (
            <div>
              <div style={s.brandName}>Nidikumba</div>
              <div style={s.brandSub}>Sales &amp; Ops</div>
            </div>
          )}
        </div>

        <nav style={s.nav}>
          {expanded && <p style={s.navLabel}>Workspace</p>}
          {WORKSPACE_LINKS.filter(visible).map(({ to, label, Icon, countKey, alert }) => (
            <NavLink key={to} to={to} title={expanded ? undefined : label}
              className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
              style={({ isActive }) => ({ ...s.navItem, justifyContent: expanded ? 'flex-start' : 'center', ...(isActive ? s.navItemActive : {}) })}>
              {({ isActive }) => (
                <>
                  <span style={s.iconWrap}>
                    <Icon size={14} strokeWidth={isActive ? 2.1 : 1.8} style={{ flexShrink: 0 }} />
                    {alert && !expanded && countFor(countKey) > 0 && <span style={s.alertDot} />}
                  </span>
                  {expanded && (
                    <>
                      <span style={{ flex: 1 }}>{label}</span>
                      {countKey && countFor(countKey) > 0 && (
                        <span style={{ ...s.count, ...(isActive ? s.countActive : {}), ...(alert ? s.countAlert : {}) }}>{countFor(countKey)}</span>
                      )}
                    </>
                  )}
                </>
              )}
            </NavLink>
          ))}

          {expanded && <p style={s.navLabel}>Operations</p>}
          {OPERATIONS_LINKS.filter(visible).map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} title={expanded ? undefined : label}
              className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
              style={({ isActive }) => ({ ...s.navItem, justifyContent: expanded ? 'flex-start' : 'center', ...(isActive ? s.navItemActive : {}) })}>
              {({ isActive }) => (
                <>
                  <Icon size={14} strokeWidth={isActive ? 2.1 : 1.8} style={{ flexShrink: 0 }} />
                  {expanded && <span style={{ flex: 1 }}>{label}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div style={{ ...s.sidebarFoot, justifyContent: expanded ? 'flex-start' : 'center', padding: expanded ? '9px 12px' : '9px 0' }}>
          {/* Reference user card: avatar with an online dot, name over a
              secondary line, and a control on the right. Two deliberate
              departures from the reference, both to avoid showing something
              untrue: the secondary line is the staff ROLE, not an email (this
              app stores no staff email), and the right-hand control stays an
              explicit sign-out button rather than the reference's ⋮ menu,
              since sign-out is the only action behind it. */}
          <div style={s.avatarWrap}>
            <div style={s.avatar}>{(staff?.name || '?').slice(0, 2).toUpperCase()}</div>
            <span style={s.avatarStatus} />
          </div>
          {expanded && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={s.userName}>{staff?.name || 'Unknown'}</div>
                <div style={s.userRole}>{ROLE_LABELS[staff?.role] || staff?.role}</div>
              </div>
              {canPairPhone && (
                <button style={s.logoutBtn} onClick={() => setConnectOpen(true)} title="Connect my phone (QR sign-in for Call Tracker)">
                  <Smartphone size={13} />
                </button>
              )}
              <button style={s.logoutBtn} onClick={logout} title="Sign out">
                <LogOut size={13} />
              </button>
            </>
          )}
        </div>
      </aside>
      {connectOpen && <ConnectPhoneModal onClose={() => setConnectOpen(false)} />}
    </div>
  );
}

// Restyled to the reference design: a lighter, denser rail — smaller type,
// tighter rows, hairline dividers and a square-ish brand mark. The hover-drawer
// BEHAVIOUR is unchanged (see COLLAPSED_W / EXPANDED_W); only the paint
// differs. Deliberately not repeating the numbers here — they live on those
// two constants, and a copy in a comment is a copy that goes stale.
const s = {
  // Sized from the shell (height 100%), never 100vh — see App.jsx `main`: a
  // 100vh inside the zoomed wide-screen shell rendered taller than the window
  // and cut the footer off. The drawer is absolute inside this rail (not fixed
  // to the window) for the same reason; it still overlays the page on hover.
  rail: { width: COLLAPSED_W, flexShrink: 0, height: '100%', position: 'relative', zIndex: 100 },
  sidebar: {
    background: theme.surface, borderRight: `1px solid ${theme.border}`,
    display: 'flex', flexDirection: 'column', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 100,
    fontFamily: theme.font, overflow: 'hidden', boxShadow: theme.shadowMd,
    transition: 'width 0.16s ease',
  },
  brand: {
    display: 'flex', alignItems: 'center', gap: 9,
    height: HEADER_H, boxSizing: 'border-box',
    borderBottom: `1px solid ${theme.border}`, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden',
  },
  // Reference brand mark: a 24px rounded square (radius 7), not a circle.
  brandMark: {
    width: 24, height: 24, borderRadius: 7, background: theme.accent,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden',
  },
  brandLogo: { width: '100%', height: '100%', objectFit: 'cover' },
  brandName: { fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em', color: theme.ink, lineHeight: 1.2 },
  brandSub: { fontSize: 10, color: theme.inkFaint, marginTop: 2 },

  // Reference spacing: 1px gaps, 5px/7px row padding and 11px labels — a
  // noticeably tighter rail than the 7px/12.5px it replaced.
  nav: { flex: 1, padding: '6px 8px 0', display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto', overflowX: 'hidden' },
  navLabel: {
    fontSize: 8, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase',
    letterSpacing: '0.07em', padding: '9px 4px 5px', margin: 0, whiteSpace: 'nowrap',
  },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px', borderRadius: 6,
    color: theme.inkSoft, fontSize: 11, fontWeight: 400, textDecoration: 'none',
    transition: 'background 0.12s', whiteSpace: 'nowrap', overflow: 'hidden',
  },
  navItemActive: { background: theme.accentSoft, color: theme.accentInk, fontWeight: 500 },
  count: {
    fontSize: 9.5, color: theme.inkFaint, fontWeight: 500,
    background: theme.borderSoft, padding: '1px 5px', borderRadius: 10,
  },
  countActive: { background: '#fff', color: theme.accentInk },
  countAlert: { background: theme.high, color: '#fff' },
  iconWrap: { position: 'relative', display: 'flex', flexShrink: 0 },
  alertDot: {
    position: 'absolute', top: -2, right: -3, width: 6, height: 6, borderRadius: '50%',
    background: theme.high, border: `1px solid ${theme.surface}`, boxSizing: 'content-box',
  },

  sidebarFoot: {
    borderTop: `1px solid ${theme.borderSoft}`,
    display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden',
  },
  avatarWrap: { position: 'relative', flexShrink: 0, display: 'flex' },
  avatar: {
    width: 24, height: 24, borderRadius: '50%', background: theme.accentSoft, color: theme.accentInk,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 10, flexShrink: 0,
  },
  // The reference's online dot: a green pip notched into the avatar's corner,
  // ringed in the surface colour so it reads as sitting on top of it.
  //
  // Sits INSIDE the avatar's box (right/bottom: 0), not overhanging it at -1.
  //
  // It used to hang 1px past the avatar on both axes, and TWO ancestors clip:
  // sidebarFoot is `overflow: hidden` (to stop nav labels spilling while the
  // drawer animates) and .sidebar is full-height with `overflow: hidden`.
  // The footer is the last child, so on a short viewport — where the nav fills
  // the column and pushes the footer flush against the bottom boundary — that
  // 1px of overhang falls outside the box and is cut off. Hence "some screen
  // sizes": it tracks viewport HEIGHT, not width.
  //
  // Tucking the pip inside costs nothing visually — it is still notched into
  // the avatar's corner, drawn over the avatar's own circle — and no ancestor
  // overflow can reach it at any size.
  avatarStatus: {
    position: 'absolute', right: 0, bottom: 0, width: 7, height: 7, borderRadius: '50%',
    background: '#3FBE5A', border: `1.5px solid ${theme.surface}`,
    // The ring is drawn outside the 7px box by default, which would put it
    // back over the edge; box-sizing keeps the whole pip within its bounds.
    boxSizing: 'border-box',
  },
  userName: { fontSize: 12, fontWeight: 600, color: theme.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  userRole: { fontSize: 10, color: theme.inkFaint },
  logoutBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 25, height: 25,
    borderRadius: 6, border: `1px solid ${theme.border}`, background: 'none', color: theme.inkSoft, cursor: 'pointer', flexShrink: 0,
  },
};
