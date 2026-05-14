'use strict';

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

  async submitDeposit({ branchId, sessionId = null, staffId, accountId, amount, cashBalance = null, file = null, notes = null, requireProof = true }) {
    // Basic validation
    amount = safeNum(amount, 'Jumlah setoran');
    if (amount <= 0) throw new Error('Jumlah setoran harus lebih dari 0');
    if (amount % 50000 !== 0) throw new Error('Nominal harus kelipatan Rp 50.000');
    if (cashBalance != null && amount > cashBalance) throw new Error('Jumlah setoran melebihi saldo kas');
    if (requireProof && !file) throw new Error('Bukti setoran wajib dilampirkan');

    let proofUrl = null;
    if (file) {
      const allowed = ['image/jpeg','image/png','application/pdf'];
      const ext = (file.name || '').split('.').pop().toLowerCase() || file.type.split('/').pop();
      const allowedExt = ['jpg','jpeg','png','pdf'];
      if (!allowed.includes(file.type) && !allowedExt.includes(ext)) throw new Error('Hanya JPG, PNG, atau PDF yang diterima');
      if (file.size <= 0) throw new Error('File tidak boleh kosong');
      if (file.size > 5 * 1024 * 1024) throw new Error('Ukuran file maksimal 5 MB');

      const path = `${branchId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: uploadErr } = await db.storage.from('deposit-proofs').upload(path, file, { contentType: file.type, upsert: false });
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
      proofUrl = signed?.signedUrl || null;
      if (!proofUrl) throw new Error('Gagal membuat URL bukti setoran');
    }

    const { data, error } = await db.rpc('create_deposit', {
      p_branch_id: branchId,
      p_session_id: sessionId || null,
      p_staff_id: staffId,
      p_deposit_account_id: accountId,
      p_amount: amount,
      p_cash_balance_at_deposit: cashBalance,
      p_proof_url: proofUrl,
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
    // Omit branches(name) join — its id column (bigint) overwrites cash_deposits.id (UUID) in the SDK response.
    // Branch name is resolved client-side from adminDepositUi.branches.
    let q = db.from('cash_deposits')
      .select(`
        id, branch_id,
        amount, cash_balance_at_deposit, proof_url, notes,
        status, reject_reason, created_at, reviewed_at,
        deposit_accounts(label, type, bank_name, account_number),
        staff:users!staff_id(name),
        reviewer:users!reviewed_by(name)
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
    if (!depositId || !adminId) throw new Error('depositId dan adminId wajib diisi');
    if (!['confirmed','rejected'].includes(action)) throw new Error('action tidak valid');
    const { error } = await db.rpc('confirm_deposit', {
      p_deposit_id: depositId,
      p_admin_id: adminId,
      p_action: action,
      p_reject_reason: rejectReason || null
    });
    if (error) throw error;
    return true;
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
