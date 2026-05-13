'use strict';

/**
 * Safely parse a number from a string, throwing an error if it is invalid.
 * @param {any} x - The value to parse.
 * @param {string} label - A label to include in the error message if parsing fails.
 * @returns {number}
 */
function safeNum(x, label = 'Nilai') {
  const n = Number(x);
  if (Number.isNaN(n)) {
    throw new Error(`${label}: tidak valid ("${x}")`);
  }
  return n;
}

/**
 * Safely get a DOM element by ID, throwing an error if it is not found.
 * @param {string} id - The DOM element ID.
 * @param {boolean} required - Whether to throw an error if the element is not found.
 * @returns {HTMLElement | null}
 */
function el(id, required = true) {
  const node = document.getElementById(id);
  if (!node && required) {
    throw new Error(`[DOM] Element #${id} tidak ditemukan`);
  }
  return node;
}

window.safeNum = safeNum;
window.el = el;
