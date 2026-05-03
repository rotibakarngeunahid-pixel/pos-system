'use strict';

const reportService = {

  // ── Sales Report ──────────────────────────────────────────────
  async getSalesReport({ branchId, dateFrom, dateTo, paymentMethod, staffId }) {
    let q = db.from('transactions')
      .select('id, created_at, total, subtotal, discount_amount, tax_amount, payment_method, status, branches(name), users!staff_id(name)')
      .eq('status', 'completed')
      .gte('created_at', dateFrom + 'T00:00:00')
      .lte('created_at', dateTo + 'T23:59:59')
      .order('created_at', { ascending: false });
    if (branchId) q = q.eq('branch_id', branchId);
    if (paymentMethod) q = q.eq('payment_method', paymentMethod);
    if (staffId) q = q.eq('staff_id', staffId);

    const { data, error } = await q;
    if (error) throw error;

    const transactions = data || [];
    return {
      transactions,
      totalRevenue:  transactions.reduce((s, t) => s + parseFloat(t.total || 0), 0),
      totalDiscount: transactions.reduce((s, t) => s + parseFloat(t.discount_amount || 0), 0),
      count:         transactions.length
    };
  },

  // ── Product Performance ───────────────────────────────────────
  // BUG 5E FIX: replaced two-step query (fetch IDs then .in()) with a single
  // join query from transaction_items → transactions using !inner join.
  // This avoids URL length limit issues with thousands of transaction IDs.
  async getProductPerformance({ branchId, dateFrom, dateTo, paymentMethod, staffId }) {
    // Build query directly on transaction_items with an !inner join to transactions
    // so we can filter by date, status, branch, etc. in one round-trip.
    let q = db.from('transaction_items')
      .select(`
        product_name, variant_name, quantity, subtotal, price,
        transactions!inner(
          id, branch_id, staff_id, payment_method, status, created_at
        )
      `)
      .eq('transactions.status', 'completed')
      .gte('transactions.created_at', dateFrom + 'T00:00:00')
      .lte('transactions.created_at', dateTo + 'T23:59:59');

    if (branchId)      q = q.eq('transactions.branch_id', branchId);
    if (paymentMethod) q = q.eq('transactions.payment_method', paymentMethod);
    if (staffId)       q = q.eq('transactions.staff_id', staffId);

    const { data: items, error } = await q;
    if (error) throw error;
    if (!items?.length) return [];

    const map = {};
    for (const i of items) {
      const key = `${i.product_name}||${i.variant_name}`;
      if (!map[key]) map[key] = {
        product: i.product_name,
        variant: i.variant_name,
        qty:     0,
        revenue: 0
      };
      map[key].qty     += i.quantity;
      map[key].revenue += parseFloat(i.subtotal || 0);
    }

    return Object.values(map).sort((a, b) => b.qty - a.qty);
  },

  // ── Inventory Usage ───────────────────────────────────────────
  async getInventoryUsage({ branchId, dateFrom, dateTo }) {
    let q = db.from('inventory_logs')
      .select('qty, type, created_at, ingredients(name, unit)')
      .eq('type', 'out')
      .eq('reference_type', 'transaction')
      .gte('created_at', dateFrom + 'T00:00:00')
      .lte('created_at', dateTo + 'T23:59:59');
    if (branchId) q = q.eq('branch_id', branchId);

    const { data, error } = await q;
    if (error) throw error;

    const map = {};
    for (const log of (data || [])) {
      const name = log.ingredients?.name || '?';
      if (!map[name]) map[name] = {
        name, unit: log.ingredients?.unit || '', totalUsed: 0
      };
      map[name].totalUsed += parseFloat(log.qty || 0);
    }

    return Object.values(map).sort((a, b) => b.totalUsed - a.totalUsed);
  },

  // ── Cashier Session Summary ───────────────────────────────────
  async getSessionReport({ branchId, dateFrom, dateTo }) {
    let q = db.from('cashier_sessions')
      .select('*, branches(name), users!staff_id(name)')
      .gte('opened_at', dateFrom + 'T00:00:00')
      .lte('opened_at', dateTo + 'T23:59:59')
      .order('opened_at', { ascending: false });
    if (branchId) q = q.eq('branch_id', branchId);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
};
