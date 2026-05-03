'use strict';

const validator = {
  required(val, label) {
    if (val === null || val === undefined || String(val).trim() === '')
      throw new Error(`${label} wajib diisi`);
    return val;
  },

  positiveNum(val, label) {
    const n = Number(val);
    if (Number.isNaN(n) || n <= 0) throw new Error(`${label} harus lebih dari 0`);
    return n;
  },

  nonNegativeNum(val, label) {
    const n = Number(val);
    if (Number.isNaN(n) || n < 0) throw new Error(`${label} tidak boleh negatif`);
    return n;
  },

  maxLength(val, max, label) {
    if (String(val || '').length > max)
      throw new Error(`${label} maksimal ${max} karakter`);
    return val;
  }
};
