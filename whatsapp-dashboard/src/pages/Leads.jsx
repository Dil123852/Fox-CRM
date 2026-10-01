import LeadsPage from '../components/LeadsPage';

// Pipeline is the modern table view (LeadsPage.jsx) — the kanban/card board
// was removed per user feedback (not user-friendly; wanted a table, not
// cards). Everything the board showed (source badge, assignee, SLA badge,
// the auto-assign toggle) was carried into the table instead of being lost.
export default function Leads() {
  return <LeadsPage />;
}
