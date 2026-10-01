import { theme } from './theme';

// The staff roles, in one place.
//
// WHY THIS FILE EXISTS: adding the seventh role (super_admin, migration 045)
// found the list duplicated in FOUR places that had to agree — the backend's
// STAFF_ROLES, Users.jsx's ROLES + ROLE_LABELS + ROLE_BADGE, and Sidebar.jsx's
// own ROLE_LABELS. Three of those are in this app, and a role missing from any
// one of them fails quietly rather than loudly: an absent ROLE_BADGE entry
// silently renders in viewer's grey, and an absent ROLE_LABELS entry shows the
// raw `super_admin` string to the user.
//
// The backend keeps its own copy (it cannot import from here), but these three
// are now one.

export const SUPER_ADMIN = 'super_admin';

// Order matters: this drives the order of the role dropdown on the User
// Management screen, most-privileged first.
export const ROLES = [
  SUPER_ADMIN,
  'admin',
  'sales_agent',
  'inventory_manager',
  'delivery_coordinator',
  'finance',
  'viewer',
];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  sales_agent: 'Sales Agent',
  inventory_manager: 'Inventory Manager',
  delivery_coordinator: 'Delivery Coordinator',
  finance: 'Finance',
  viewer: 'Viewer',
};

export const ROLE_BADGE = {
  // Deliberately the strongest colour in the palette: super_admin can reach
  // every screen and is the only role that can restore a deleted record, so it
  // should not be mistakable at a glance for an ordinary admin.
  super_admin:           { color: '#fff',           bg: theme.accent },
  admin:                 { color: theme.accentInk,  bg: theme.accentSoft },
  sales_agent:           { color: theme.success,    bg: theme.successBg },
  inventory_manager:     { color: theme.info,       bg: theme.infoBg },
  delivery_coordinator:  { color: theme.med,        bg: theme.medBg },
  finance:               { color: theme.high,       bg: theme.highBg },
  viewer:                { color: theme.cancel,     bg: theme.cancelBg },
};

// A super admin satisfies every role gate in the app, matching the identical
// short-circuit in the backend's requireRole(). Used by ProtectedRoute and the
// sidebar so the three layers cannot disagree about what this role can see.
export const isSuperAdmin = role => role === SUPER_ADMIN;

// One helper for "may this role see this thing", so a page never re-implements
// the super-admin case and accidentally omits it.
export const roleAllowed = (role, allowed) => isSuperAdmin(role) || !allowed || allowed.includes(role);

// Roles that see every agent's calls, callbacks and orders and may filter by
// agent (migration 058). Mirrors CALL_VISIBILITY_ROLES_UNRESTRICTED in the
// backend, which is what actually enforces it — everyone else only ever
// receives their own rows, whatever the page sends.
export const SEES_ALL_AGENTS = [SUPER_ADMIN, 'admin', 'viewer'];
export const seesAllAgents = role => SEES_ALL_AGENTS.includes(role);
