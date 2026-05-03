// ── Auth Module ───────────────────────────────────────────────
const SESSION_KEY = 'rbn_session';
const BRANCH_KEY  = 'rbn_branch';

const auth = {
  // ── Session helpers ──────────────────────────────────────
  // BUG 5D FIX: getSession() now validates expiry before returning session
  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (!s) return null;
      // Check if session has expired (expires_at is stored as ISO string)
      if (s.expires_at && new Date(s.expires_at) < new Date()) {
        this.clearSession();
        return null;
      }
      return s;
    } catch { return null; }
  },

  setSession(user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  },

  clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(BRANCH_KEY);
  },

  getActiveBranch() {
    try { return JSON.parse(localStorage.getItem(BRANCH_KEY)); }
    catch { return null; }
  },

  setActiveBranch(branch) {
    localStorage.setItem(BRANCH_KEY, JSON.stringify(branch));
  },

  // ── Login via RPC (SECURITY DEFINER — tidak butuh GRANT tabel) ──
  async login(name, password) {
    let data, error;

    try {
      // pos_login berjalan sebagai postgres owner — anon tidak perlu GRANT langsung ke tabel users
      const res = await db.rpc('pos_login', {
        p_name:     name.trim(),
        p_password: password
      });
      data  = res.data;
      error = res.error;
    } catch (networkErr) {
      console.error('[RBN] Network error:', networkErr);
      throw new Error('Tidak bisa terhubung ke server. Periksa koneksi internet.');
    }

    if (error) {
      console.error('[RBN] RPC error:', error);
      const msg  = (error.message || '').toLowerCase();
      const code = String(error.code || '');

      if (code === '42883' || msg.includes('does not exist') || msg.includes('function'))
        throw new Error('Fungsi login belum ada. Jalankan fix_login.sql di Supabase SQL Editor.');
      if (code === '42501' || msg.includes('permission denied'))
        throw new Error('Permission ditolak. Jalankan fix_login.sql di Supabase SQL Editor.');

      throw new Error('Error [' + (code || '?') + ']: ' + (error.message || JSON.stringify(error)));
    }

    if (!data) throw new Error('Username atau password salah.');

    const user = typeof data === 'string' ? JSON.parse(data) : data;

    // BUG 5D FIX: attach expires_at = now + 8 hours to the session object
    user.expires_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    this.setSession(user);
    return user;
  },

  // ── Logout ───────────────────────────────────────────────
  logout() {
    this.clearSession();
    window.location.href = 'index.html';
  },

  // ── Guards ───────────────────────────────────────────────
  requireAuth() {
    const s = this.getSession();
    if (!s) { window.location.href = 'index.html'; return null; }
    return s;
  },

  requireRole(role) {
    const s = this.requireAuth();
    if (!s) return null;
    if (s.role !== role) {
      window.location.href = s.role === 'admin' ? 'admin.html' : 'pos.html';
      return null;
    }
    return s;
  },

  async validateCurrentUser() {
    const local = this.getSession();
    if (!local) return null;
    try {
      const { data, error } = await db.rpc('get_current_user');
      if (error) throw error;
      if (!data) throw new Error('Session tidak valid');
      return local;
    } catch (err) {
      console.error('[AUTH] validateCurrentUser failed:', err);
      this.clearSession();
      window.location.href = 'index.html';
      return null;
    }
  }
};
