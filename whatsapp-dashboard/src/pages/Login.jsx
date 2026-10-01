import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { User, Lock, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { useErrorPopup } from '../components/DialogProvider';

const LOGO_URL = 'https://res.cloudinary.com/ciqslzrw/image/upload/v1787141453/magnific_make-a-cartoonize-version_mEQy2OxhJQ.jpg_ymmudd.jpg';
const NAME_LOGO_URL = 'https://res.cloudinary.com/ciqslzrw/image/upload/v1784796619/logo_tewc3j.png';

export default function Login() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  useErrorPopup(error, 'Could not sign in');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(phone.trim(), password);
      navigate(location.state?.from || '/leads', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.inner}>
        <div style={s.leftPanel}>
          <div style={s.brandRow}>
            <img src={LOGO_URL} alt="Nidikumba" style={s.brandLogo} />
            <img src={NAME_LOGO_URL} alt="Nidikumba" style={s.brandNameLogo} />
          </div>
          <h2 style={s.brandCrmTitle}>Nidikumba CRM</h2>
          <p style={s.heroSubtitle}>WhatsApp-powered sales, orders, and customer platform for the Nidikumba team.</p>
        </div>

        <div style={s.rightPanel}>
          <form style={s.form} onSubmit={handleSubmit}>
            <h1 style={s.title}>Sign In</h1>
            <div style={s.divider} />


            <label style={s.label}><span style={s.required}>*</span> Phone</label>
            <div style={s.inputWrap}>
              <User size={16} color="#9ca3af" style={s.inputIcon} />
              <input
                style={s.input}
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Phone Number"
                // Labelled as the username so the password manager saves the
                // RIGHT pair here — unlabelled, Chrome guessed and later filled
                // the saved login into search boxes and password-reset fields.
                name="username"
                autoComplete="username"
                inputMode="tel"
                autoFocus
              />
            </div>

            <label style={s.label}><span style={s.required}>*</span> Password</label>
            <div style={s.inputWrap}>
              <Lock size={16} color="#9ca3af" style={s.inputIcon} />
              <input
                style={{ ...s.input, paddingRight: 36 }}
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button type="button" style={s.eyeBtn} onClick={() => setShowPassword(v => !v)} tabIndex={-1}>
                {showPassword ? <EyeOff size={16} color="#9ca3af" /> : <Eye size={16} color="#9ca3af" />}
              </button>
            </div>

            <div style={s.row}>
              <label style={s.rememberLabel}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={s.checkbox} />
                Remember Me
              </label>
            </div>

            <button style={s.button} type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Log In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100vh', background: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  inner: {
    display: 'flex', alignItems: 'center', width: '100%', maxWidth: 760,
  },
  leftPanel: {
    flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '0 24px', minWidth: 0,
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 40 },
  brandLogo: { width: 46, height: 46, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 },
  brandNameLogo: { height: 28, width: 'auto', objectFit: 'contain' },
  brandCrmTitle: { fontSize: 22, fontWeight: 700, color: '#111827', letterSpacing: '-0.01em', margin: '0 0 10px' },
  heroSubtitle: { fontSize: 14.5, color: '#6b7280', lineHeight: 1.6, margin: 0, maxWidth: 320 },

  rightPanel: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 0,
  },
  form: { width: '100%', maxWidth: 320, padding: '0 24px' },
  title: { margin: 0, fontSize: 30, fontWeight: 700, color: '#111827', letterSpacing: '-0.02em' },
  divider: { height: 1, background: '#e5e7eb', margin: '18px 0 20px' },
  error: { background: '#fef2f2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12 },
  label: { fontSize: 13.5, fontWeight: 600, marginTop: 14, color: '#1f2937', marginBottom: 6 },
  required: { color: '#dc2626' },
  inputWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  inputIcon: { position: 'absolute', left: 12, pointerEvents: 'none' },
  input: {
    width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #d1d5db', borderRadius: 8,
    fontSize: 14, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111827',
  },
  eyeBtn: {
    position: 'absolute', right: 10, background: 'none', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', padding: 2,
  },
  row: { display: 'flex', alignItems: 'center', marginTop: 16 },
  rememberLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, color: '#374151', cursor: 'pointer' },
  checkbox: { width: 15, height: 15, accentColor: '#0d9488', cursor: 'pointer' },
  button: {
    marginTop: 22, width: '100%', padding: '11px 0', background: '#0d9488', color: '#fff',
    border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14.5, cursor: 'pointer', letterSpacing: '0.01em',
  },
};
