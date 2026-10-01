import { Search } from 'lucide-react';
import ConversationItem from './ConversationItem';
import { theme } from '../lib/theme';

const FILTERS = [
  { key: 'all', label: 'All'    },
  { key: '3',   label: '🔴 Urgent' },
  { key: '2',   label: '🟡 Medium' },
  { key: '1',   label: '🟢 Low'    },
];

export default function Sidebar({
  conversations, selectedId, search, onSearch,
  priorityFilter, onPriorityFilter, onSelect, loading,
}) {
  const filtered = conversations.filter(conv => {
    const score = String(conv.customer.priority_score || 1);
    if (priorityFilter !== 'all' && score !== priorityFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      conv.customer.whatsapp_number.toLowerCase().includes(q) ||
      (conv.customer.name || '').toLowerCase().includes(q)
    );
  });

  return (
    <div style={s.sidebar}>
      <div style={s.header}>
        <span style={s.title}>Conversations</span>
        <span style={s.badge}>{conversations.length}</span>
      </div>

      <div style={s.searchWrap}>
        <Search size={14} color={theme.inkFaint} style={{ position: 'absolute', left: 24, top: '50%', transform: 'translateY(-50%)' }} />
        {/* autoComplete off: the browser would otherwise fill a phone number
            typed into an order form into this box. */}
        <input
          style={s.search}
          type="search"
          name="chats-filter"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search name or number…"
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
      </div>

      <div style={s.filters}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            style={{ ...s.filterBtn, ...(priorityFilter === f.key ? s.filterActive : {}) }}
            onClick={() => onPriorityFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={s.meta}>
        <span style={s.metaText}>{filtered.length} conversation{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      <div style={s.list}>
        {loading && <p style={s.hint}>Loading…</p>}
        {!loading && filtered.length === 0 && <p style={s.hint}>No conversations</p>}
        {filtered.map(conv => (
          <ConversationItem
            key={conv.customer.id}
            conv={conv}
            isSelected={selectedId === conv.customer.id}
            onClick={() => onSelect(conv.customer.id)}
          />
        ))}
      </div>
    </div>
  );
}

const s = {
  sidebar: {
    width: 340, minWidth: 280,
    borderRight: `1px solid ${theme.border}`,
    display: 'flex', flexDirection: 'column',
    background: theme.surface,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: `1px solid ${theme.borderSoft}`,
  },
  title: { fontSize: 15, fontWeight: 700, color: theme.ink },
  badge: {
    background: theme.accentSoft, color: theme.accentInk,
    fontSize: 11, fontWeight: 700,
    padding: '2px 8px', borderRadius: 10,
  },
  searchWrap: { padding: '12px 16px', position: 'relative' },
  search: {
    width: '100%', padding: '8px 12px 8px 34px',
    borderRadius: 8, border: `1.5px solid ${theme.border}`,
    background: theme.bg, color: theme.ink,
    fontSize: 13, boxSizing: 'border-box', transition: 'border-color 0.15s', fontFamily: 'inherit',
  },
  filters: { display: 'flex', gap: 4, padding: '0 16px 10px', flexWrap: 'wrap' },
  filterBtn: {
    padding: '4px 10px', borderRadius: 6,
    border: `1.5px solid ${theme.border}`,
    background: theme.surface, color: theme.inkSoft,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
    transition: 'all 0.12s', fontFamily: 'inherit',
  },
  filterActive: {
    background: theme.accentSoft, color: theme.accentInk,
    borderColor: theme.accent,
  },
  meta: { padding: '0 20px 8px' },
  metaText: { fontSize: 11, color: theme.inkFaint, fontWeight: 500 },
  list: { flex: 1, overflowY: 'auto' },
  hint: { color: theme.inkFaint, textAlign: 'center', padding: '40px 20px', fontSize: 13 },
};
