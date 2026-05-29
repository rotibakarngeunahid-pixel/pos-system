'use strict';

// ── Cash Service ──────────────────────────────────────────────────────────────
// All cash_log operations go through this service.
// Core rule: cash_logs are IMMUTABLE — never delete, only void with reason.

function isMissingRpcError(error) {
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === '42883' ||
    error?.code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    msg.includes('function public.') && msg.includes('does not exist');
}

function isRpcReturnTypeMismatch(error) {
  const msg = String(error?.message || '').toLowerCase();
  return error?.code === '42804' ||
    msg.includes('structure of query does not match function result type');
}

const cashService = {

  // ── Log a cash movement ───────────────────────────────────────
  async logCash({
    branchId, sessionId = null, type, categoryId = null,
    amount, note = null, createdBy = null,
    referenceType = null, referenceId = null
  }) {
    // BUG 5B FIX: skip (don't throw) if amount is 0 or negative (e.g. 100% discount void)
    if (!branchId || !type) {
      throw new Error('logCash: branchId dan type wajib diisi');
    }
    if (!amount || amount <= 0) {
      console.warn('cashService.logCash: amount <= 0, skipping log entry', { branchId, type, amount, referenceType, referenceId });
      return null;
    }
    const { data, error } = await db.from('cash_logs').insert({
      branch_id:      branchId,
      session_id:     sessionId  || null,
      type,
      category_id:    categoryId || null,
      amount:         parseFloat(amount),
      note:           note       || null,
      created_by:     createdBy  || null,
      reference_type: referenceType || null,
      reference_id:   referenceId   || null,
      is_void:        false
    }).select().single();
    if (error) throw error;
    return data;
  },

  // ── Auto-log cash from a completed sale (cash payment only) ───
  async logSale({ branchId, sessionId, amount, transactionId, createdBy }) {
    // Find the "Penjualan Tunai" category
    const { data: cat } = await db.from('cash_categories')
      .select('id')
      .eq('name', 'Penjualan Tunai')
      .eq('type', 'in')
      .maybeSingle();

    return this.logCash({
      branchId,
      sessionId,
      type:          'in',
      categoryId:    cat?.id || null,
      amount,
      note:          `Penjualan #${transactionId}`,
      createdBy,
      referenceType: 'sale',
      referenceId:   transactionId
    });
  },

  // ── Auto-log cash out from a refund ───────────────────────────
  async logRefund({ branchId, sessionId, amount, refundId, createdBy }) {
    const { data: cat } = await db.from('cash_categories')
      .select('id')
      .eq('name', 'Refund')
      .eq('type', 'out')
      .maybeSingle();

    return this.logCash({
      branchId,
      sessionId,
      type:          'out',
      categoryId:    cat?.id || null,
      amount,
      note:          `Refund #${refundId}`,
      createdBy,
      referenceType: 'refund',
      referenceId:   refundId
    });
  },

  // ── Void a cash log (never delete) ───────────────────────────
  async voidLog({ logId, reason, voidedBy }) {
    if (!logId || !reason?.trim()) {
      throw new Error('Log ID dan alasan void wajib diisi');
    }
    const { data: log } = await db.from('cash_logs')
      .select('is_void').eq('id', logId).maybeSingle();
    if (!log) throw new Error('Cash log tidak ditemukan');
    if (log.is_void) throw new Error('Log ini sudah di-void');

    const { error } = await db.from('cash_logs').update({
      is_void:    true,
      void_reason: reason.trim(),
      void_by:    voidedBy || null,
      void_at:    fmt.getWitaTimestamp()
    }).eq('id', logId);
    if (error) throw error;
    return true;
  },

  async getCashTransactionSummary({ branchId, sessionId = null, dateFrom = null, dateTo = null }) {
    let q = db.from('transactions')
      .select('id, total, status, payment_method, session_id')
      .eq('branch_id', branchId)
      .eq('payment_method', 'cash');

    if (sessionId) {
      q = q.eq('session_id', sessionId);
    } else {
      if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00+08:00');
      if (dateTo)   q = q.lte('created_at', dateTo   + 'T23:59:59+08:00');
    }

    const { data, error } = await q;
    if (error) throw error;

    const rows = data || [];
    const completed = rows.filter(r => r.status === 'completed');
    return {
      totalCompleted: completed.reduce((s, r) => s + parseFloat(r.total || 0), 0),
      scopedCashTransactionIds: new Set(rows.map(r => Number(r.id)).filter(Boolean))
    };
  },

  // ── Get cash summary for a session or date range ──────────────
  // Returns: { openingCash, salesIn, cashIn, cashOut, refundOut, voidOut, depositOut, expectedCash }
  async getSummary({ branchId, sessionId = null, dateFrom = null, dateTo = null, includeVoided = true }) {
    let q = db.from('cash_logs')
      .select('type, amount, reference_type, reference_id, is_void, session_id')
      .eq('branch_id', branchId);
    if (!includeVoided) q = q.eq('is_void', false);

    if (sessionId) {
      q = q.eq('session_id', sessionId);
    } else {
      if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00+08:00');
      if (dateTo)   q = q.lte('created_at', dateTo   + 'T23:59:59+08:00');
    }

    const { data: logs, error } = await q;
    if (error) throw error;

    const rows = logs || [];
    const sum  = (arr) => arr.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    // Filter out voided rows to prevent them from affecting the expected cash calculations
    const validRows = rows.filter(r => !r.is_void);

    const salesFromLogs = sum(validRows.filter(r => r.type === 'in'  && r.reference_type === 'sale'));
    const manualIn  = sum(validRows.filter(r => r.type === 'in'  && r.reference_type === 'manual'));
    const manualOut = sum(validRows.filter(r => r.type === 'out' && r.reference_type === 'manual'));
    const refundOut = sum(validRows.filter(r => r.type === 'out' && r.reference_type === 'refund'));
    let depositOut = sum(validRows.filter(r => r.type === 'out' && r.reference_type === 'deposit'));
    const openingIn = sum(validRows.filter(r => r.type === 'in'  && r.reference_type === 'opening'));
    const voidRows  = validRows.filter(r => r.type === 'out' && r.reference_type === 'void');
    let voidOut     = sum(voidRows);
    let salesIn     = salesFromLogs;

    // Opening cash comes from session record, not logs — fetch separately
    let openingCash = openingIn;
    let totalSales  = salesIn; // fallback: cash-only when no session
    if (sessionId) {
      const { data: sess } = await db.from('cashier_sessions')
        .select('opening_cash, total_sales').eq('id', sessionId).maybeSingle();
      openingCash = parseFloat(sess?.opening_cash || 0);
      totalSales  = parseFloat(sess?.total_sales  || 0);
    }

    try {
      const txSummary = await this.getCashTransactionSummary({ branchId, sessionId, dateFrom, dateTo });
      salesIn = txSummary.totalCompleted;
      if (!sessionId) totalSales = salesIn;

      if (txSummary.scopedCashTransactionIds?.size) {
        voidOut = sum(voidRows.filter(r => !txSummary.scopedCashTransactionIds.has(Number(r.reference_id))));
      }
    } catch (e) {
      console.warn('cashService.getSummary: fallback to cash_logs sales total', e);
    }

    try {
      if (sessionId) {
        const { data: deps, error: depErr } = await db.from('cash_deposits')
          .select('amount')
          .eq('session_id', sessionId)
          .eq('status', 'confirmed');
        if (!depErr) depositOut = sum(deps || []);
      }
    } catch (e) {
      console.warn('cashService.getSummary: fallback to cash_logs deposit total', e);
    }

    // Setoran approved adalah mutasi saldo outlet setelah shift closed.
    // Jangan kurangi expected cash shift lama dari setoran tersebut.
    const expectedCash = openingCash + salesIn + manualIn - manualOut - refundOut - voidOut;

    return {
      openingCash,
      salesIn,
      cashSalesIn: salesIn,
      totalSales,
      manualIn,
      manualOut,
      refundOut,
      voidOut,
      depositOut,
      expectedCash,
      totalIn:  openingCash + salesIn + manualIn,
      totalOut: manualOut + refundOut + voidOut
    };
  },

  // ── Get paginated cash log list ───────────────────────────────
  // BUG 1 FIX: use explicit FK aliases so PostgREST can disambiguate
  // the two foreign keys from cash_logs to users (created_by and voided_by).
  // Alias format: aliasName:tableName!constraintName(columns)
  // If the query still fails, check actual FK constraint names with the SQL TODO above
  // and update the constraint hint suffixes accordingly.
  async getLogs({ branchId, sessionId = null, dateFrom = null, dateTo = null, includeVoided = true, limit = 200 }) {
    // Fast path: try explicit FK aliasing (works if constraint names match)
    try {
      let q = db.from('cash_logs')
        .select(`
          id, type, amount, note, created_at,
          reference_type, reference_id,
          is_void, void_reason, void_at,
          cash_categories(name),
          creator:users!cash_logs_created_by_fkey(name),
          voider:users!cash_logs_void_by_fkey(name)
        `)
        .eq('branch_id', branchId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (sessionId)      q = q.eq('session_id', sessionId);
      if (!includeVoided) q = q.eq('is_void', false);
      if (dateFrom)       q = q.gte('created_at', dateFrom + 'T00:00:00+08:00');
      if (dateTo)         q = q.lte('created_at', dateTo   + 'T23:59:59+08:00');

      const { data, error } = await q;
      if (!error) return data || [];
      // fallthrough to robust fallback on error
    } catch (err) {
      // fallthrough to robust fallback
    }

    // Robust fallback: fetch basic fields + creator/voider IDs, then resolve user names
    try {
      let q2 = db.from('cash_logs')
        .select('id, type, amount, note, created_at, reference_type, reference_id, is_void, void_reason, void_at, void_by, cash_categories(name), created_by')
        .eq('branch_id', branchId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (sessionId)      q2 = q2.eq('session_id', sessionId);
      if (!includeVoided) q2 = q2.eq('is_void', false);
      if (dateFrom)       q2 = q2.gte('created_at', dateFrom + 'T00:00:00+08:00');
      if (dateTo)         q2 = q2.lte('created_at', dateTo   + 'T23:59:59+08:00');

      const { data: rows, error: e2 } = await q2;
      if (e2) throw e2;
      const out = rows || [];

      // Resolve creator/voider names in batch
      const userIds = Array.from(new Set(out.flatMap(r => [r.created_by, r.void_by].filter(Boolean))));
      const usersMap = {};
      if (userIds.length) {
        const { data: users } = await db.from('users').select('id, name').in('id', userIds);
        (users || []).forEach(u => { usersMap[u.id] = u.name; });
      }

      return out.map(r => ({
        id: r.id,
        type: r.type,
        amount: r.amount,
        note: r.note,
        created_at: r.created_at,
        reference_type: r.reference_type,
        reference_id: r.reference_id,
        is_void: r.is_void,
        void_reason: r.void_reason,
        void_at: r.void_at,
        cash_categories: r.cash_categories || null,
        creator: r.created_by ? { name: usersMap[r.created_by] || '—' } : null,
        voider:  r.void_by    ? { name: usersMap[r.void_by]    || '—' } : null
      }));
    } catch (err) {
      throw err;
    }
  },

  // ── Load cash categories by type ──────────────────────────────
  async getCategories(type = null) {
    let q = db.from('cash_categories').select('*').order('name');
    if (type) q = q.eq('type', type);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getAdminCashSessions({ adminId, branchId = null, staffId = null, status = 'open', dateFrom = null, dateTo = null } = {}) {
    if (!adminId) throw new Error('Session admin tidak valid. Login ulang lalu coba lagi.');

    const { data, error } = await db.rpc('get_admin_cash_sessions', {
      p_admin_id:   adminId,
      p_branch_id:  branchId || null,
      p_staff_id:   staffId || null,
      p_status:     status || 'open',
      p_date_from:  dateFrom || null,
      p_date_to:    dateTo || null
    });
    if (error) {
      if (isRpcReturnTypeMismatch(error)) {
        throw new Error('RPC kas admin perlu patch migrasi 029. Jalankan migrasi 029 lalu refresh halaman.');
      }
      if (isMissingRpcError(error)) {
        throw new Error('Fitur kas admin perlu migrasi terbaru. Jalankan migrasi 028 lalu coba lagi.');
      }
      throw error;
    }
    return data || [];
  },

  async getAdminCashSessionDetail({ sessionId }) {
    if (!sessionId) throw new Error('Session kas wajib dipilih');

    const { data: session, error: sessErr } = await db.from('cashier_sessions')
      .select(`
        id, branch_id, staff_id, status, opened_at, closed_at,
        opening_cash, closing_cash, expected_cash, total_sales,
        closed_manually, manual_closed_by, manual_closed_at,
        manual_close_reason, current_cash_amount, has_manual_adjustment,
        updated_at
      `)
      .eq('id', sessionId)
      .maybeSingle();
    if (sessErr) {
      const msg = String(sessErr.message || '').toLowerCase();
      if (sessErr.code === '42703' || msg.includes('closed_manually') || msg.includes('current_cash_amount')) {
        throw new Error('Fitur kas admin perlu migrasi terbaru. Jalankan migrasi 028 lalu coba lagi.');
      }
      throw sessErr;
    }
    if (!session) throw new Error('Kas tidak ditemukan');

    const branchId = session.branch_id;
    const staffId = session.staff_id;
    const depositsQuery = db.from('cash_deposits')
      .select('id, amount, status, notes, created_at, reviewed_at, reject_reason, session_id, account_id, proof_url, proof_file_name, proof_file_type, proof_file_size, proof_uploaded_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(30);

    const adjustmentsQuery = db.from('cash_session_adjustments')
      .select('id, cash_session_id, branch_id, staff_id, action_type, previous_cash_amount, new_cash_amount, adjustment_amount, reason, created_by, created_by_name, created_at, metadata')
      .eq('cash_session_id', sessionId)
      .order('created_at', { ascending: false });

    const [
      branchRes,
      staffRes,
      summaryRes,
      logsRes,
      depositsRes,
      adjustmentsRes
    ] = await Promise.allSettled([
      db.from('branches').select('id, name').eq('id', branchId).maybeSingle(),
      db.from('users').select('id, name, role').eq('id', staffId).maybeSingle(),
      this.getSummary({ branchId, sessionId }),
      this.getLogs({ branchId, sessionId, limit: 30 }),
      depositsQuery,
      adjustmentsQuery
    ]);

    const unwrapDb = (res, fallback = null) => {
      if (res.status !== 'fulfilled') throw res.reason;
      if (res.value?.error) throw res.value.error;
      return res.value?.data ?? fallback;
    };
    const unwrapValue = (res, fallback = null) => {
      if (res.status !== 'fulfilled') throw res.reason;
      return res.value ?? fallback;
    };

    const branch = unwrapDb(branchRes, null);
    const staff = unwrapDb(staffRes, null);
    const summary = unwrapValue(summaryRes, null);
    const logs = unwrapValue(logsRes, []);
    const deposits = unwrapDb(depositsRes, []);
    let adjustments = [];
    try {
      adjustments = unwrapDb(adjustmentsRes, []);
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      if (e?.code === '42P01' || msg.includes('cash_session_adjustments')) {
        adjustments = [];
      } else {
        throw e;
      }
    }

    const num = value => Number.parseFloat(value || 0);
    const systemCashAmount = summary
      ? num(summary.expectedCash)
      : num(session.expected_cash);
    const actualCashAmount = session.current_cash_amount != null
      ? num(session.current_cash_amount)
      : session.closing_cash != null
        ? num(session.closing_cash)
        : systemCashAmount;

    return {
      session: {
        ...session,
        branch_name: branch?.name || null,
        staff_name: staff?.name || null
      },
      summary,
      logs: logs || [],
      deposits: deposits || [],
      adjustments: adjustments || [],
      systemCashAmount,
      actualCashAmount
    };
  },

  async manualCloseCashSession({ sessionId, adminId, actualCashAmount, reason, expectedUpdatedAt = null }) {
    if (!adminId) throw new Error('Session admin tidak valid. Login ulang lalu coba lagi.');
    if (!sessionId) throw new Error('Session kas wajib dipilih');
    if (!reason?.trim()) throw new Error('Alasan wajib diisi');
    const amount = safeNum(actualCashAmount, 'Nominal kas aktual');
    if (amount < 0) throw new Error('Nominal kas aktual tidak boleh negatif');

    const { data, error } = await db.rpc('admin_force_close_branch_cash_session', {
      p_admin_id: adminId,
      p_session_id: sessionId,
      p_closing_cash: amount,
      p_reason: reason.trim()
    });
    if (error) {
      if (isMissingRpcError(error)) {
        throw new Error('Fitur tutup kas outlet perlu migrasi terbaru. Jalankan migrasi 041 lalu coba lagi.');
      }
      throw error;
    }
    return data;
  },

  async adjustCashSessionActual({ sessionId, adminId, newCashAmount, reason, expectedUpdatedAt = null }) {
    throw new Error('Edit posisi kas per sesi sudah dinonaktifkan. Koreksi saldo dilakukan dari menu Kas Outlet.');
  },

  // ── Save a cash category (create or update) ───────────────────
  async saveCategory({ id = null, name, type }) {
    if (!name?.trim() || !type) throw new Error('Nama dan tipe kategori wajib diisi');
    const payload = { name: name.trim(), type };
    const { error } = id
      ? await db.from('cash_categories').update(payload).eq('id', id)
      : await db.from('cash_categories').insert(payload);
    if (error) throw error;
  },

  // ── Delete a cash category ────────────────────────────────────
  async deleteCategory(id) {
    const { error } = await db.from('cash_categories').delete().eq('id', id);
    if (error) throw error;
  },

  // ── Legacy Staff Balance Methods (disabled) ───────────────────

  // Legacy staff-balance methods. Kas outlet is the active source of truth.
  async getStaffBalance(branchId, staffId) {
    throw new Error('Saldo kas per staff sudah dinonaktifkan. Gunakan posisi Kas Outlet.');
  },

  // Daftar saldo aktif semua staff (untuk UI admin)
  async getAdminStaffBalances({ adminId, branchId = null, staffId = null } = {}) {
    throw new Error('Saldo kas per staff sudah dinonaktifkan. Gunakan menu Kas Outlet.');
  },

  // Disabled: set/koreksi saldo staff.
  async adminSetStaffBalance({ adminId, branchId, staffId, newBalance, reason, version = null }) {
    throw new Error('Koreksi kas per staff sudah dinonaktifkan. Koreksi dilakukan dari menu Kas Outlet.');
  },

  // Disabled: riwayat saldo staff.
  async getStaffCashLedger({ branchId, staffId, limit = 30 } = {}) {
    throw new Error('Ledger kas per staff sudah dinonaktifkan. Gunakan riwayat Kas Outlet.');
  },

  // ── Get cash positions for all active staff (admin dashboard) ─
  // Kept only so old callers fail with a clear message.
  async getStaffCashPositions({ branchId = null, status = 'all' } = {}) {
    throw new Error('Posisi kas per staff sudah dinonaktifkan. Gunakan posisi Kas Outlet.');
  },

  // ── Get detail breakdown for a single staff/session ──────────
  // Returns { summary, logs, deposits } using existing methods.
  async getStaffCashPositionDetail({ staffId, branchId, sessionId = null }) {
    throw new Error('Detail posisi kas per staff sudah dinonaktifkan. Gunakan detail Sesi Kas atau Kas Outlet.');
  },

  // ── Branch Cash Balance (Posisi Kas Outlet) ───────────────────

  async getAdminBranchCashPositions({ adminId, branchId = null, staffId = null, status = 'all', dateFrom = null, dateTo = null } = {}) {
    const { data, error } = await db.rpc('get_admin_branch_cash_positions', {
      p_admin_id:  adminId,
      p_branch_id: branchId  || null,
      p_staff_id:  staffId   || null,
      p_status:    status    || 'all',
      p_date_from: dateFrom  || null,
      p_date_to:   dateTo    || null
    });
    if (error) throw new Error(error.message);
    return data || [];
  },

  async adminSetBranchCashBalance({ adminId, branchId, newBalance, reason, version = null }) {
    if (!adminId)  throw new Error('adminId wajib diisi');
    if (!branchId) throw new Error('branchId wajib diisi');
    if (!reason?.trim()) throw new Error('Alasan koreksi wajib diisi');
    const { data, error } = await db.rpc('admin_set_branch_cash_balance', {
      p_admin_id:    adminId,
      p_branch_id:   branchId,
      p_new_balance: newBalance,
      p_reason:      reason.trim(),
      p_version:     version !== null ? version : null
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async getBranchCashLedger({ adminId, branchId, dateFrom = null, dateTo = null, movementType = null, limit = 100 } = {}) {
    const { data, error } = await db.rpc('get_branch_cash_ledger', {
      p_admin_id:      adminId,
      p_branch_id:     branchId,
      p_date_from:     dateFrom     || null,
      p_date_to:       dateTo       || null,
      p_movement_type: movementType || null,
      p_limit:         limit        || 100
    });
    if (error) throw new Error(error.message);
    return data || [];
  }
};
