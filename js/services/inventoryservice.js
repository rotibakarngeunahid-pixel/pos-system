'use strict';

// All stock mutations go through this service.
// Every change writes to branch_inventory AND inventory_logs.
const inventoryService = {

  // ── Core: adjust stock + write log (ATOMIC) ──────────────────
  async adjustStock({ branchId, ingredientId, qty, type, referenceType, referenceId, notes, createdBy }) {
    const { data, error } = await db.rpc('adjust_stock_atomic', {
      p_branch_id: branchId,
      p_ingredient_id: ingredientId,
      p_qty: safeNum(qty, 'Qty Adjust Stock'),
      p_type: type,
      p_reference_type: referenceType || null,
      p_reference_id: referenceId || null,
      p_notes: notes || null,
      p_user_id: createdBy || null
    });
    if (error) throw error;
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

    // Step 3: Collect all ingredient IDs needed and batch-fetch stock levels
    const allIngredientIds = new Set();
    for (const item of cart) {
      const recipeId = recipeMap[item.variantId];
      if (!recipeId) continue;
      for (const ri of (recipeItemsMap[recipeId] || [])) {
        allIngredientIds.add(ri.ingredient_id);
      }
    }

    const stockByIngredient = new Map(); // ingredientId -> stock
    if (allIngredientIds.size > 0) {
      const { data: invRows } = await db
        .from('branch_inventory')
        .select('ingredient_id, stock')
        .eq('branch_id', branchId)
        .in('ingredient_id', [...allIngredientIds]);
      for (const row of (invRows || [])) {
        stockByIngredient.set(row.ingredient_id, parseFloat(row.stock));
      }
    }

    // Step 4: Check sufficiency from in-memory maps
    for (const item of cart) {
      const recipeId = recipeMap[item.variantId];
      if (!recipeId) continue;
      const items = recipeItemsMap[recipeId] || [];
      for (const ri of items) {
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


  // ── Transfer stock between branches (ATOMIC) ─────────────────
  async transferStock({ fromBranchId, toBranchId, ingredientId, qty, notes, userId }) {
    const { error } = await db.rpc('transfer_stock_atomic', {
      p_from_branch: fromBranchId,
      p_to_branch: toBranchId,
      p_ingredient_id: ingredientId,
      p_qty: safeNum(qty, 'Qty Transfer Stock'),
      p_notes: notes || null,
      p_user_id: userId || null
    });
    if (error) throw error;
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
