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

  _isMissingRpcError(error) {
    const msg  = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '');
    return code === '42883'
      || code === 'PGRST202'
      || msg.includes('could not find the function')
      || (msg.includes('function') && msg.includes('does not exist'));
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
        throw new Error('Terjadi kesalahan server. Hubungi admin.');
      if (code === '42501' || msg.includes('permission denied'))
        throw new Error('Akses ditolak. Hubungi admin.');

      throw new Error(error.message || 'Terjadi kesalahan. Coba lagi atau hubungi admin.');
    }

    if (!data) throw new Error('Username atau password salah.');

    const user = typeof data === 'string' ? JSON.parse(data) : data;

    // Newer databases return expires_at and session_token from pos_login.
    // Keep the local expiry fallback for older deployments.
    if (!user.expires_at) {
      user.expires_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    }

    this.setSession(user);
    return user;
  },

  // ── Logout ───────────────────────────────────────────────
  logout() {
    this.clearSession();
    window.location.href = 'index.html';
  },

  // ── Guards ───────────────────────────────────────────────
  getDefaultPageByRole(role) {
    if (role === 'admin')    return 'admin.html';
    if (role === 'owner')    return 'admin.html';
    if (role === 'staff')    return 'pos.html';
    if (role === 'investor') return 'investor.html';
    return 'index.html';
  },

  requireAuth() {
    const s = this.getSession();
    if (!s) { window.location.href = 'index.html'; return null; }
    return s;
  },

  requireRole(role) {
    const s = this.requireAuth();
    if (!s) return null;
    if (s.role !== role) {
      window.location.href = this.getDefaultPageByRole(s.role);
      return null;
    }
    return s;
  },

  requireAnyRole(roles = []) {
    const s = this.requireAuth();
    if (!s) return null;
    if (!roles.includes(s.role)) {
      window.location.href = this.getDefaultPageByRole(s.role);
      return null;
    }
    return s;
  },

  async validateCurrentUser(allowedRoles = null) {
    const local = this.getSession();
    if (!local) return null;

    if (local.session_token) {
      try {
        const { data, error } = await db.rpc('rbn_validate_session', {
          p_session_token: local.session_token
        });

        if (error) {
          if (!this._isMissingRpcError(error)) throw error;
        } else {
          if (!data) throw new Error('Session tidak valid atau sudah kedaluwarsa');
          const serverUser = typeof data === 'string' ? JSON.parse(data) : data;

          const refreshed = {
            ...local,
            ...serverUser,
            session_token: serverUser.session_token || local.session_token
          };
          this.setSession(refreshed);

          if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(refreshed.role)) {
            window.location.href = this.getDefaultPageByRole(refreshed.role);
            return null;
          }

          return refreshed;
        }
      } catch (err) {
        if (!this._isMissingRpcError(err)) {
          console.error('[AUTH] validateCurrentUser session RPC failed:', err);
          this.clearSession();
          window.location.href = 'index.html';
          return null;
        }
      }
    }

    try {
      let { data, error } = await db.from('users')
        .select('id, name, role, branch_id, is_active')
        .eq('id', local.id)
        .maybeSingle();

      const errMsg = String(error?.message || '').toLowerCase();
      if (error && (error.code === '42703' || errMsg.includes('is_active'))) {
        ({ data, error } = await db.from('users')
          .select('id, name, role, branch_id')
          .eq('id', local.id)
          .maybeSingle());
      }

      if (error) throw error;
      if (!data) throw new Error('Session tidak valid');
      if (data.is_active === false) throw new Error('Akun sudah dinonaktifkan');

      const refreshed = {
        ...local,
        id: data.id,
        name: data.name || local.name,
        role: data.role || local.role,
        branch_id: data.branch_id ?? local.branch_id ?? null,
      };
      this.setSession(refreshed);

      if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(refreshed.role)) {
        window.location.href = this.getDefaultPageByRole(refreshed.role);
        return null;
      }

      return refreshed;
    } catch (err) {
      console.error('[AUTH] validateCurrentUser failed:', err);
      this.clearSession();
      window.location.href = 'index.html';
      return null;
    }
  }
};
