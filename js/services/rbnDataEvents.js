'use strict';

/**
 * RBNDataEvents — cross-page data change notifications
 *
 * Uses BroadcastChannel (same-origin, multi-tab) with a localStorage fallback
 * for browsers/environments that don't support BroadcastChannel.
 *
 * Usage:
 *   RBNDataEvents.publish('products:changed', { source: 'admin' });
 *   RBNDataEvents.subscribe('products:changed', handler);
 *   RBNDataEvents.unsubscribe('products:changed', handler);
 *
 * Supported events:
 *   products:changed   — produk, varian, branch_products, harga cabang
 *   recipes:changed    — resep atau bahan resep
 *   inventory:changed  — stok, transfer, opname
 *   cash:changed       — kas manual, void kas, setoran
 *   settings:changed   — metode pembayaran, receipt settings
 *   toppings:changed   — topping atau mapping
 */
const RBNDataEvents = (() => {
  const CHANNEL_NAME = 'rbn-data-events';
  const LS_KEY       = 'rbn:data-event';
  const handlers     = {};  // { eventName: Set<fn> }

  let channel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (evt) => _dispatch(evt.data);
    }
  } catch (e) {
    console.warn('[RBNDataEvents] BroadcastChannel not available, using localStorage fallback');
  }

  // localStorage fallback — listen for storage events from other tabs
  if (!channel) {
    window.addEventListener('storage', (e) => {
      if (e.key !== LS_KEY || !e.newValue) return;
      try { _dispatch(JSON.parse(e.newValue)); } catch (_) {}
    });
  }

  function _dispatch(payload) {
    if (!payload?.event) return;
    const fns = handlers[payload.event];
    if (fns) fns.forEach(fn => { try { fn(payload); } catch (e) { console.error('[RBNDataEvents] handler error', e); } });
  }

  return {
    /**
     * Publish a data-change event to all tabs/pages.
     * @param {string} event  e.g. 'products:changed'
     * @param {object} detail  optional additional info
     */
    publish(event, detail = {}) {
      const payload = { event, ts: Date.now(), ...detail };
      if (channel) {
        channel.postMessage(payload);
      } else {
        // Write + immediately delete so next change triggers storage event again
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(payload));
          setTimeout(() => localStorage.removeItem(LS_KEY), 100);
        } catch (_) {}
      }
      // Also dispatch locally (BroadcastChannel does NOT fire in same tab)
      _dispatch(payload);
    },

    /**
     * Subscribe to a data-change event.
     * @param {string}   event
     * @param {Function} fn
     */
    subscribe(event, fn) {
      if (!handlers[event]) handlers[event] = new Set();
      handlers[event].add(fn);
    },

    /**
     * Unsubscribe a handler.
     * @param {string}   event
     * @param {Function} fn
     */
    unsubscribe(event, fn) {
      handlers[event]?.delete(fn);
    },
  };
})();

window.RBNDataEvents = RBNDataEvents;
