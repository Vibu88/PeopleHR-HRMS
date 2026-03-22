const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'hrms.db');
let _db = null;
let SQL = null;

async function getDb() {
  if (_db) return _db;
  if (!SQL) {
    SQL = await require('sql.js')();
  }
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  _db.run('PRAGMA foreign_keys = ON;');
  return _db;
}

function saveDb() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function all(db, sql, p = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(p);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) { console.error('DB all:', e.message); return []; }
}

function get(db, sql, p = []) { return all(db, sql, p)[0] || null; }
function lastId(db) { return (get(db, 'SELECT last_insert_rowid() as id') || {}).id || null; }

async function initDb() {
  const db = await getDb();

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER UNIQUE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'employee',
    is_active INTEGER DEFAULT 1,
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_no TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, phone TEXT,
    department TEXT NOT NULL, role TEXT NOT NULL,
    employment_type TEXT DEFAULT 'Full-time', join_date TEXT,
    basic_salary REAL DEFAULT 0, status TEXT DEFAULT 'Active',
    report_to INTEGER, shift_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    start_time TEXT DEFAULT '09:00', end_time TEXT DEFAULT '18:00',
    grace_minutes INTEGER DEFAULT 15, half_day_hours REAL DEFAULT 4,
    work_days TEXT DEFAULT 'Mon-Fri', created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    date TEXT NOT NULL, status TEXT DEFAULT 'Absent',
    check_in TEXT, check_out TEXT, worked_seconds INTEGER DEFAULT 0, note TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(employee_id, date)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    date TEXT NOT NULL, clock_in_at TEXT, clock_out_at TEXT,
    worked_seconds INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(employee_id, date)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS regularizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    date TEXT NOT NULL, requested_in TEXT, requested_out TEXT, reason TEXT,
    status TEXT DEFAULT 'Pending', reviewed_by TEXT,
    submitted_on TEXT DEFAULT (date('now')), reviewed_on TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    leave_type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL,
    days INTEGER NOT NULL, reason TEXT, status TEXT DEFAULT 'Pending',
    applied_on TEXT DEFAULT (date('now')), approved_by TEXT, approved_on TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS leave_policy (
    id INTEGER PRIMARY KEY AUTOINCREMENT, leave_type TEXT UNIQUE NOT NULL,
    days_per_year INTEGER NOT NULL, carry_forward INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payroll (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    month TEXT NOT NULL, basic REAL DEFAULT 0, hra REAL DEFAULT 0,
    travel_allowance REAL DEFAULT 0, special_allowance REAL DEFAULT 0,
    gross REAL DEFAULT 0, pf_deduction REAL DEFAULT 0, esi_deduction REAL DEFAULT 0,
    tds_deduction REAL DEFAULT 0, net_pay REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft', processed_by TEXT, processed_on TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(employee_id, month)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS company_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  for (const [k,v] of [['company_name','My Company'],['pf_rate','12'],['esi_rate','0.75'],['tds_rate','10'],['working_hours_per_day','9']]) {
    db.run(`INSERT OR IGNORE INTO company_settings(key,value) VALUES(?,?)`, [k,v]);
  }
  for (const [t,d] of [['Casual',12],['Sick',10],['Earned',15]]) {
    db.run(`INSERT OR IGNORE INTO leave_policy(leave_type,days_per_year) VALUES(?,?)`, [t,d]);
  }
  const shiftExists = get(db, `SELECT id FROM shifts LIMIT 1`);
  if (!shiftExists) {
    db.run(`INSERT INTO shifts(name,start_time,end_time,grace_minutes,half_day_hours,work_days) VALUES(?,?,?,?,?,?)`,
      ['General','09:00','18:00',15,4,'Mon-Fri']);
  }

  saveDb();
  console.log('Database ready:', DB_PATH);
}

module.exports = { getDb, initDb, saveDb, all, get, lastId };
