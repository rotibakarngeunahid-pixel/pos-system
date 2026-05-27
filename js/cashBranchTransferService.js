'use strict';

/**
 * cashBranchTransferService
 * Service layer untuk fitur Setoran Tunai Antar Outlet.
 *
 * Semua mutasi saldo dilakukan via RPC backend — tidak ada update saldo langsung dari client.
 */
const cashBranchTransferService = {

  /**
   * Membuat request transfer kas dari outlet asal ke outlet tujuan.
   * Saldo belum berubah setelah ini; status = pending.
   */
  async createTransfer({
    fromBranchId,
    toBranchId,
    sessionId,
    staffId,
    amount,
    notes      = null,
    proofFile  = null,
    clientRequestId = null
  }) {
    if (!fromBranchId) throw new Error('Outlet asal wajib dipilih');
    if (!toBranchId)   throw new Error('Outlet tujuan wajib dipilih');
    if (Number(fromBranchId) === Number(toBranchId)) {
      throw new Error('Outlet asal dan tujuan tidak boleh sama');
    }
    if (!sessionId) throw new Error('Tutup shift terlebih dahulu sebelum membuat setoran antar outlet');

    const parsedAmount = safeNum(amount, 'Jumlah setoran');
    if (parsedAmount <= 0) throw new Error('Jumlah setoran harus lebih dari 0');
    // Transfer tunai antar outlet tidak wajib kelipatan Rp 50.000

    // Upload bukti jika ada
    let proof = null;
    if (proofFile) {
      proof = await depositService.uploadDepositProof({ branchId: fromBranchId, file: proofFile });
    }

    const { data, error } = await db.rpc('create_cash_branch_transfer', {
      p_from_branch_id:    Number(fromBranchId),
      p_to_branch_id:      Number(toBranchId),
      p_session_id:        Number(sessionId),
      p_staff_id:          Number(staffId),
      p_amount:            parsedAmount,
      p_notes:             notes || null,
      p_proof_url:         proof?.url         || null,
      p_proof_file_name:   proof?.fileName    || null,
      p_proof_file_type:   proof?.fileType    || null,
      p_proof_file_size:   proof?.fileSize    || null,
      p_proof_uploaded_at: proof?.uploadedAt  || null,
      p_client_request_id: clientRequestId    || null
    });
    if (error) throw error;
    return data;
  },

  /**
   * Mendapatkan daftar transfer pending yang masuk ke outlet tertentu.
   * Dipakai oleh staff outlet tujuan untuk melihat antrian approval.
   */
  async getPendingIncoming({ branchId, userId }) {
    const { data, error } = await db.rpc('get_pending_incoming_cash_branch_transfers', {
      p_branch_id: Number(branchId),
      p_user_id:   Number(userId)
    });
    if (error) throw error;
    return Array.isArray(data) ? data : (data || []);
  },

  /**
   * Staff outlet tujuan menyetujui transfer.
   * Backend secara atomic mengurangi saldo source dan menambah saldo target.
   */
  async confirmTransfer({ transferId, userId }) {
    if (!transferId) throw new Error('Transfer ID tidak valid');
    const { data, error } = await db.rpc('confirm_cash_branch_transfer', {
      p_transfer_id: transferId,
      p_user_id:     Number(userId)
    });
    if (error) throw error;
    return data;
  },

  /**
   * Staff outlet tujuan menolak transfer.
   * Saldo kedua outlet tidak berubah.
   */
  async rejectTransfer({ transferId, userId, reason }) {
    if (!transferId) throw new Error('Transfer ID tidak valid');
    if (!reason || String(reason).trim().length < 3) {
      throw new Error('Alasan penolakan wajib diisi (minimal 3 karakter)');
    }
    const { data, error } = await db.rpc('reject_cash_branch_transfer', {
      p_transfer_id: transferId,
      p_user_id:     Number(userId),
      p_reason:      String(reason).trim()
    });
    if (error) throw error;
    return data;
  },

  /**
   * Staff outlet asal membatalkan transfer sebelum disetujui.
   */
  async cancelTransfer({ transferId, userId, reason = null }) {
    if (!transferId) throw new Error('Transfer ID tidak valid');
    const { data, error } = await db.rpc('cancel_cash_branch_transfer', {
      p_transfer_id: transferId,
      p_user_id:     Number(userId),
      p_reason:      reason ? String(reason).trim() : null
    });
    if (error) throw error;
    return data;
  },

  /**
   * Riwayat transfer yang melibatkan satu outlet (masuk atau keluar).
   */
  async getHistory({ branchId, userId, status = null, limit = 50, offset = 0 }) {
    const { data, error } = await db.rpc('get_cash_branch_transfer_history', {
      p_branch_id: Number(branchId),
      p_user_id:   Number(userId),
      p_status:    status || null,
      p_limit:     limit,
      p_offset:    offset
    });
    if (error) throw error;
    return Array.isArray(data) ? data : (data || []);
  },

  /**
   * Admin/owner melihat semua transfer lintas outlet dengan filter.
   */
  async getAdminTransfers({
    adminId,
    fromBranchId = null,
    toBranchId   = null,
    status       = null,
    dateFrom     = null,
    dateTo       = null,
    limit        = 200,
    offset       = 0
  }) {
    const { data, error } = await db.rpc('get_admin_cash_branch_transfers', {
      p_admin_id:       Number(adminId),
      p_from_branch_id: fromBranchId ? Number(fromBranchId) : null,
      p_to_branch_id:   toBranchId   ? Number(toBranchId)   : null,
      p_status:         status    || null,
      p_date_from:      dateFrom  || null,
      p_date_to:        dateTo    || null,
      p_limit:          limit,
      p_offset:         offset
    });
    if (error) throw error;
    return data || { transfers: [], summary: {} };
  },

  /**
   * Mendapatkan daftar outlet aktif untuk dropdown selector.
   * Menggunakan REST endpoint agar tidak perlu RPC tambahan.
   */
  async getActiveBranches() {
    const { data, error } = await db
      .from('branches')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    return data || [];
  }

};

window.cashBranchTransferService = cashBranchTransferService;
