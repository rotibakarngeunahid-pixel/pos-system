// ── RBN POS — API Client (cPanel/MySQL)
// Menggantikan Supabase SDK, interface tetap sama persis
// ─────────────────────────────────────────────────────────────────────────────

// GANTI dua baris ini dengan URL dan key dari config.php Anda
const API_BASE = 'https://pos.rotibakarngeunah.my.id/api/api.php';
const API_KEY  = 'rbn2026xK9mPqL3vWnHjRtYcBfDsAeUo'; // harus sama persis dengan config.php

// ─────────────────────────────────────────────────────────────────────────────

class QueryBuilder {
  constructor(table) {
    this._table       = table;
    this._select      = '*';
    this._filters     = [];
    this._order       = [];
    this._limit       = null;
    this._offset      = null;
    this._single      = false;
    this._maybeSingle = false;
    this._method      = 'GET';
    this._body        = null;
    this._count       = null;
    this._head        = false;
    this._or          = [];
  }

  select(cols = '*', opts = {}) {
    this._select = cols;
    if (opts.count) this._count = opts.count;
    if (opts.head)  this._head  = true;
    return this;
  }

  eq(col, val)     { this._filters.push({ col, op: 'eq',   val }); return this; }
  neq(col, val)    { this._filters.push({ col, op: 'neq',  val }); return this; }
  gt(col, val)     { this._filters.push({ col, op: 'gt',   val }); return this; }
  gte(col, val)    { this._filters.push({ col, op: 'gte',  val }); return this; }
  lt(col, val)     { this._filters.push({ col, op: 'lt',   val }); return this; }
  lte(col, val)    { this._filters.push({ col, op: 'lte',  val }); return this; }
  like(col, val)   { this._filters.push({ col, op: 'like', val }); return this; }
  ilike(col, val)  { this._filters.push({ col, op: 'ilike',val }); return this; }
  is(col, val)     { this._filters.push({ col, op: 'is',   val: val === null ? 'null' : val }); return this; }

  or(expr) {
    if (expr) this._or.push(String(expr).replace(/^\((.*)\)$/, '$1'));
    return this;
  }

  not(col, op, val) {
    if (op === 'is' && val === null) {
      this._filters.push({ col, op: 'not.is', val: 'null' });
    } else {
      this._filters.push({ col, op: `not.${op}`, val });
    }
    return this;
  }

  in(col, vals) {
    this._filters.push({ col, op: 'in', val: `(${vals.join(',')})` });
    return this;
  }

  order(col, { ascending = true } = {}) {
    this._order.push(`${col}.${ascending ? 'asc' : 'desc'}`);
    return this;
  }

  limit(n)  { this._limit  = n; return this; }
  offset(n) { this._offset = n; return this; }

  single()      { this._single      = true; return this._run(); }
  maybeSingle() { this._maybeSingle = true; return this._run(); }

  insert(data) { this._method = 'POST';  this._body = data; return this; }
  upsert(data, opts = {}) {
    this._method = 'PUT';
    this._body   = { data, opts };
    return this;
  }
  update(data) { this._method = 'PATCH'; this._body = data; return this; }
  delete()     { this._method = 'DELETE'; return this; }

  // Thenable — allows `await db.from(t).select().eq(...)` without explicit .then()
  then(resolve, reject) { return this._run().then(resolve, reject); }

  _buildUrl() {
    const url = new URL(`${API_BASE}/${this._table}`);
    url.searchParams.set('select', this._select);

    // Use append() so multiple filters on the same column (e.g. gte + lte on
    // created_at) are both sent — set() would silently overwrite the first.
    for (const f of this._filters) {
      url.searchParams.append(f.col, `${f.op}.${f.val}`);
    }
    if (this._or.length) url.searchParams.set('_or', this._or.join(','));
    if (this._order.length)  url.searchParams.set('order',  this._order.join(','));
    if (this._limit  !== null) url.searchParams.set('limit',  String(this._limit));
    if (this._offset !== null) url.searchParams.set('offset', String(this._offset));
    if (this._single)          url.searchParams.set('_single', '1');
    if (this._maybeSingle)     url.searchParams.set('_maybe_single', '1');
    if (this._head)            url.searchParams.set('_head', '1');
    if (this._count)           url.searchParams.set('_count', this._count);
    return url.toString();
  }

  async _run() {
    const opts = {
      method:  this._method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    API_KEY,
      },
    };
    if (this._body !== null) opts.body = JSON.stringify(this._body);

    try {
      const res  = await fetch(this._buildUrl(), opts);
      const json = await res.json();

      if (!res.ok) {
        return { data: null, error: json?.error ?? { message: 'Request gagal', code: res.status } };
      }

      // count-only head request
      if (this._head && this._count) {
        const range = res.headers.get('Content-Range') ?? '';
        const count = parseInt(range.split('/')[1] ?? '0', 10);
        return { data: null, count, error: null };
      }

      return { data: json, error: null, count: json?._count ?? null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }
}

// ── Main db object — drop-in replacement for Supabase client ─────────────────
const db = {
  from(table) {
    return new QueryBuilder(table);
  },

  async rpc(name, params = {}) {
    try {
      const res  = await fetch(`${API_BASE}/rpc/${name}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body:    JSON.stringify(params),
      });
      const json = await res.json();
      if (!res.ok) {
        return { data: null, error: json?.error ?? { message: 'RPC gagal', code: res.status } };
      }
      return { data: json, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  },
};
