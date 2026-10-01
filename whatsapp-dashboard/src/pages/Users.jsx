import { useEffect, useState } from 'react';
import { UserPlus, X, KeyRound, Ban, CheckCircle2, LockOpen, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import PageHeader from '../components/PageHeader';
import { ROLES, ROLE_LABELS, ROLE_BADGE } from '../lib/roles';
import { useErrorPopup, useDialog } from '../components/DialogProvider';
import DeleteUserModal from '../components/DeleteUserModal';
import { useAuth } from '../lib/AuthContext';

// Roles now come from lib/roles.js, shared with the Sidebar and App so the
// three copies cannot drift (they already had, before migration 045).

// When a person's sign-in block ends: the later of the code limit and the
// account lock (GET /api/staff signin_block), as "2:45 PM".
function blockEnds(block) {
  const times = [block?.codeLimitUntil, block?.lockedUntil].filter(Boolean).map((t) => new Date(t).getTime());
  return times.length ? new Date(Math.max(...times)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
function blockReason(block) {
  if (block?.lockedUntil && block?.codeLimitUntil) return 'locked after wrong passwords, and too many phone sign-in codes';
  if (block?.lockedUntil) return 'locked after 5 wrong passwords (can\'t log in or make a phone code)';
  return 'too many phone sign-in codes in 15 minutes';
}


export default function Users() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState(null);
  const [deleteFor, setDeleteFor] = useState(null);
  const dialog = useDialog();
  const { staff: me } = useAuth();

  // The same rules the server enforces (staffChangeRefusal): only a super
  // admin touches a super admin account or grants that role, and nobody
  // changes their own role, disables or deletes themselves.
  const iAmSuper = me?.role === 'super_admin';
  const canManage = (u) => u.role !== 'super_admin' || iAmSuper;
  const isMe = (u) => u.id === me?.id;
  const canDelete = (u) => !isMe(u) && canManage(u);
  const roleChoices = ROLES.filter(r => r !== 'super_admin' || iAmSuper);

  function deleted(u, result) {
    setDeleteFor(null);
    setStaff(prev => prev.filter(x => x.id !== u.id));
    const to = result.reassignedTo === 'auto' ? 'shared among the sales agents' : result.reassignedTo ? `given to ${result.reassignedTo.name}` : null;
    dialog.alert({
      title: `${u.name} was deleted`,
      message: result.openLeadsReassigned > 0
        ? `Their ${result.openLeadsReassigned} open lead${result.openLeadsReassigned === 1 ? ' was' : 's were'} ${to}.`
        : 'They have been signed out everywhere.',
      tone: 'success',
      autoCloseMs: 4000,
    });
  }

  // The immediate fix for "Too many sign-in codes" / a locked account: clears
  // both at once (POST /api/staff/:id/clear-signin-block). Password, phones
  // and sessions are untouched.
  async function clearBlock(u) {
    const ok = await dialog.confirm({
      title: `Clear ${u.name}'s sign-in block?`,
      message: `${u.name} is blocked: ${blockReason(u.signin_block)}. It would clear by itself at ${blockEnds(u.signin_block)}. `
        + 'Clearing it lets them log in and make a new phone sign-in code straight away. Their password and phones stay as they are.',
      confirmLabel: 'Clear block',
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/staff/${u.id}/clear-signin-block`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not clear the block');
      setStaff(prev => prev.map(x => (x.id === u.id ? { ...x, signin_block: null } : x)));
      dialog.alert({ title: `${u.name} can sign in again`, message: 'They can make a new phone sign-in code now.', tone: 'success', autoCloseMs: 3500 });
    } catch (err) {
      dialog.alert({ title: 'Could not clear the block', message: err.message });
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/staff');
      const data = await res.json();
      setStaff(data.staff || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = staff.filter(u => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return u.name?.toLowerCase().includes(q) || u.phone?.toLowerCase().includes(q);
  });

  async function patchStaff(id, patch) {
    try {
      const res = await apiFetch(`/api/staff/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const data = await res.json().catch(() => ({}));
      if (data.success) setStaff(prev => prev.map(u => u.id === id ? { ...u, ...data.staff } : u));
      else dialog.alert({ title: 'Could not change this account', message: data.error || 'The change was refused.' });
      return data;
    } catch (err) {
      dialog.alert({ title: 'Could not change this account', message: err.message });
      return {};
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader
        title="User Management"
        search={search} onSearch={setSearch} searchPlaceholder="Search name or phone..."
        action="Add user" onAction={() => setAddOpen(true)}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>{['Name', 'Phone', 'Role', 'Status', 'Joined', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td style={s.td} colSpan={6}>No staff users found.</td></tr>
                ) : filtered.map(u => {
                  const badge = ROLE_BADGE[u.role] || ROLE_BADGE.viewer;
                  return (
                    <tr key={u.id}>
                      <td style={{ ...s.td, fontWeight: 600 }}>{u.name}</td>
                      <td style={{ ...s.td, fontFamily: theme.mono }}>{u.phone}</td>
                      <td style={s.td}>
                        <select
                          style={{ ...s.roleSelect, color: badge.color, background: badge.bg, cursor: canManage(u) && !isMe(u) ? 'pointer' : 'default' }}
                          value={u.role}
                          disabled={!canManage(u) || isMe(u)}
                          title={isMe(u) ? "You can't change your own role" : !canManage(u) ? 'Only a super admin can change a super admin' : undefined}
                          onChange={e => patchStaff(u.id, { role: e.target.value })}
                        >
                          {(roleChoices.includes(u.role) ? roleChoices : [u.role, ...roleChoices]).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                      </td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, color: u.active ? theme.success : theme.cancel, background: u.active ? theme.successBg : theme.cancelBg }}>
                          {u.active ? 'Active' : 'Disabled'}
                        </span>
                        {u.signin_block && (
                          <span
                            style={{ ...s.pill, color: theme.med, background: theme.medBg, marginLeft: 6 }}
                            title={`Blocked: ${blockReason(u.signin_block)}`}
                          >
                            Sign-in blocked until {blockEnds(u.signin_block)}
                          </span>
                        )}
                      </td>
                      <td style={{ ...s.td, color: theme.inkFaint, fontSize: 12.5 }}>
                        {new Date(u.created_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td style={s.td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {canManage(u) && (
                            <button style={s.iconBtn} onClick={() => setPasswordFor(u)} title="Reset password">
                              <KeyRound size={13} />
                            </button>
                          )}
                          {u.signin_block && canManage(u) && (
                            <button
                              style={{ ...s.iconBtn, color: theme.med, borderColor: theme.med }}
                              onClick={() => clearBlock(u)}
                              title="Clear sign-in block — lets them log in and make a phone sign-in code now"
                            >
                              <LockOpen size={13} />
                            </button>
                          )}
                          {canManage(u) && !isMe(u) && (
                            <button
                              style={{ ...s.iconBtn, color: u.active ? theme.high : theme.success }}
                              onClick={() => patchStaff(u.id, { active: !u.active })}
                              title={u.active ? 'Disable this user' : 'Re-enable this user'}
                            >
                              {u.active ? <Ban size={13} /> : <CheckCircle2 size={13} />}
                            </button>
                          )}
                          {canDelete(u) && (
                            <button
                              style={{ ...s.iconBtn, color: theme.high }}
                              onClick={() => setDeleteFor(u)}
                              title="Delete this account permanently"
                              aria-label={`Delete ${u.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addOpen && (
        <AddUserModal
          roles={roleChoices}
          onClose={() => setAddOpen(false)}
          onCreated={u => { setStaff(prev => [u, ...prev]); setAddOpen(false); }}
        />
      )}

      {deleteFor && (
        <DeleteUserModal
          user={deleteFor}
          staff={staff}
          onClose={() => setDeleteFor(null)}
          onDeleted={result => deleted(deleteFor, result)}
        />
      )}

      {passwordFor && (
        <ResetPasswordModal
          staffUser={passwordFor}
          onClose={() => setPasswordFor(null)}
        />
      )}
    </div>
  );
}

function AddUserModal({ roles, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('sales_agent');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not create the user');

  async function save() {
    if (!name.trim() || !phone.trim() || password.length < 6) return;
    setSaving(true); setError(null);
    try {
      const res = await apiFetch('/api/staff', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), password, role }),
      });
      const data = await res.json();
      if (data.success) onCreated(data.staff);
      else setError(data.error || 'Failed to create user');
    } catch (e) { setError('Network error: ' + e.message); }
    setSaving(false);
  }

  const canSave = name.trim() && phone.trim() && password.length >= 6;

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div style={s.modalHeaderLeft}>
            <div style={s.modalIcon}><UserPlus size={16} color={theme.accentInk} /></div>
            <p style={s.modalTitle}>Add user</p>
          </div>
          <button style={s.closeBtn} onClick={onClose} disabled={saving}><X size={15} /></button>
        </div>
        <div style={s.modalBody}>
          <label style={s.fieldLabel}>Name</label>
          <input style={s.input} name="new-staff-name" autoComplete="off" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" autoFocus />

          <label style={s.fieldLabel}>Phone</label>
          <input style={s.input} name="new-staff-phone" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="94771234567" />

          <label style={s.fieldLabel}>Password</label>
          <input style={s.input} type="password" name="new-password" autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" />

          <label style={s.fieldLabel}>Role</label>
          <select style={s.select} value={role} onChange={e => setRole(e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>

        </div>
        <div style={s.modalFooter}>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={{ ...s.saveBtn, opacity: canSave ? 1 : 0.5 }} onClick={save} disabled={saving || !canSave}>
            {saving ? 'Creating...' : 'Create user'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordModal({ staffUser, onClose }) {
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not reset the password');
  const [done, setDone] = useState(false);

  async function save() {
    if (password.length < 6) return;
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`/api/staff/${staffUser.id}/password`, {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.success) setDone(true);
      else setError(data.error || 'Failed to reset password');
    } catch (e) { setError('Network error: ' + e.message); }
    setSaving(false);
  }

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div style={s.modalHeaderLeft}>
            <div style={s.modalIcon}><KeyRound size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.modalTitle}>Reset password</p>
              <p style={s.modalSub}>{staffUser.name} · {staffUser.phone}</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} disabled={saving}><X size={15} /></button>
        </div>
        <div style={s.modalBody}>
          {done ? (
            <p style={{ fontSize: 13, color: theme.success, fontWeight: 600 }}>✅ Password updated.</p>
          ) : (
            <>
              <label style={s.fieldLabel}>New password</label>
              <input style={s.input} type="password" name="new-password" autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" autoFocus />
            </>
          )}
        </div>
        <div style={s.modalFooter}>
          {done ? (
            <button style={s.saveBtn} onClick={onClose}>Done</button>
          ) : (
            <>
              <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
              <button style={{ ...s.saveBtn, opacity: password.length >= 6 ? 1 : 0.5 }} onClick={save} disabled={saving || password.length < 6}>
                {saving ? 'Saving...' : 'Reset password'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const s = {
  // Card chrome, but scrolling INSIDE it rather than `overflow: 'hidden'`.
  // Hidden clipped the rounded corners neatly and silently killed the sticky
  // header below (a sticky element needs a scrolling ancestor; hidden is not
  // one), so the header scrolled away on every long list. `auto` keeps the
  // corners and makes the header stick, matching the Pipeline.
  tableWrap: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'auto', maxHeight: '100%' },
  // fontSize/background here rather than relying on inheritance, matching the
  // Pipeline reference (lib/tableStyles.js) so every list reads at the same
  // size. tableLayout is deliberately NOT set: these tables size their columns
  // from content, and forcing 'fixed' would need per-column widths on each.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  pill: { display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 },
  roleSelect: { border: 'none', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', outline: 'none', fontFamily: 'inherit' },
  iconBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer' },

  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: theme.shadowMd, overflow: 'hidden' },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}` },
  modalHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  modalIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  modalSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft },
  modalBody: { padding: '16px 20px' },
  fieldLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  select: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
