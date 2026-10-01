import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { seesAllAgents } from '../lib/roles';
import { tb } from '../lib/toolbarStyles';

// "Which agent?" dropdown for the Calls, Callbacks and Orders pages (058).
//
// Value: 'all' | a staff id | 'none' (rows with no recorded agent — calls
// synced before 051, orders placed before 058). Renders nothing for a role
// that only sees its own rows: the server already scopes those, so there is
// nothing to choose.

// One roster request per page load, shared by every dropdown. A failed load is
// not cached, so the next page tries again.
let rosterPromise = null;
function loadRoster() {
  if (!rosterPromise) {
    rosterPromise = apiFetch('/api/staff/roster')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => data.staff || [])
      .catch(err => {
        rosterPromise = null;
        throw err;
      });
  }
  return rosterPromise;
}

export function useStaffRoster() {
  const { staff } = useAuth();
  const enabled = seesAllAgents(staff?.role);
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    loadRoster()
      .then(list => { if (alive) setRoster(list); })
      .catch(err => console.warn('Could not load the staff list:', err.message));
    return () => { alive = false; };
  }, [enabled]);
  return roster;
}

// Human label for a filter value, for export headers and the like.
export function staffFilterLabel(value, roster, noneLabel = 'Not recorded') {
  if (!value || value === 'all') return 'All agents';
  if (value === 'none') return noneLabel;
  return roster.find(s => s.id === value)?.name || 'Selected agent';
}

export default function StaffFilter({ value, onChange, label = 'Agent', noneLabel = 'Not recorded' }) {
  const { staff } = useAuth();
  const roster = useStaffRoster();
  if (!seesAllAgents(staff?.role)) return null;

  const active = roster.filter(s => s.active);
  const inactive = roster.filter(s => !s.active);
  return (
    <div style={tb.group}>
      <label style={tb.label}>{label}</label>
      <select style={tb.select} value={value} onChange={e => onChange(e.target.value)}>
        <option value="all">All agents</option>
        {active.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
        {inactive.length > 0 && (
          <optgroup label="Disabled accounts">
            {inactive.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </optgroup>
        )}
        <option value="none">{noneLabel}</option>
      </select>
    </div>
  );
}
