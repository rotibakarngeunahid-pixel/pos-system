'use strict';

const reportService = {

  // ── Sales Report ──────────────────────────────────────────────
  async getSalesReport({ branchId, dateFrom, dateTo, paymentMethod, staffId }) {
    // Fetch ALL transactions for the range without a status filter at DB level,
    // so the UI can show both completed and void rows and surface accurate
    // void stats — all in one round-trip.
    let q = db.from('transactions')
      .select('id, created_at, total, subtotal, discount_amount, tax_amount, payment_method, status, branches(name), users!staff_id(name)')
      .gte('created_at', dateFrom + 'T00:00:00+08:00')
      .lte('created_at', dateTo + 'T23:59:59+08:00')
      .order('created_at', { ascending: false });
    if (branchId) q = q.eq('branch_id', branchId);
    if (paymentMethod) q = q.eq('payment_method', paymentMethod);
    if (staffId) q = q.eq('staff_id', staffId);

    const { data, error } = await q;
    if (error) throw error;

    const all = data || [];

    // transactions table only has `status` as void indicator.
    const isVoided = t => t.status === 'void' || t.status === 'voided';

    const completed = all.filter(t => !isVoided(t) && t.status === 'completed');
    const voided    = all.filter(t => isVoided(t));

    return {
      transactions:       completed,
      voidedTransactions: voided,
      totalRevenue:  completed.reduce((s, t) => s + parseFloat(t.total || 0), 0),
      totalDiscount: completed.reduce((s, t) => s + parseFloat(t.discount_amount || 0), 0),
      count:         completed.length,
      voidCount:     voided.length,
      voidAmount:    voided.reduce((s, t) => s + parseFloat(t.total || 0), 0)
    };
  },

  // ── Product Performance ───────────────────────────────────────
  async getProductPerformance({ branchId, dateFrom, dateTo, paymentMethod, staffId }) {
    let q = db.from('transaction_items')
      .select(`
        product_name, variant_name, quantity, subtotal, price,
        transactions!inner(
          id, branch_id, staff_id, payment_method, status, created_at
        )
      `)
      .eq('transactions.status', 'completed')
      .gte('transactions.created_at', dateFrom + 'T00:00:00+08:00')
      .lte('transactions.created_at', dateTo + 'T23:59:59+08:00');

    if (branchId)      q = q.eq('transactions.branch_id', branchId);
    if (paymentMethod) q = q.eq('transactions.payment_method', paymentMethod);
    if (staffId)       q = q.eq('transactions.staff_id', staffId);

    const { data: items, error } = await q;
    if (error) throw error;
    if (!items?.length) return [];

    const map = {};
    for (const i of items) {
      const tx = i.transactions;
      // JS-level guard: skip non-completed rows.
      if (!tx || tx.status !== 'completed') continue;

      const productName = (i.product_name || '').trim() || '(Produk Tidak Tercatat)';
      const variantName = (i.variant_name || '').trim() || null;
      const key = `${productName}||${variantName}`;
      if (!map[key]) map[key] = {
        product:      productName,
        variant:      variantName,
        qty:          0,
        revenue:      0,
        _unrecorded:  !i.product_name,
      };
      map[key].qty     += parseInt(i.quantity, 10) || 0;
      map[key].revenue += parseFloat(i.subtotal || 0);
    }

    return Object.values(map).sort((a, b) => b.qty - a.qty);
  },

  // ── Inventory Usage ───────────────────────────────────────────
  async getInventoryUsage({ branchId, dateFrom, dateTo }) {
    let q = db.from('inventory_logs')
      .select('quantity, type, created_at, reference_type, ingredients(name, unit)')
      .eq('type', 'out')
      .gte('created_at', dateFrom + 'T00:00:00+08:00')
      .lte('created_at', dateTo + 'T23:59:59+08:00');
    if (branchId) q = q.eq('branch_id', branchId);

    const { data, error } = await q;
    if (error) throw error;

    const map = {};
    for (const log of (data || [])) {
      const name = log.ingredients?.name || '?';
      if (!map[name]) map[name] = {
        name, unit: log.ingredients?.unit || '', totalUsed: 0
      };
      map[name].totalUsed += Math.abs(parseFloat(log.quantity || 0));
    }

    return Object.values(map).sort((a, b) => b.totalUsed - a.totalUsed);
  },

  // ── Ingredient Average Usage ─────────────────────────────────
  async getIngredientAvgUsage({ branchId, dateFrom, dateTo }) {
    const params = { p_date_from: dateFrom, p_date_to: dateTo };
    if (branchId) params.p_branch_id = parseInt(branchId, 10);
    const { data, error } = await db.rpc('get_ingredient_avg_usage', params);
    if (error) throw error;
    return data || [];
  },

  // ── Cashier Session Summary ───────────────────────────────────
  async getSessionReport({ branchId, dateFrom, dateTo }) {
    let q = db.from('cashier_sessions')
      .select('*, branches(name), users!staff_id(name)')
      .gte('opened_at', dateFrom + 'T00:00:00+08:00')
      .lte('opened_at', dateTo + 'T23:59:59+08:00')
      .order('opened_at', { ascending: false });
    if (branchId) q = q.eq('branch_id', branchId);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
};
