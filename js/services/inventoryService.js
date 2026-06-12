'use strict';

// All stock mutations go through this service.
// Every change writes to branch_inventory AND inventory_logs.
const inventoryService = {

  // ── Core: adjust stock + write log (ATOMIC) ──────────────────
  async adjustStock({ branchId, ingredientId, qty, type, referenceType, referenceId, notes, createdBy, reason, evidencePhotoUrl, chronology }) {
    const { data, error } = await db.rpc('adjust_stock_atomic', {
      p_branch_id: branchId,
      p_ingredient_id: ingredientId,
      p_qty: safeNum(qty, 'Qty Adjust Stock'),
      p_type: type,
      p_reference_type: referenceType || null,
      p_reference_id: referenceId || null,
      p_notes: notes || null,
      p_user_id: createdBy || null,
      p_reason: reason || null,
      p_evidence_photo_url: evidencePhotoUrl || null,
      p_chronology: chronology || null
    });
    if (error) throw new Error(error.message || 'Penyesuaian stok gagal di server');
    return { stockBefore: data.stock_before, stockAfter: data.stock_after };
  },

  // ── Pre-checkout stock validation (FULLY BATCHED: 3 queries total) ──────────
  async checkBOMStock({ cart, branchId }) {
    const insufficient = [];
    if (!cart?.length) return { ok: true, insufficient };

    // Step 1: Batch fetch ALL recipes for all variant IDs in cart at once
    const variantIds = cart.map(item => item.variantId);
    const { data: allRecipes } = await db
      .from('recipes').select('id, variant_id')
      .in('variant_id', variantIds);

    const recipeMap = {}; // variantId -> recipeId
    for (const r of (allRecipes || [])) {
      recipeMap[r.variant_id] = r.id;
    }

    const recipeIds = Object.values(recipeMap);
    if (!recipeIds.length) return { ok: true, insufficient };

    // Step 2: Batch fetch ALL recipe_items for all recipe IDs at once
    const { data: allRecipeItems } = await db
      .from('recipe_items')
      .select('recipe_id, ingredient_id, quantity, ingredients(name, unit)')
      .in('recipe_id', recipeIds);

    const recipeItemsMap = {}; // recipeId -> [items]
    for (const ri of (allRecipeItems || [])) {
      if (!recipeItemsMap[ri.recipe_id]) recipeItemsMap[ri.recipe_id] = [];
      recipeItemsMap[ri.recipe_id].push(ri);
    }

    // Step 3: Collect all ingredient IDs needed, fetch stock + branch assignments
    const allIngredientIds = new Set();
    for (const item of cart) {
      const recipeId = recipeMap[item.variantId];
      if (!recipeId) continue;
      for (const ri of (recipeItemsMap[recipeId] || [])) {
        allIngredientIds.add(ri.ingredient_id);
      }
    }

    const stockByIngredient = new Map(); // ingredientId -> stock
    const assignMap = new Map();         // ingredientId -> Set<branchId>
    if (allIngredientIds.size > 0) {
      const [invRes, assignRes] = await Promise.all([
        db.from('branch_inventory')
          .select('ingredient_id, stock')
          .eq('branch_id', branchId)
          .in('ingredient_id', [...allIngredientIds]),
        db.from('branch_ingredient_assignments')
          .select('ingredient_id, branch_id')
          .in('ingredient_id', [...allIngredientIds])
      ]);
      for (const row of (invRes.data || [])) {
        stockByIngredient.set(row.ingredient_id, parseFloat(row.stock));
      }
      for (const a of (assignRes.data || [])) {
        if (!assignMap.has(a.ingredient_id)) assignMap.set(a.ingredient_id, new Set());
        assignMap.get(a.ingredient_id).add(a.branch_id);
      }
    }

    // Step 4: Check sufficiency — skip ingredients not assigned to this branch
    for (const item of cart) {
      const recipeId = recipeMap[item.variantId];
      if (!recipeId) continue;
      const items = recipeItemsMap[recipeId] || [];
      for (const ri of items) {
        // Hormati branch assignment: jika di-assign ke cabang lain, abaikan
        const assigns = assignMap.get(ri.ingredient_id);
        if (assigns && !assigns.has(branchId)) continue;

        const needed    = ri.quantity * item.quantity;
        const available = stockByIngredient.get(ri.ingredient_id) ?? 0;
        if (available < needed) {
          insufficient.push({
            item:       item.productName,
            variant:    item.variantName,
            ingredient: ri.ingredients?.name || '?',
            unit:       ri.ingredients?.unit || '',
            needed,
            available
          });
        }
      }
    }

    return { ok: insufficient.length === 0, insufficient };
  },


  // ── [LEGACY] Transfer langsung antar cabang (masih dipakai untuk kompatibilitas) ──
  async transferStock({ fromBranchId, toBranchId, ingredientId, qty, notes, userId }) {
    const { error } = await db.rpc('transfer_stock_atomic', {
      p_from_branch: fromBranchId,
      p_to_branch: toBranchId,
      p_ingredient_id: ingredientId,
      p_qty: safeNum(qty, 'Qty Transfer Stock'),
      p_notes: notes || null,
      p_user_id: userId || null
    });
    if (error) throw new Error(error.message || 'Transfer stok gagal di server');
  },

  // ── Transfer v2: Buat permintaan transfer (stok pengirim berkurang, status pending) ──
  async createStockTransfer({ fromBranchId, toBranchId, items, notes, userId }) {
    const { data, error } = await db.rpc('create_stock_transfer', {
      p_from_branch_id: fromBranchId,
      p_to_branch_id:   toBranchId,
      p_items:          items,   // [{ingredient_id, qty}, ...]
      p_notes:          notes || null,
      p_user_id:        userId
    });
    if (error) throw new Error(error.message || 'Gagal membuat transfer');
    if (!data?.success) throw new Error(data?.error || 'Gagal membuat transfer');
    return { transferId: data.transfer_id, transferCode: data.transfer_code };
  },

  // ── Transfer v2: Outlet penerima menerima barang ─────────────
  async confirmTransfer({ transferId, userId }) {
    const { data, error } = await db.rpc('confirm_stock_transfer', {
      p_transfer_id: transferId,
      p_user_id:     userId
    });
    if (error) throw new Error(error.message || 'Gagal konfirmasi transfer');
    if (!data?.success) throw new Error(data?.error || 'Gagal konfirmasi transfer');
    return data.transfer_code;
  },

  // ── Transfer v2: Outlet penerima menolak barang ───────────────
  async rejectTransfer({ transferId, userId, reason }) {
    const { data, error } = await db.rpc('reject_stock_transfer', {
      p_transfer_id: transferId,
      p_user_id:     userId,
      p_reason:      reason || null
    });
    if (error) throw new Error(error.message || 'Gagal menolak transfer');
    if (!data?.success) throw new Error(data?.error || 'Gagal menolak transfer');
    return data.transfer_code;
  },

  // ── Transfer v2: Pengirim membatalkan sebelum diterima ────────
  async cancelTransfer({ transferId, userId }) {
    const { data, error } = await db.rpc('cancel_stock_transfer', {
      p_transfer_id: transferId,
      p_user_id:     userId
    });
    if (error) throw new Error(error.message || 'Gagal membatalkan transfer');
    if (!data?.success) throw new Error(data?.error || 'Gagal membatalkan transfer');
    return data.transfer_code;
  },

  // ── Transfer v2: Daftar transfer masuk yang menunggu konfirmasi ──
  async getPendingTransfers(branchId) {
    const { data, error } = await db.rpc('get_pending_transfers', { p_branch_id: branchId });
    if (error) throw new Error(error.message || 'Gagal memuat transfer masuk');
    return Array.isArray(data) ? data : [];
  },

  // ── Transfer v2: Riwayat transfer untuk satu outlet ──────────
  async getTransferHistory(branchId, limit = 50, offset = 0) {
    const { data, error } = await db.rpc('get_transfer_history', {
      p_branch_id: branchId,
      p_limit:     limit,
      p_offset:    offset
    });
    if (error) throw new Error(error.message || 'Gagal memuat riwayat transfer');
    return Array.isArray(data) ? data : [];
  },

  // ── Transfer v2: Admin melihat semua transfer ─────────────────
  async getAllTransfersAdmin(limit = 100, offset = 0, status = null) {
    const { data, error } = await db.rpc('get_all_transfers_admin', {
      p_limit:  limit,
      p_offset: offset,
      p_status: status || null
    });
    if (error) throw new Error(error.message || 'Gagal memuat semua transfer');
    return Array.isArray(data) ? data : [];
  },

  // ── Receive purchase order → add stock ────────────────────────
  async receivePurchase({ purchaseId, items, branchId, userId }) {
    for (const item of items) {
      await this.adjustStock({
        branchId,
        ingredientId:  item.ingredient_id,
        qty:           safeNum(item.quantity, 'Qty Purchase'),
        type:          'in',
        referenceType: 'purchase',
        referenceId:   purchaseId,
        notes:         `Purchase Order #${purchaseId}`,
        createdBy:     userId
      });
    }
  }
};
