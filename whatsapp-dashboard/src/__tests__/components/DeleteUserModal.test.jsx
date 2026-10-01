import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('../../lib/api', () => ({ apiFetch: (...a) => apiFetch(...a) }));

import DeleteUserModal from '../../components/DeleteUserModal';

const KASUN = { id: 'k', name: 'Kasun Perera', role: 'sales_agent', phone: '94771234567', active: true };
const STAFF = [
  KASUN,
  { id: 'n', name: 'Nimal', role: 'sales_agent', active: true },
  { id: 'a', name: 'Anura', role: 'admin', active: true },
  { id: 'v', name: 'Vishaka', role: 'viewer', active: true },
  { id: 'd', name: 'Dinesh', role: 'sales_agent', active: false },
];
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function open(preview, props = {}) {
  apiFetch.mockResolvedValueOnce(json({ staff: KASUN, other_leads: 0, phones: 0, ...preview }));
  await act(async () => {
    render(<DeleteUserModal user={KASUN} staff={STAFF} onClose={() => {}} onDeleted={() => {}} {...props} />);
  });
}
const deleteBtn = () => screen.getByRole('button', { name: 'Delete permanently' });
const typeName = (v) => fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: v } });

beforeEach(() => apiFetch.mockReset());

describe('DeleteUserModal', () => {
  it('only deletes once the name is typed', async () => {
    await open({ open_leads: 0 });
    expect(deleteBtn()).toBeDisabled();
    typeName('Kasun');
    expect(deleteBtn()).toBeDisabled();
    typeName(' kasun perera ');
    expect(deleteBtn()).toBeEnabled();
    expect(screen.queryByLabelText(/open lead/)).toBeNull();
  });

  it('with open leads, asks who takes them — active agents and admins only, never the person', async () => {
    await open({ open_leads: 3 });
    const select = screen.getByLabelText(/takes over their 3 open leads/i);
    const options = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['', 'auto', 'n', 'a']);
    typeName('Kasun Perera');
    expect(deleteBtn()).toBeDisabled();
    fireEvent.change(select, { target: { value: 'n' } });
    expect(deleteBtn()).toBeEnabled();
  });

  it('sends the chosen owner and the typed name, and reports the result', async () => {
    const onDeleted = vi.fn();
    await open({ open_leads: 2 }, { onDeleted });
    fireEvent.change(screen.getByLabelText(/open leads/i), { target: { value: 'auto' } });
    typeName('Kasun Perera');
    const result = { success: true, openLeadsReassigned: 2, reassignedTo: 'auto' };
    apiFetch.mockResolvedValueOnce(json(result));
    await act(async () => { fireEvent.click(deleteBtn()); });
    const [url, opts] = apiFetch.mock.calls[1];
    expect(url).toBe('/api/staff/k');
    expect(opts.method).toBe('DELETE');
    expect(JSON.parse(opts.body)).toEqual({ confirmName: 'Kasun Perera', reassignTo: 'auto' });
    expect(onDeleted).toHaveBeenCalledWith(result);
  });

  it("shows the server's reason when it refuses", async () => {
    const onDeleted = vi.fn();
    await open({ open_leads: 0 }, { onDeleted });
    typeName('Kasun Perera');
    apiFetch.mockResolvedValueOnce(json({ error: 'Kasun Perera is the last active admin — make someone else an admin first' }, 409));
    await act(async () => { fireEvent.click(deleteBtn()); });
    expect(screen.getByText(/last active admin/)).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(deleteBtn()).toBeEnabled();
  });

  it('says what goes and what stays', async () => {
    await open({ open_leads: 0, other_leads: 4, phones: 1 });
    expect(screen.getByText(/can’t be undone/)).toBeTruthy();
    expect(screen.getByText(/including their Call Tracker phone/)).toBeTruthy();
    expect(screen.getByText(/4 closed leads will show no owner/)).toBeTruthy();
  });
});
