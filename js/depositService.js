'use strict';

const DEPOSIT_PROOF_ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const DEPOSIT_PROOF_ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'pdf'];
const DEPOSIT_PROOF_MAX_FILE_SIZE = 5 * 1024 * 1024;

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
    const supabaseUrl = (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : (typeof window !== 'undefined' ? window.SUPABASE_URL : ''));
    const supabaseKey = (typeof SUPABASE_KEY !== 'undefined' ? SUPABASE_KEY : (typeof window !== 'undefined' ? window.SUPABASE_KEY : ''));
    if (!supabaseUrl || !supabaseKey || typeof fetch !== 'function') {
      throw new Error('REST fallback metode setoran tidak tersedia');
    }

    const url = new URL(`${supabaseUrl}/rest/v1/deposit_accounts`);
    url.searchParams.set('select', '*');
    url.searchParams.set('is_active', 'eq.true');
    if (branchId) url.searchParams.set('or', `(branch_id.is.null,branch_id.eq.${branchId})`);
    url.searchParams.set('order', 'branch_id.desc.nullslast,created_at.desc');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url.toString(), {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        },
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
        'Timeout memuat metode setoran dari SDK Supabase.'
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
    const ext = this.validateProofFile(file);
    const scope = Number.isFinite(Number(branchId)) ? Number(branchId) : 'global';
    const path = `${scope}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const contentType = this.getProofContentType(file, ext);
    const uploadedAt = new Date().toISOString();

    const { error: uploadErr } = await db.storage
      .from('deposit-proofs')
      .upload(path, file, { contentType, upsert: false });

    if (uploadErr) {
      if (this.isStoragePolicyError(uploadErr)) {
        throw new Error('Upload bukti belum diizinkan oleh Storage. Jalankan migrasi database terbaru lalu coba lagi.');
      }
      throw new Error('Upload bukti gagal: ' + (uploadErr.message || uploadErr));
    }

    const oneYear = 365 * 24 * 3600;
    const { data: signed, error: signErr } = await db.storage.from('deposit-proofs').createSignedUrl(path, oneYear);
    if (signErr) {
      if (this.isStoragePolicyError(signErr)) {
        throw new Error('Bukti berhasil diupload, tetapi belum bisa dibaca oleh Storage. Jalankan migrasi database terbaru lalu coba lagi.');
      }
      throw new Error('Gagal membuat URL bukti setoran: ' + (signErr.message || signErr));
    }

    const proofUrl = signed?.signedUrl || null;
    if (!proofUrl) throw new Error('Gagal membuat URL bukti setoran');

    return {
      url: proofUrl,
      path,
      fileName: file.name || path.split('/').pop(),
      fileType: contentType,
      fileSize: file.size || null,
      uploadedAt
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

    const sessionIds = sessions.map(s => s.id);
    const { data: deposits } = await db
      .from('cash_deposits')
      .select('session_id, amount, status')
      .in('session_id', sessionIds)
      .in('status', ['pending', 'confirmed']);
    const depsBySession = {};
    (deposits || []).forEach(d => {
      if (!depsBySession[d.session_id]) depsBySession[d.session_id] = { pending: 0, confirmed: 0, lastStatus: null };
      if (d.status === 'pending')   depsBySession[d.session_id].pending   += Number(d.amount || 0);
      if (d.status === 'confirmed') depsBySession[d.session_id].confirmed += Number(d.amount || 0);
      depsBySession[d.session_id].lastStatus = d.status;
    });

    return sessions.map(sess => {
      const finalCash = Number(sess.current_cash_amount ?? sess.closing_cash ?? sess.expected_cash ?? 0);
      const dep = depsBySession[sess.id] || { pending: 0, confirmed: 0, lastStatus: null };
      const totalDep = dep.pending + dep.confirmed;
      const depositable = Math.max(0, finalCash - totalDep);
      let blockReason = null;
      if (totalDep > 0 && dep.lastStatus === 'pending')   blockReason = 'Setoran sedang menunggu konfirmasi';
      if (totalDep > 0 && dep.lastStatus === 'confirmed') blockReason = 'Setoran shift ini sudah selesai';
      return {
        session_id:          sess.id,
        branch_id:           sess.branch_id,
        staff_id:            sess.staff_id,
        session_status:      sess.status,
        opened_at:           sess.opened_at,
        closed_at:           sess.closed_at,
        closing_cash:        sess.closing_cash,
        expected_cash:       sess.expected_cash,
        current_cash_amount: sess.current_cash_amount,
        final_cash_amount:   finalCash,
        depositable_cash:    depositable,
        has_active_deposit:  totalDep > 0,
        last_deposit_status: dep.lastStatus,
        block_reason:        blockReason
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
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - daysBack);
    start.setHours(0, 0, 0, 0);

    const { data, error } = await db.from('cash_deposits')
      .select('*, deposit_accounts(label, type, bank_name, account_number)')
      .eq('staff_id', staffId)
      .eq('branch_id', branchId)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async getAllDeposits({ branchId = null, status = null, dateFrom = null, dateTo = null, limit = 100 } = {}) {
    // No embedded joins at all: every joined table with a bigint id column (users, branches)
    // causes the Supabase SDK to overwrite cash_deposits.id (UUID) with that bigint in r.id.
    // deposit_accounts.id is UUID but we still skip the join — caller resolves names client-side.
    let q = db.from('cash_deposits')
      .select(`
        id, branch_id, staff_id, reviewed_by, deposit_account_id,
        deposit_account_name_snapshot,
        amount, cash_balance_at_deposit, proof_url,
        proof_file_name, proof_file_type, proof_file_size, proof_uploaded_at,
        notes,
        status, reject_reason, created_at, reviewed_at
      `)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (branchId) q = q.eq('branch_id', branchId);
    if (status)   q = q.eq('status', status);
    if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00+07:00');
    if (dateTo)   q = q.lte('created_at', dateTo   + 'T23:59:59+07:00');
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

  async createManualDeposit({ adminId, branchId, staffId, sessionId, accountId, amount, proofFile = null, method = null, notes = null }) {
    const normalizedAdminId = Number(adminId);
    const normalizedBranchId = Number(branchId);
    const normalizedStaffId = Number(staffId);
    const normalizedSessionId = Number(sessionId);
    const normalizedAccountId = String(accountId || '').trim();
    const proofRequired = method ? !this.isCashDepositMethod(method) : false;

    amount = safeNum(amount, 'Jumlah setoran');
    if (!Number.isInteger(normalizedAdminId) || normalizedAdminId <= 0) {
      throw new Error('Session admin tidak valid. Login ulang lalu coba lagi.');
    }
    if (!Number.isInteger(normalizedBranchId) || normalizedBranchId <= 0) {
      throw new Error('Cabang wajib dipilih');
    }
    if (!Number.isInteger(normalizedStaffId) || normalizedStaffId <= 0) {
      throw new Error('Staff wajib dipilih');
    }
    if (!Number.isInteger(normalizedSessionId) || normalizedSessionId <= 0) {
      throw new Error('Pilih shift tertutup terlebih dahulu sebelum setoran tunai');
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
        throw new Error('Fitur input manual setoran perlu migrasi terbaru. Jalankan migrasi 030 lalu coba lagi.');
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
    const ext = (file.name || '').split('.').pop() || file.type.split('/').pop();
    const scope = branchId || 'global';
    const path = `qris/${scope}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { data: uploadData, error } = await db.storage.from('deposit-qris').upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      if (this.isStoragePolicyError(error)) {
        throw new Error('Upload QRIS belum diizinkan oleh Storage. Jalankan migrasi database terbaru lalu coba lagi.');
      }
      throw new Error('Upload QRIS gagal: ' + error.message);
    }
    const { data: pub } = await db.storage.from('deposit-qris').getPublicUrl(path);
    return pub?.publicUrl || null;
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
