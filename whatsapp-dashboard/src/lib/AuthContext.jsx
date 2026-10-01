import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getStaff, getToken, login as apiLogin, logout as apiLogout, onAuthError } from './api';
import { closeSource } from './sse';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [staff, setStaff] = useState(getStaff());

  useEffect(() => onAuthError(() => { closeSource(); setStaff(null); }), []);

  const login = useCallback(async (phone, password) => {
    const s = await apiLogin(phone, password);
    setStaff(s);
    return s;
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    closeSource();
    setStaff(null);
  }, []);

  const isAuthenticated = !!staff && !!getToken();

  return (
    <AuthContext.Provider value={{ staff, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
