import { BACKEND_URL } from './config';

const TOKEN_KEY = 'nidikumba_staff_token';
const STAFF_KEY = 'nidikumba_staff_info';
const AUTH_ERROR_EVENT = 'nidikumba:auth-error';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStaff() {
  const raw = localStorage.getItem(STAFF_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setSession(token, staff) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STAFF_KEY);
}

// Auth-aware fetch — attaches the staff token, and on a 401 (missing/expired
// token) clears the session and notifies AuthContext so the app can redirect
// to /login instead of every caller having to check for it individually.
export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BACKEND_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event(AUTH_ERROR_EVENT));
  }

  return res;
}

export function onAuthError(callback) {
  window.addEventListener(AUTH_ERROR_EVENT, callback);
  return () => window.removeEventListener(AUTH_ERROR_EVENT, callback);
}

export async function login(phone, password) {
  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  setSession(data.token, data.staff);
  return data.staff;
}

export function logout() {
  // Tell the server first so it can close the session row that backs the
  // super_admin "active hours" screen (migration 045). Without this a session
  // has a start and no end, and a signed-out person still reads as online
  // until the 30-minute staleness window closes them off.
  //
  // Deliberately NOT awaited and never allowed to throw: signing out is a
  // local action and must succeed instantly even if the server is unreachable.
  // The worst case is a session closed by the staleness rule instead of
  // exactly — a slightly long last session, not a broken logout. keepalive
  // lets the request survive the page navigation that usually follows.
  try {
    const token = getToken();
    if (token) {
      fetch(`${BACKEND_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // ignore — clearing the local session below is what actually signs out
  }
  clearSession();
}
