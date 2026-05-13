'use strict';

const depositService = {

  async getAccounts(branchId = null) {
    let query = db.from('deposit_accounts')
      .select('*')
      .eq('is_active', true)
      .order('type')
      .order('label');

    if (branchId) query = query.or(`branch_id.is.null,branch_id.eq.${branchId}`);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async submitDeposit({ branchId, sessionId = null, staffId, accountId, amount, cashBalance = null, file = null, notes = null }) {
    // Basic validation
    amount = safeNum(amount, 'Jumlah setoran');
    if (amount <= 0) throw new Error('Jumlah setoran harus lebih dari 0');
    if (amount % 50000 !== 0) throw new Error('Nominal harus kelipatan Rp 50.000');
    if (cashBalance != null && amount > cashBalance) throw new Error('Jumlah setoran melebihi saldo kas');
    if (!file) throw new Error('Bukti setoran wajib dilampirkan');

    // Upload proof before creating the pending deposit row.
    let proofUrl = null;
    const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
    if (!allowed.includes(file.type)) throw new Error('Hanya JPG, PNG, WEBP, PDF yang diterima');
    if (file.size <= 0) throw new Error('File tidak boleh kosong');
    if (file.size > 5 * 1024 * 1024) throw new Error('Ukuran file maksimal 5 MB');

    const ext = (file.name || '').split('.').pop() || file.type.split('/').pop();
    const path = `${branchId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: uploadErr } = await db.storage.from('deposit-proofs').upload(path, file, { contentType: file.type, upsert: false });
    if (uploadErr) throw uploadErr;
    const oneYear = 365 * 24 * 3600;
    const { data: signed, error: signErr } = await db.storage.from('deposit-proofs').createSignedUrl(path, oneYear);
    if (signErr) throw signErr;
    proofUrl = signed?.signedUrl || null;
    if (!proofUrl) throw new Error('Gagal membuat URL bukti setoran');

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

  async getMyDeposits({ staffId, branchId, limit = 30 }) {
    const { data, error } = await db.from('cash_deposits')
      .select('*, deposit_accounts(label, type, bank_name, account_number)')
      .eq('staff_id', staffId)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async getAllDeposits({ branchId = null, status = null, dateFrom = null, dateTo = null, limit = 100 } = {}) {
    let q = db.from('cash_deposits')
      .select(`
        id, amount, cash_balance_at_deposit, proof_url, notes,
        status, reject_reason, created_at, reviewed_at,
        deposit_accounts(label, type, bank_name, account_number),
        staff:users!staff_id(name),
        reviewer:users!reviewed_by(name),
        branches(name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (branchId) q = q.eq('branch_id', branchId);
    if (status)   q = q.eq('status', status);
    if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00');
    if (dateTo)   q = q.lte('created_at', dateTo + 'T23:59:59');
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
    if (error) throw new Error('Upload QRIS gagal: ' + error.message);
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
