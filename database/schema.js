'use strict';

/**
 * database/schema.js
 *
 * SQLite database layer for PeopleHR using sql.js (WebAssembly SQLite).
 *
 * The database is persisted to hrms.db on disk. On startup, initDb() loads
 * the file if it exists, otherwise it creates a fresh in-memory database and
 * runs all CREATE TABLE statements. saveDb() writes the current state back to
 * hrms.db.
 *
 * Exported helpers wrap the sql.js API so that server.js can call them
 * synchronously after the one-time async initialisation:
 *
 *   getDb()   – async, returns the live Database instance
 *   initDb()  – async, initialises / loads the database (called once at boot)
 *   saveDb()  – sync, persists the database to disk
 *   all(db, sql, params)  – SELECT returning all rows as plain objects
 *   get(db, sql, params)  – SELECT returning the first row (or null)
 *   lastId(db)            – returns the last inserted row id (integer)
 */

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'hrms.db');

let _db  = null;   // sql.js Database instance
let _SQL = null;   // sql.js constructor namespace

// ── SCHEMA ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  start_time    TEXT    NOT NULL DEFAULT '09:00',
  end_time      TEXT    NOT NULL DEFAULT '18:00',
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  half_day_hours REAL   NOT NULL DEFAULT 4,
  work_days     TEXT    NOT NULL DEFAULT 'Mon-Fri'
);

