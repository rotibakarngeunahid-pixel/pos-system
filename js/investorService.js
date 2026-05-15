'use strict';

const investorService = {

  async getAccessConfig(userId) {
    const { data, error } = await db.rpc('investor_get_access_config', { p_user_id: userId });
    if (error) throw error;
    const raw = typeof data === 'string' ? JSON.parse(data) : data;
    return raw || { branches: [], features: [] };
  },

  async getAllowedBranches(userId) {
    const { data, error } = await db.rpc('investor_get_allowed_branches', { p_user_id: userId });
    if (error) throw error;
    return data || [];
  },

  async getSalesReport({ userId, branchId, dateFrom, dateTo, paymentMethod }) {
    const { data, error } = await db.rpc('investor_get_sales_report', {
      p_user_id:        userId,
      p_branch_id:      branchId,
      p_date_from:      dateFrom,
      p_date_to:        dateTo,
      p_payment_method: paymentMethod || null
    });
    if (error) throw error;
    return typeof data === 'string' ? JSON.parse(data) : data;
  },

  async getProductPerformance({ userId, branchId, dateFrom, dateTo }) {
    const { data, error } = await db.rpc('investor_get_product_performance', {
      p_user_id:   userId,
      p_branch_id: branchId,
      p_date_from: dateFrom,
      p_date_to:   dateTo
    });
    if (error) throw error;
    const raw = typeof data === 'string' ? JSON.parse(data) : data;
    return raw || [];
  },

  async getInventorySummary({ userId, branchId, date }) {
    const { data, error } = await db.rpc('investor_get_inventory_summary', {
      p_user_id:   userId,
      p_branch_id: branchId,
      p_date:      date
    });
    if (error) throw error;
    const raw = typeof data === 'string' ? JSON.parse(data) : data;
    return raw || [];
  },

  async getInventoryUsage({ userId, branchId, dateFrom, dateTo }) {
    const { data, error } = await db.rpc('investor_get_inventory_usage', {
      p_user_id:   userId,
      p_branch_id: branchId,
      p_date_from: dateFrom,
      p_date_to:   dateTo
    });
    if (error) throw error;
    const raw = typeof data === 'string' ? JSON.parse(data) : data;
    return raw || [];
  }
};
