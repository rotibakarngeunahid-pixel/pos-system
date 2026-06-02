'use strict';

const DEPOSIT_PROOF_ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const DEPOSIT_PROOF_ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'pdf'];
const DEPOSIT_PROOF_MAX_FILE_SIZE = 5 * 1024 * 1024;

// Upload endpoint: gunakan upload.php di direktori yang sama dengan api.php
// API_BASE didefinisikan di apiClient.js
function _depositUploadUrl() {
  return (typeof API_BASE !== 'undefined' ? API_BASE : '').replace('/api.php', '/upload.php');
}

function _depositUploadOrigin() {
  try {
    const base = (typeof window !== 'undefined' && window.location) ? window.location.href : undefined;
    return new URL(_depositUploadUrl(), base).origin;
  } catch {
    return '';
  }
}

const depositService = {

  async withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  },

  async fetchAccountsViaRest({ branchId = null } = {}) {
    const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : '';
    const apiKey  = typeof API_KEY  !== 'undefined' ? API_KEY  : '';
    if (!apiBase || typeof fetch !== 'function') {
      throw new Error('REST fallback metode setoran tidak tersedia');
    }

    const url = new URL(`${apiBase}/deposit_accounts`);
    url.searchParams.set('select', '*');
    url.searchParams.set('is_active', 'eq.true');
    if (branchId) url.searchParams.set('_or', `branch_id.is.null,branch_id.eq.${branchId}`);
    url.searchParams.set('order', 'branch_id.desc,created_at.desc');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url.toString(), {
        headers: { 'X-API-Key': apiKey },
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } finally {
      clearTimeout(timer);
    }
  },

  async getAccounts({ branchId = null } = {}) {
    const scopedBranchId = Number.isFinite(Number(branchId)) ? Number(branchId) : null;
    let query = db.from('deposit_accounts')
      .select('*')
      .eq('is_active', true);

    if (scopedBranchId) {
      query = query.or(`branch_id.is.null,branch_id.eq.${scopedBranchId}`);
    }

    query = query
      .order('branch_id', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    try {
      const { data, error } = await this.withTimeout(
        query,
        5000,
        'Timeout memuat metode setoran dari API.'
      );
      if (error) throw error;
      return data || [];
    } catch (primaryError) {
      console.warn('depositService.getAccounts primary query failed, trying REST fallback', primaryError);
      try {
        return await this.fetchAccountsViaRest({ branchId: scopedBranchId });
      } catch (fallbackError) {
        throw new Error(`Gagal memuat metode setoran: ${fallbackError.message || primaryError.message}`);
      }
    }
  },

  isStoragePolicyError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('row-level security')
      || message.includes('violates row-level security')
      || message.includes('permission denied');
  },

  isCashDepositMethod(method) {
    if (!method) return false;
    if (method.is_cash === true) return true;

    const structuredValue = String(method.type || method.category || method.code || '').trim().toLowerCase();
    if (structuredValue) {
      return ['cash', 'tunai', 'serah_tunai', 'serah tunai'].includes(structuredValue);
    }

    const labelValue = [method.label, method.name]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();
    if (!labelValue) return false;

    return labelValue.includes('serah tunai')
      || /\bcash\b/.test(labelValue)
      || /\btunai\b/.test(labelValue);
  },

  normalizeUploadUrl(url) {
    if (!url) return url;
    const raw = String(url).trim();
    if (!raw) return raw;

    try {
      const base = (typeof window !== 'undefined' && window.location) ? window.location.href : undefined;
      const parsed = new URL(raw, base);
      if (parsed.pathname.startsWith('/uploads/')) {
        const uploadOrigin = _depositUploadOrigin();
        if (uploadOrigin) {
          return uploadOrigin + parsed.pathname + parsed.search + parsed.hash;
        }
      }
      return parsed.href;
    } catch {
      return raw;
    }
  },

  normalizeProofUrl(url) {
    return this.normalizeUploadUrl(url);
  },

  validateProofFile(file) {
    if (!file) throw new Error('Upload bukti setoran terlebih dahulu');

    const rawExt = (file.name || '').split('.').pop().toLowerCase();
    const mimeExt = (file.type || '').split('/').pop().toLowerCase();
    const ext = DEPOSIT_PROOF_ALLOWED_EXT.includes(rawExt) ? rawExt : mimeExt;

    if (file.size <= 0) throw new Error('File tidak boleh kosong');
    if (file.size > DEPOSIT_PROOF_MAX_FILE_SIZE) throw new Error('Ukuran file maksimal 5 MB');
    if (!DEPOSIT_PROOF_ALLOWED_MIME.includes(file.type) && !DEPOSIT_PROOF_ALLOWED_EXT.includes(rawExt)) {
      throw new Error('Hanya JPG, PNG, atau PDF yang diterima');
    }

    return ext || rawExt || 'jpg';
  },

  getProofContentType(file, ext) {
    if (file?.type) return file.type;
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'png') return 'image/png';
    return 'image/jpeg';
  },

  async uploadDepositProof({ branchId, file }) {
    this.validateProofFile(file);

    const scope = Number.isFinite(Number(branchId)) ? String(Number(branchId)) : 'global';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'bukti_setoran');

    let res;
    try {
      const uploadUrl = _depositUploadUrl();
      const uploadKey = typeof API_KEY !== 'undefined' ? API_KEY : '';
      const sessionToken = typeof getRbnSessionToken === 'function' ? getRbnSessionToken() : '';
      res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-API-Key': uploadKey,
          ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}),
        },
        body: formData
      });
    } catch (networkErr) {
      console.error('[depositService] uploadDepositProof network error:', networkErr);
      throw new Error('Upload bukti gagal: tidak dapat terhubung ke server. Periksa koneksi internet lalu coba lagi.');
    }

    let result;
    try {
      result = await res.json();
    } catch {
      throw new Error('Upload bukti gagal: respons server tidak valid (HTTP ' + res.status + ')');
    }

    if (!res.ok || result.error) {
      throw new Error('Upload bukti gagal: ' + (result.error || 'HTTP ' + res.status));
    }

    if (!result.url) throw new Error('Upload bukti gagal: server tidak mengembalikan URL');

    const proofUrl = this.normalizeProofUrl(result.url);

    return {
      url:        proofUrl,
      path:       result.path       || scope + '/' + file.name,
      fileName:   result.fileName   || file.name,
      fileType:   result.fileType   || file.type,
      fileSize:   result.fileSize   ?? file.size ?? null,
      uploadedAt: result.uploadedAt || new Date().toISOString()
    };
  },

  async getEligibleSessions({ branchId, staffId, limit = 10 } = {}) {
    const { data, error } = await db.rpc('get_deposit_eligible_sessions', {
      p_branch_id: branchId,
      p_staff_id: staffId,
      p_limit: limit
    });
    if (!error) return data || [];

    console.warn('[depositService] get_deposit_eligible_sessions RPC gagal, menggunakan fallback query:', error.message);
    return this._getEligibleSessionsFallback({ branchId, staffId, limit });
  },

  async getBranchCashPosition({ branchId } = {}) {
    const normalizedBranchId = Number(branchId);
    if (!Number.isInteger(normalizedBranchId) || normalizedBranchId <= 0) {
      throw new Error('Cabang wajib dipilih');
    }

    const { data, error } = await db.rpc('get_branch_cash_position', {
      p_branch_id: normalizedBranchId
    });
    if (error) throw new Error(error.message || 'Gagal memuat posisi kas outlet');
    return data || null;
  },

  async _getEligibleSessionsFallback({ branchId, staffId, limit = 10 } = {}) {
    const { data: sessions, error: sessErr } = await db
      .from('cashier_sessions')
      .select('id, branch_id, staff_id, status, opened_at, closed_at, closing_cash, expected_cash, current_cash_amount')
      .eq('branch_id', branchId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (sessErr) throw sessErr;
    if (!sessions || sessions.length === 0) return [];

    // Saldo aktual cabang dari branch_cash_balances (termasuk transfer masuk yang sudah dikonfirmasi).
    const { data: branchBalRows } = await db
      .from('branch_cash_balances')
      .select('current_balance')
      .eq('branch_id', branchId)
      .limit(1);
    const branchCurrentBalance = branchBalRows && branchBalRows.length > 0
      ? Number(branchBalRows[0].current_balance || 0)
      : 0;

    const sessionIds = sessions.map(s => s.id);
    const { data: deposits } = await db
      .from('cash_deposits')
      .select('session_id, amount, status')
      .eq('branch_id', branchId)
      .in('status', ['pending', 'confirmed']);
    const depsBySession = {};
    let totalPendingBranch = 0;
    (deposits || []).forEach(d => {
      if (!depsBySession[d.session_id]) depsBySession[d.session_id] = { pending: 0, confirmed: 0, lastStatus: null };
      if (d.status === 'pending') {
        depsBySession[d.session_id].pending += Number(d.amount || 0);
        totalPendingBranch += Number(d.amount || 0);
      }
      if (d.status === 'confirmed') depsBySession[d.session_id].confirmed += Number(d.amount || 0);
      depsBySession[d.session_id].lastStatus = d.status;
    });

    const hasAnyPending = (deposits || []).some(d => d.status === 'pending');

    // Kas bersih yang bisa disetor = saldo aktual cabang - deposit pending
    const netDepositable = Math.max(0, branchCurrentBalance - totalPendingBranch);

    return sessions.map(sess => {
      const finalCash = Number(sess.current_cash_amount ?? sess.closing_cash ?? sess.expected_cash ?? 0);
      const dep = depsBySession[sess.id] || { pending: 0, confirmed: 0, lastStatus: null };
      const totalDep = dep.pending + dep.confirmed;
      let blockReason = null;
      if (totalDep > 0 && dep.lastStatus === 'pending')   blockReason = 'Setoran sedang menunggu konfirmasi';
      if (totalDep > 0 && dep.lastStatus === 'confirmed') blockReason = 'Setoran shift ini sudah selesai';
      if (!blockReason && hasAnyPending && dep.pending === 0) blockReason = 'Masih ada setoran dari shift lain yang menunggu konfirmasi';
      return {
        session_id:            sess.id,
        branch_id:             sess.branch_id,
        staff_id:              sess.staff_id,
        session_status:        sess.status,
        opened_at:             sess.opened_at,
        closed_at:             sess.closed_at,
        closing_cash:          sess.closing_cash,
        expected_cash:         sess.expected_cash,
        current_cash_amount:   sess.current_cash_amount,
        final_cash_amount:     finalCash,
        depositable_cash:      netDepositable,
        branch_current_balance: branchCurrentBalance,
        has_active_deposit:    totalDep > 0,
        last_deposit_status:   dep.lastStatus,
        block_reason:          blockReason
      };
    });
  },

  async submitDeposit({ branchId, sessionId, staffId, accountId, amount, cashBalance = null, file = null, notes = null, requireProof = true }) {
    if (!sessionId) throw new Error('Tutup shift terlebih dahulu sebelum setoran tunai');

    amount = safeNum(amount, 'Jumlah setoran');
    if (amount <= 0) throw new Error('Jumlah setoran harus lebih dari 0');
    if (amount % 50000 !== 0) throw new Error('Nominal harus kelipatan Rp 50.000');
    if (cashBalance != null && amount > cashBalance) throw new Error('Jumlah setoran melebihi saldo kas');
    if (requireProof && !file) throw new Error('Bukti setoran wajib dilampirkan');

    let proof = null;
    if (file) {
      proof = await this.uploadDepositProof({ branchId, file });
    }

    const { data, error } = await db.rpc('create_deposit', {
      p_branch_id: branchId,
      p_session_id: sessionId,
      p_staff_id: staffId,
      p_deposit_account_id: accountId,
      p_amount: amount,
      p_cash_balance_at_deposit: cashBalance,
      p_proof_url: proof?.url || null,
      p_notes: notes || null
    });
    if (error) throw error;
    return data;
  },

  async getMyDeposits({ staffId, branchId, limit = 50, daysBack = 0 }) {
    // Hitung range tanggal dalam WITA (UTC+8) agar cocok dengan data tersimpan di DB
    const witaMs    = Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000;
    const endDate   = new Date(witaMs).toISOString().slice(0, 10);
    const startDate = new Date(witaMs - daysBack * 86400000).toISOString().slice(0, 10);

    const { data, error } = await db.from('cash_deposits')
      .select('*, deposit_accounts(label, type, bank_name, account_number)')
      .eq('staff_id', staffId)
      .eq('branch_id', branchId)
      .gte('created_at', startDate + 'T00:00:00+08:00')
      .lte('created_at', endDate   + 'T23:59:59+08:00')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async getAllDeposits({ branchId = null, status = null, dateFrom = null, dateTo = null, limit = 100 } = {}) {
    // No embedded joins — caller resolves names client-side to keep the query simple.
    let q = db.from('cash_deposits')
      .select(`
        id, branch_id, staff_id, session_id, reviewed_by, account_id,
        amount, method, cash_balance_at_deposit, proof_url,
        proof_file_name, proof_file_type, proof_file_size, proof_uploaded_at,
        notes,
        status, reject_reason, created_at, reviewed_at
      `)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (branchId) q = q.eq('branch_id', branchId);
    if (status)   q = q.eq('status', status);
    if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00+08:00');
    if (dateTo)   q = q.lte('created_at', dateTo   + 'T23:59:59+08:00');
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async confirmDeposit({ depositId, adminId, action, rejectReason = null }) {
    const normalizedDepositId = String(depositId || '').trim();
    const normalizedAdminId = Number(adminId);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!normalizedDepositId || !Number.isInteger(normalizedAdminId) || normalizedAdminId <= 0) {
      throw new Error('depositId dan adminId wajib diisi');
    }
    if (!uuidPattern.test(normalizedDepositId)) {
      throw new Error('ID setoran tidak valid. Muat ulang halaman lalu coba lagi.');
    }
    if (!['confirmed','rejected'].includes(action)) throw new Error('action tidak valid');
    const { error } = await db.rpc('confirm_deposit', {
      p_deposit_id: normalizedDepositId,
      p_admin_id: normalizedAdminId,
      p_action: action,
      p_reject_reason: rejectReason || null
    });
    if (error) throw error;
    return true;
  },

  async createManualDeposit({ adminId, branchId, staffId = null, sessionId = null, accountId, amount, proofFile = null, method = null, notes = null }) {
    const normalizedAdminId = Number(adminId);
    const normalizedBranchId = Number(branchId);
    const normalizedStaffId = staffId == null || staffId === '' ? null : Number(staffId);
    const normalizedSessionId = sessionId == null || sessionId === '' ? null : Number(sessionId);
    const normalizedAccountId = String(accountId || '').trim();
    const proofRequired = method ? !this.isCashDepositMethod(method) : false;

    amount = safeNum(amount, 'Jumlah setoran');
    if (!Number.isInteger(normalizedAdminId) || normalizedAdminId <= 0) {
      throw new Error('Session admin tidak valid. Login ulang lalu coba lagi.');
    }
    if (!Number.isInteger(normalizedBranchId) || normalizedBranchId <= 0) {
      throw new Error('Cabang wajib dipilih');
    }
    if (normalizedStaffId !== null && (!Number.isInteger(normalizedStaffId) || normalizedStaffId <= 0)) {
      throw new Error('Staff tidak valid');
    }
    if (normalizedSessionId !== null && (!Number.isInteger(normalizedSessionId) || normalizedSessionId <= 0)) {
      throw new Error('Shift tidak valid');
    }
    if (!normalizedAccountId) throw new Error('Pilih metode setoran terlebih dahulu');
    if (proofRequired && !proofFile) throw new Error('Upload bukti setoran terlebih dahulu.');
    if (amount <= 0) throw new Error('Jumlah setoran harus lebih dari 0');
    if (amount % 50000 !== 0) throw new Error('Nominal harus kelipatan Rp 50.000');

    const proof = proofFile
      ? await this.uploadDepositProof({ branchId: normalizedBranchId, file: proofFile })
      : null;

    const { data, error } = await db.rpc('admin_create_manual_deposit', {
      p_admin_id: normalizedAdminId,
      p_branch_id: normalizedBranchId,
      p_staff_id: normalizedStaffId,
      p_session_id: normalizedSessionId,
      p_deposit_account_id: normalizedAccountId,
      p_amount: amount,
      p_notes: notes || null,
      p_status: 'confirmed',
      p_proof_url: proof?.url || null,
      p_proof_file_name: proof?.fileName || null,
      p_proof_file_type: proof?.fileType || null,
      p_proof_file_size: proof?.fileSize || null,
      p_proof_uploaded_at: proof?.uploadedAt || null
    });
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (error.code === '42883' || msg.includes('function') || msg.includes('does not exist')) {
        throw new Error('Fitur input manual setoran perlu migrasi terbaru. Jalankan migrasi 060 lalu coba lagi.');
      }
      if (msg.includes('staff_id') && (msg.includes('null') || msg.includes('cannot be null'))) {
        throw new Error('Database perlu migrasi 060 agar setoran manual admin tidak wajib staff.');
      }
      throw error;
    }
    return data;
  },

  async saveAccount({ id = null, branchId = null, type, label, bankName, accountNumber, accountHolder, qrisImageUrl, isActive = true }) {
    if (!type || !label) throw new Error('Tipe dan label wajib diisi');
    const payload = {
      branch_id: branchId || null,
      type,
      label,
      bank_name: bankName || null,
      account_number: accountNumber || null,
      account_holder: accountHolder || null,
      qris_image_url: qrisImageUrl || null,
      is_active: isActive
    };
    const { error } = id
      ? await db.from('deposit_accounts').update(payload).eq('id', id)
      : await db.from('deposit_accounts').insert(payload);
    if (error) throw error;
    return true;
  },

  async uploadQrisImage(branchId, file) {
    if (!file) throw new Error('File tidak ditemukan');
    const allowed = ['image/jpeg','image/png','image/webp'];
    if (!allowed.includes(file.type)) throw new Error('Hanya JPG, PNG, atau WEBP yang diterima');
    if (file.size <= 0) throw new Error('File tidak boleh kosong');
    if (file.size > 5 * 1024 * 1024) throw new Error('Ukuran file maksimal 5 MB');
    const UPLOAD_URL = API_BASE.replace('/api.php', '/upload.php');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('folder', 'qris');
    const sessionToken = typeof getRbnSessionToken === 'function' ? getRbnSessionToken() : '';
    const upRes = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}),
      },
      body: fd
    });
    if (!upRes.ok) throw new Error('Upload QRIS gagal: HTTP ' + upRes.status);
    const upJson = await upRes.json();
    if (!upJson.success) throw new Error('Upload QRIS gagal: ' + (upJson.error || 'Unknown error'));
    return this.normalizeUploadUrl(upJson.url || null);
  },

  async getSessionDepositSummary(sessionId) {
    const { data, error } = await db.from('cash_deposits')
      .select('amount, status')
      .eq('session_id', sessionId);
    if (error) throw error;
    const rows = data || [];
    return {
      totalPending:   rows.filter(r => r.status === 'pending').reduce((s,r) => s + parseFloat(r.amount || 0), 0),
      totalConfirmed: rows.filter(r => r.status === 'confirmed').reduce((s,r) => s + parseFloat(r.amount || 0), 0),
      count: rows.length
    };
  }

};

window.depositService = depositService;
