'use strict';

const transactionService = {

  // ── Process full checkout (ATOMIC) ────────────────────────────
  async processTransaction({
    cart, branchId, staffId, sessionId,
    paymentMethod, paymentAmount,
    discountAmount = 0, taxAmount = 0,
    feeAmount = 0, notes = '', clientTxId
  }) {
    // Basic validation to avoid calling RPC with invalid payload
    if (!Array.isArray(cart) || cart.length === 0) throw new Error('Cart kosong');
    if (!branchId) throw new Error('branchId wajib diisi');
    if (!staffId) throw new Error('staffId wajib diisi');
    if (!paymentMethod) throw new Error('Metode pembayaran wajib diisi');
    const { data, error } = await db.rpc('process_transaction', {
      p_cart: cart,
      p_branch_id: branchId,
      p_staff_id: staffId,
      p_session_id: sessionId || null,
      p_payment_method: paymentMethod,
      p_payment_amount: safeNum(paymentAmount, 'Payment Amount'),
      p_discount_amount: safeNum(discountAmount, 'Discount'),
      p_tax_amount: safeNum(taxAmount, 'Tax'),
      p_fee_amount: safeNum(feeAmount, 'Fee'),
      p_notes: notes || null,
      p_client_tx_id: clientTxId || null
    });

    if (error) throw new Error(error.message);

    return { 
      trx: data, 
      subtotal: data.subtotal, 
      total: data.total, 
      change: data.change_amount, 
      discountAmount: data.discount_amount, 
      taxAmount: data.tax_amount, 
      feeAmount 
    };
  },

  // ── Open cashier shift ────────────────────────────────────────
  async getOpenShiftForBranch({ branchId, excludeStaffId = null } = {}) {
    if (!branchId) throw new Error('branchId wajib diisi');

    let query = db.from('cashier_sessions')
      .select('id, branch_id, staff_id, status, opened_at')
      .eq('branch_id', branchId)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1);

    if (excludeStaffId) query = query.neq('staff_id', excludeStaffId);

    const { data, error } = await query;
    if (error) throw error;

    const session = (data || [])[0] || null;
    if (!session?.staff_id) return session;

    try {
      const { data: staff } = await db.from('users')
        .select('id, name')
        .eq('id', session.staff_id)
        .maybeSingle();
      return {
        ...session,
        staff_name: staff?.name || null
      };
    } catch (e) {
      return session;
    }
  },

  formatOpenShiftBlocker(session, currentStaffName = null) {
    const staffName = session?.staff_name || 'Staff lain';
    const currentName = currentStaffName || 'akun ini';
    return `${staffName} belum tutup kas. Minta ${staffName} tutup kas dulu sebelum ${currentName} membuka kas.`;
  },

  async openShift({ branchId, staffId, openingCash }) {
    // Basic param checks
    if (!branchId) throw new Error('branchId wajib diisi');
    if (!staffId) throw new Error('staffId wajib diisi — silakan login ulang');

    // Verify branch exists
    try {
      const { data: branch } = await db.from('branches').select('id').eq('id', branchId).maybeSingle();
      if (!branch) throw new Error('Cabang tidak ditemukan di database');
    } catch (e) {
      // surface DB errors
      throw new Error('Gagal memverifikasi cabang: ' + (e.message || e));
    }

    // Verify staff/user exists (prevent FK violation)
    let staff = null;
    try {
      const { data: user } = await db.from('users').select('id, name').eq('id', staffId).maybeSingle();
      staff = user || null;
      if (!user) throw new Error('Staff tidak ditemukan di database — silakan login ulang atau hubungi admin');
    } catch (e) {
      throw new Error('Gagal memverifikasi staff: ' + (e.message || e));
    }

    const activeShift = await this.getOpenShiftForBranch({ branchId });
    if (activeShift) {
      if (Number(activeShift.staff_id) === Number(staffId)) {
        throw new Error('Shift sudah dibuka. Tutup shift sebelumnya dulu.');
      }
      throw new Error(this.formatOpenShiftBlocker(activeShift, staff?.name || null));
    }

    // Insert session with guarded error handling for FK violations
    try {
      const { data, error } = await db.from('cashier_sessions').insert({
        branch_id:    branchId,
        staff_id:     staffId,
        opening_cash: openingCash || 0,
        status:       'open'
      }).select().single();
      if (error) throw error;
      return data;
    } catch (err) {
      // Postgres foreign-key violation code is 23503 — provide clearer message
      const msg = (err && err.message) ? String(err.message) : '';
      if (msg.toLowerCase().includes('violates foreign key') || (err && err.code === '23503')) {
        throw new Error('Gagal membuka shift: referensi staff atau cabang tidak valid. Silakan periksa data akun dan cabang.');
      }
      if ((err && err.code === '23505') || msg.toLowerCase().includes('duplicate key')) {
        const activeShift = await this.getOpenShiftForBranch({ branchId });
        if (activeShift && Number(activeShift.staff_id) !== Number(staffId)) {
          throw new Error(this.formatOpenShiftBlocker(activeShift, staff?.name || null));
        }
        throw new Error('Masih ada kas yang belum ditutup. Tutup kas aktif dulu sebelum membuka kas baru.');
      }
      throw err;
    }
  },

  // ── Ambil posisi kas outlet saat ini (branch-based) ──────────
  async getBranchCashPosition({ branchId, staffId = null }) {
    if (!branchId) throw new Error('branchId wajib diisi');
    const { data, error } = await db.rpc('get_branch_cash_position', {
      p_branch_id: branchId,
      p_user_id:   staffId || null
    });
    if (error) throw new Error(error.message);
    return data;
  },

  // ── Buka shift dari posisi kas outlet (branch-based RPC) ─────
  async openShiftFromBalance({ branchId, staffId, physicalCash = null, varianceReason = null }) {
    if (!branchId) throw new Error('branchId wajib diisi');
    if (!staffId)  throw new Error('staffId wajib diisi — silakan login ulang');

    const { data, error } = await db.rpc('open_cash_session_from_branch_balance', {
      p_branch_id:       branchId,
      p_staff_id:        staffId,
      p_physical_cash:   physicalCash !== null ? physicalCash : null,
      p_variance_reason: varianceReason || null
    });

    if (error) {
      if (error.code === '42883' || String(error.message || '').toLowerCase().includes('could not find the function')) {
        console.warn('openShiftFromBalance: RPC branch belum tersedia, fallback ke openShift lama');
        return this.openShift({ branchId, staffId, openingCash: 0 });
      }
      throw new Error(error.message);
    }

    return data;
  },

  // ── Tutup shift dan update posisi kas outlet (branch-based) ──
  async closeShiftApplyBalance({ sessionId, closingCash, staffId, closingNote = null }) {
    if (!sessionId) throw new Error('sessionId wajib diisi');
    if (!staffId)   throw new Error('staffId wajib diisi');

    const { data, error } = await db.rpc('close_cash_session_apply_branch_balance', {
      p_session_id:   sessionId,
      p_closing_cash: closingCash,
      p_staff_id:     staffId,
      p_closing_note: closingNote || null
    });

    if (error) {
      if (error.code === '42883' || String(error.message || '').toLowerCase().includes('could not find the function')) {
        console.warn('closeShiftApplyBalance: RPC branch belum tersedia, fallback ke closeShift lama');
        return this.closeShift({ sessionId, closingCash });
      }
      throw new Error(error.message);
    }

    return data;
  },

  // ── Admin: forced close shift darurat ─────────────────────────
  async adminForceCloseBranchSession({ adminId, sessionId, closingCash, reason }) {
    if (!sessionId) throw new Error('sessionId wajib diisi');
    if (!adminId)   throw new Error('adminId wajib diisi');
    if (!reason?.trim()) throw new Error('Alasan forced close wajib diisi');
    const { data, error } = await db.rpc('admin_force_close_branch_cash_session', {
      p_admin_id:     adminId,
      p_session_id:   sessionId,
      p_closing_cash: closingCash,
      p_reason:       reason.trim()
    });
    if (error) throw new Error(error.message);
    return data;
  },

  // ── Close cashier shift ───────────────────────────────────────
  async closeShift({ sessionId, closingCash }) {
    const { data: sess } = await db.from('cashier_sessions')
      .select('*').eq('id', sessionId).single();
    if (!sess) throw new Error('Sesi tidak ditemukan');
    if (sess.status === 'closed') throw new Error('Shift sudah ditutup');

    // Compute expected cash using cashService if available
    let expectedCash = safeNum(sess.opening_cash || 0, 'Opening Cash') + safeNum(sess.total_sales || 0, 'Total Sales');
    if (typeof cashService !== 'undefined') {
      try {
        const summary = await cashService.getSummary({ branchId: sess.branch_id, sessionId });
        expectedCash  = summary.expectedCash;
      } catch (e) {
        // fallback to simple calc
      }
    }

    // Update dan refetch row closed agar current_cash_amount terisi dan status = 'closed'
    const updatePayload = {
      status:               'closed',
      closing_cash:         closingCash,
      expected_cash:        expectedCash,
      current_cash_amount:  closingCash,
      closed_at:            new Date().toISOString()
    };

    const { data: updated, error } = await db.from('cashier_sessions')
      .update(updatePayload)
      .eq('id', sessionId)
      .select()
      .single();
    if (error) throw error;

    // Fallback jika select gagal (kolom current_cash_amount belum ada di schema lama)
    return updated || { ...sess, ...updatePayload };
  },

  // ── Process refund (ATOMIC) ───────────────────────────────────
  async processRefund({ transactionId, refundAmount, reason, type, userId }) {
    const { data, error } = await db.rpc('refund_transaction', {
      p_transaction_id: transactionId,
      p_refund_amount: safeNum(refundAmount, 'Refund Amount'),
      p_reason: reason,
      p_type: type,
      p_user_id: userId
    });

    if (error) throw new Error(error.message);

    return { id: data.refund_id };
  },

  // ── Find transaction by clientTxId (used for recovery/idempotency) ──
  async getTransactionByClientTxId(clientTxId) {
    if (!clientTxId) return null;
    const { data, error } = await db.from('transactions').select('*').eq('client_tx_id', clientTxId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      trx: data,
      subtotal: data.subtotal,
      total: data.total,
      change: data.change_amount || 0,
      discountAmount: data.discount_amount || 0,
      taxAmount: data.tax_amount || 0,
      feeAmount: data.fee_amount || 0
    };
  },

  // ── Void transaction (ATOMIC) ─────────────────────────────────
  async voidTransaction({ transactionId, reason, userId }) {
    if (!reason?.trim()) throw new Error('Alasan void wajib diisi');

    const { data, error } = await db.rpc('void_transaction', {
      p_transaction_id: transactionId,
      p_reason: reason.trim(),
      p_user_id: userId
    });

    if (error) throw new Error(error.message);

    // Mark related cash_logs as void. This is a best-effort update — if it
    // fails (e.g. network drop after the RPC succeeded), the transaction is
    // still void in the DB; only the cash summary may be temporarily off
    // until the next session reconciliation or a manual DB fix.
    const { error: clErr } = await db.from('cash_logs')
      .update({
        is_void:    true,
        void_reason: reason.trim(),
        voided_by:  userId,
        voided_at:  new Date().toISOString()
      })
      .eq('reference_type', 'sale')
      .eq('reference_id', transactionId);

    if (clErr) {
      console.error('voidTransaction: cash_logs update failed — summary may be inaccurate until reconciled:', clErr);
    }

    return { transactionId, status: data?.status || 'void' };
  }
};
