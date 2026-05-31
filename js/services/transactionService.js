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

    const normalizedCart = cart.map(item => ({
      ...item,
      product_id:   item.product_id   ?? item.productId   ?? null,
      variant_id:   item.variant_id   ?? item.variantId   ?? null,
      product_name: item.product_name ?? item.productName ?? null,
      variant_name: item.variant_name ?? item.variantName ?? null,
    }));

    const { data, error } = await db.rpc('process_transaction', {
      p_cart: normalizedCart,
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
    return `Shift sebelumnya atas nama ${staffName} belum menutup kas. Silakan tutup kas terlebih dahulu.`;
  },

  isOneOpenShiftConflict(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '');
    return code === '23505'
      || msg.includes('idx_cashier_sessions_one_open_per_branch')
      || (msg.includes('duplicate key value') && msg.includes('cashier_sessions'))
      || (msg.includes('unique constraint') && msg.includes('one_open_per_branch'));
  },

  async getOwnOpenShiftForBranch({ branchId, staffId }) {
    if (!branchId || !staffId) return null;
    const { data, error } = await db.from('cashier_sessions')
      .select('*')
      .eq('branch_id', branchId)
      .eq('staff_id', staffId)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data || [])[0] || null;
  },

  async recoverOpenShiftConflict({ branchId, staffId }) {
    const ownSession = await this.getOwnOpenShiftForBranch({ branchId, staffId });
    if (ownSession) return { ...ownSession, already_open: true };

    const activeSession = await this.getOpenShiftForBranch({ branchId });
    if (activeSession) throw new Error(this.formatOpenShiftBlocker(activeSession));

    throw new Error('Shift outlet sudah terbuka. Muat ulang halaman untuk menyinkronkan status shift.');
  },

  async openShift({ branchId, staffId, openingCash }) {
    // Opening cash is owned by the outlet balance, not by a staff input.
    // Keep this wrapper for older callers, but force the branch-based RPC.
    return this.openShiftFromBalance({ branchId, staffId });
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
  async openShiftFromBalance({ branchId, staffId }) {
    if (!branchId) throw new Error('branchId wajib diisi');
    if (!staffId)  throw new Error('staffId wajib diisi — silakan login ulang');

    const { data, error } = await db.rpc('open_cash_session_from_branch_balance', {
      p_branch_id:       branchId,
      p_staff_id:        staffId,
      p_physical_cash:   null,
      p_variance_reason: null
    });

    if (error) {
      if (error.code === '42883' || String(error.message || '').toLowerCase().includes('could not find the function')) {
        throw new Error('Fitur kas awal otomatis perlu migrasi terbaru. Jalankan migrasi 041 lalu coba lagi.');
      }
      if (this.isOneOpenShiftConflict(error)) {
        return this.recoverOpenShiftConflict({ branchId, staffId });
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
        throw new Error('Fitur tutup kas outlet perlu migrasi terbaru. Jalankan migrasi 041 lalu coba lagi.');
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
  async closeShift({ sessionId, closingCash, staffId = null }) {
    const { data: sess } = await db.from('cashier_sessions')
      .select('id, staff_id, status').eq('id', sessionId).single();
    if (!sess) throw new Error('Sesi tidak ditemukan');
    if (sess.status === 'closed') throw new Error('Shift sudah ditutup');

    const effectiveStaffId = staffId || sess.staff_id;
    if (!effectiveStaffId) throw new Error('Staff sesi tidak ditemukan. Tutup shift harus lewat RPC kas outlet.');

    return this.closeShiftApplyBalance({
      sessionId,
      closingCash,
      staffId: effectiveStaffId
    });
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

    // cash_logs sudah di-void secara atomic di dalam rpc_void_transaction (backend).
    // Update tambahan dari frontend tidak diperlukan dan dihapus untuk menghindari
    // overwrite void_at dengan timestamp UTC yang salah timezone.

    return { transactionId, status: data?.status || 'voided' };
  }
};