CREATE TABLE IF NOT EXISTS employees (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no          TEXT    NOT NULL UNIQUE,
  first_name      TEXT    NOT NULL,
  last_name       TEXT    NOT NULL,
  email           TEXT    NOT NULL UNIQUE,
  phone           TEXT    DEFAULT '',
  department      TEXT    DEFAULT '',
  role            TEXT    DEFAULT '',
  employment_type TEXT    DEFAULT 'Full-time',
  join_date       TEXT    DEFAULT '',
  basic_salary    REAL    DEFAULT 0,
  status          TEXT    DEFAULT 'Active',
  report_to       INTEGER REFERENCES employees(id),
  shift_id        INTEGER REFERENCES shifts(id),
  created_at      TEXT    DEFAULT (datetime('now')),
  updated_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER REFERENCES employees(id),
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'employee',
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS attendance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  date           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'Present',
  check_in       TEXT    DEFAULT '',
  check_out      TEXT    DEFAULT '',
  worked_seconds INTEGER DEFAULT 0,
  note           TEXT    DEFAULT '',
  updated_at     TEXT    DEFAULT (datetime('now')),
  UNIQUE(employee_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  date           TEXT    NOT NULL,
  clock_in_at    TEXT,
  clock_out_at   TEXT,
  worked_seconds INTEGER DEFAULT 0,
  UNIQUE(employee_id, date)
);

CREATE TABLE IF NOT EXISTS regularizations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  date          TEXT    NOT NULL,
  requested_in  TEXT    DEFAULT '',
  requested_out TEXT    DEFAULT '',
  reason        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'Pending',
  reviewed_by   TEXT    DEFAULT '',
  reviewed_on   TEXT,
  created_at    TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holidays (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  date  TEXT    NOT NULL UNIQUE,
  name  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_policy (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  leave_type    TEXT    NOT NULL UNIQUE,
  days_per_year INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type  TEXT    NOT NULL DEFAULT 'Casual',
  from_date   TEXT    NOT NULL,
  to_date     TEXT    NOT NULL,
  days        REAL    NOT NULL DEFAULT 1,
  reason      TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'Pending',
  applied_on  TEXT    DEFAULT (date('now')),
  approved_by TEXT    DEFAULT '',
  approved_on TEXT,
  updated_at  TEXT    DEFAULT (datetime('now')),
  created_at  TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id        INTEGER NOT NULL REFERENCES employees(id),
  month              TEXT    NOT NULL,
  basic              REAL    DEFAULT 0,
  hra                REAL    DEFAULT 0,
  travel_allowance   REAL    DEFAULT 0,
  special_allowance  REAL    DEFAULT 0,
  gross              REAL    DEFAULT 0,
  pf_deduction       REAL    DEFAULT 0,
  esi_deduction      REAL    DEFAULT 0,
  tds_deduction      REAL    DEFAULT 0,
  net_pay            REAL    DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'Draft',
  processed_by       TEXT    DEFAULT '',
  processed_on       TEXT,
  updated_at         TEXT    DEFAULT (datetime('now')),
  UNIQUE(employee_id, month)
);

CREATE TABLE IF NOT EXISTS company_settings (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Default leave policy rows (ignored if already present)
INSERT OR IGNORE INTO leave_policy(leave_type, days_per_year) VALUES
  ('Casual',   12),
  ('Sick',     12),
  ('Earned',   15),
  ('Maternity',180),
  ('Paternity', 5);

-- Default company settings (ignored if already present)
INSERT OR IGNORE INTO company_settings(key, value) VALUES
  ('company_name',          'PeopleHR'),
  ('pf_rate',               '12'),
  ('tds_rate',              '10'),
  ('esi_rate',              '0.75'),
  ('working_hours_per_day', '8');
`;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Execute a SELECT query and return all rows as an array of plain objects.
 * @param {import('sql.js').Database} db
 * @param {string} sql
 * @param {Array} [params=[]]
 * @returns {Array<Object>}
 */
function all(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    throw e;
  }
}

/**
 * Execute a SELECT query and return the first row as a plain object, or null.
 * @param {import('sql.js').Database} db
 * @param {string} sql
 * @param {Array} [params=[]]
 * @returns {Object|null}
 */
function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Return the rowid of the last successful INSERT on this database connection.
 * @param {import('sql.js').Database} db
 * @returns {number}
 */
function lastId(db) {
  const row = get(db, 'SELECT last_insert_rowid() AS id');
  return row ? row.id : null;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Initialise the database. Loads hrms.db from disk if it exists, otherwise
 * creates a fresh in-memory database and applies the schema.
 * Must be awaited once before any other database call.
 */
async function initDb() {
  // sql.js ships its own WASM binary; locate it relative to node_modules.
  const initSqlJs = require('sql.js');

  _SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_PATH);
      _db = new _SQL.Database(fileBuffer);
      // Still run schema so new tables/defaults are added on upgrades.
      _db.run(SCHEMA_SQL);
      console.log(`[db] Loaded existing database from ${DB_PATH}`);
    } catch (e) {
      console.warn(`[db] Could not load ${DB_PATH}, creating fresh database. (${e.message})`);
      _db = new _SQL.Database();
      _db.run(SCHEMA_SQL);
    }
  } else {
    _db = new _SQL.Database();
    _db.run(SCHEMA_SQL);
    console.log('[db] Created new in-memory database');
    // Persist immediately so the file exists for future restarts.
    _saveToFile();
  }

  // Patch db.run so it accepts (sql, params) the same way server.js calls it.
  // sql.js's native db.run(sql, params) already matches this signature, but we
  // wrap it to surface errors clearly and keep the interface consistent.
  const _nativeRun = _db.run.bind(_db);
  _db.run = function (sql, params) {
    try {
      return _nativeRun(sql, params || []);
    } catch (e) {
      // Re-throw so callers can catch UNIQUE constraint violations etc.
      throw e;
    }
  };
}

/**
 * Return the live Database instance. Async for API compatibility with server.js
 * (which uses `await getDb()`), but resolves synchronously after initDb().
 * @returns {Promise<import('sql.js').Database>}
 */
async function getDb() {
  if (!_db) throw new Error('Database not initialised. Call initDb() first.');
  return _db;
}

/**
 * Persist the current in-memory database state to hrms.db on disk.
 */
function saveDb() {
  _saveToFile();
}

function _saveToFile() {
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    // Write atomically via a temp file to avoid corruption on crash.
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[db] Failed to save database:', e.message);
  }
}

module.exports = { getDb, initDb, saveDb, all, get, lastId };
