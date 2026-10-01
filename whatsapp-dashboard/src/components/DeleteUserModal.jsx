import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { ROLE_LABELS } from '../lib/roles';

// Permanently deletes a staff account (DELETE /api/staff/:id). Shows what the
// delete will touch first (GET /api/staff/:id/delete-preview), asks who takes
// over their open leads, and makes the admin type the person's name — the
// server checks that name too, since this cannot be undone.
//
// `staff` is the full User Management list, used for the "give their leads
// to" choices: active sales agents and admins, never the person being deleted.
export default function DeleteUserModal({ user, staff, onClose, onDeleted }) {
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reassignTo, setReassignTo] = useState('');
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    apiFetch(`/api/staff/${user.id}/delete-preview`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load this account');
        if (live) setPreview(data);
      })
      .catch((err) => live && setLoadError(err.message));
    return () => { live = false; };
  }, [user.id]);

  const takers = staff.filter(
    (u) => u.id !== user.id && u.active && ['sales_agent', 'admin', 'super_admin'].includes(u.role)
  );
  const hasAgents = takers.some((u) => u.role === 'sales_agent');
  const openLeads = preview?.open_leads || 0;
  const nameOk = typed.trim().toLowerCase() === (user.name || '').trim().toLowerCase();
  const canDelete = preview && nameOk && (openLeads === 0 || reassignTo) && !deleting;

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const body = { confirmName: typed.trim() };
      if (openLeads > 0) body.reassignTo = reassignTo;
      const res = await apiFetch(`/api/staff/${user.id}`, { method: 'DELETE', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete the account');
      onDeleted(data);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  return (
    <div style={modalBackdrop} onClick={(e) => e.target === e.currentTarget && !deleting && onClose()}>
      <div style={s.modal} role="dialog" aria-label={`Delete ${user.name}`}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.icon}><Trash2 size={16} color={theme.high} /></div>
            <div>
              <p style={s.title}>Delete {user.name} permanently?</p>
              <p style={s.sub}>{ROLE_LABELS[user.role] || user.role} · {user.phone}</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} disabled={deleting} aria-label="Close"><X size={15} /></button>
        </div>

        <div style={s.body}>
          {loadError ? (
            <p style={s.error}>{loadError}</p>
          ) : !preview ? (
            <p style={s.muted}>Checking this account…</p>
          ) : (
            <>
              <p style={s.warn}>This can’t be undone. The account is removed for good.</p>
              <ul style={s.list}>
                <li>They’re signed out straight away{preview.phones > 0 ? ', including their Call Tracker phone' : ''}, and can’t log in again.</li>
                <li>Their orders, payments, calls and quotations stay. Those records just no longer show who did them.</li>
                {preview.other_leads > 0 && (
                  <li>{preview.other_leads} closed lead{preview.other_leads === 1 ? '' : 's'} will show no owner.</li>
                )}
                <li>The audit log keeps a record of who deleted them and when.</li>
              </ul>

              {openLeads > 0 && (
                <>
                  <label style={s.label} htmlFor="reassign-to">
                    Who takes over their {openLeads} open lead{openLeads === 1 ? '' : 's'}?
                  </label>
                  <select id="reassign-to" style={s.input} value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                    <option value="">Choose…</option>
                    {hasAgents && <option value="auto">Share among sales agents (fewest open leads first)</option>}
                    {takers.map((u) => (
                      <option key={u.id} value={u.id}>{u.name} — {ROLE_LABELS[u.role] || u.role}</option>
                    ))}
                  </select>
                  {takers.length === 0 && (
                    <p style={s.error}>There’s no other active sales agent or admin to give the leads to. Add or re-enable one first.</p>
                  )}
                </>
              )}

              <label style={s.label} htmlFor="confirm-name">Type <b style={{ color: theme.ink, textTransform: 'none' }}>{user.name}</b> to confirm</label>
              <input
                id="confirm-name"
                style={s.input}
                name="confirm-delete-name"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={user.name}
              />
              {error && <p style={s.error}>{error}</p>}
            </>
          )}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} disabled={deleting}>Cancel</button>
          <button style={{ ...s.deleteBtn, opacity: canDelete ? 1 : 0.5 }} onClick={remove} disabled={!canDelete}>
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}` },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 9, background: theme.highBg, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  sub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft },
  body: { padding: '16px 20px' },
  warn: { fontSize: 13, fontWeight: 700, color: theme.high, margin: '0 0 8px' },
  list: { fontSize: 12.5, color: theme.inkSoft, margin: '0 0 4px', paddingLeft: 18, lineHeight: 1.6 },
  muted: { fontSize: 13, color: theme.inkFaint, margin: 0 },
  error: { fontSize: 12.5, color: theme.high, margin: '8px 0 0' },
  label: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6, marginTop: 14 },
  input: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  deleteBtn: { background: theme.high, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
