const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb, initDb, saveDb, all, get, lastId } = require('./database/schema');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'peoplehr_secret_2024_change_in_production';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    next();
  };
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function calcSalary(basic, pfRate=12, tdsRate=10) {
  const hra=Math.round(basic*.4),ta=2000,special=Math.round(basic*.1);
  const gross=basic+hra+ta+special,pf=Math.round(basic*(pfRate/100));
  const esi=gross<=21000?Math.round(gross*.0075):0;
  const tds=Math.round((gross-pf-esi)*(tdsRate/100)/12);
  return{hra,ta,special,gross,pf_deduction:pf,esi_deduction:esi,tds_deduction:tds,net_pay:gross-pf-esi-tds};
}

function getSettings(db) {
  return Object.fromEntries(all(db,'SELECT key,value FROM company_settings').map(r=>[r.key,r.value]));
}

const ok = (res,data,status=200) => res.status(status).json({success:true,data});
const err = (res,msg,status=400) => res.status(status).json({success:false,error:msg});
const todayStr = () => new Date().toISOString().split('T')[0];
const nowStr = () => new Date().toISOString();

// ── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Check if any admin account exists (used by frontend to decide: show Register or Login)
app.get('/api/auth/check-setup', async (req, res) => {
  const db = await getDb();
  const admin = get(db, `SELECT id FROM users WHERE role='admin' LIMIT 1`);
  ok(res, { setup_done: !!admin });
});

// Register first admin — only works if NO admin exists yet
app.post('/api/auth/register', async (req, res) => {
  const db = await getDb();
  const existing = get(db, `SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (existing) return err(res, 'Setup already complete. Please login.', 403);
  const { company_name, first_name, last_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password) return err(res, 'All fields required');
  if (password.length < 6) return err(res, 'Password must be at least 6 characters');
  // Save company name
  if (company_name) db.run(`INSERT OR REPLACE INTO company_settings(key,value) VALUES('company_name',?)`, [company_name]);
  // Create employee record for the admin
  const empNo = 'EMP001';
  try {
    db.run(`INSERT INTO employees(emp_no,first_name,last_name,email,department,role,employment_type,status,shift_id) VALUES(?,?,?,?,'HR','HR Admin','Full-time','Active',1)`,
      [empNo, first_name, last_name, email.toLowerCase()]);
    const empId = lastId(db);
    // Create default shift if none exists
    const shiftExists = get(db, `SELECT id FROM shifts LIMIT 1`);
    if (!shiftExists) {
      db.run(`INSERT INTO shifts(name,start_time,end_time,grace_minutes,half_day_hours,work_days) VALUES('General','09:00','18:00',15,4,'Mon-Fri')`);
    }
    db.run(`INSERT INTO users(employee_id,email,password_hash,role) VALUES(?,?,?,'admin')`,
      [empId, email.toLowerCase(), bcrypt.hashSync(password, 10)]);
    saveDb();
    const payload = { userId: lastId(db), empId, role: 'admin', email: email.toLowerCase(), name: `${first_name} ${last_name}`, emp_no: empNo };
    const token = jwt.sign(payload, JWT_SECRET);
    ok(res, { token, user: payload }, 201);
  } catch(e) { err(res, 'Email already registered'); }
});

app.post('/api/auth/login', async (req, res) => {
  const db = await getDb();
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'Email and password required');
  const user = get(db, `SELECT u.*, e.first_name, e.last_name, e.emp_no, e.department, e.id as emp_id,
    e.basic_salary, e.role as job_title, e.shift_id, e.report_to
    FROM users u LEFT JOIN employees e ON u.employee_id=e.id WHERE u.email=?`, [email.toLowerCase().trim()]);
  if (!user) return err(res, 'Invalid email or password', 401);
  if (!user.is_active) return err(res, 'Account is deactivated. Contact HR.', 401);
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return err(res, 'Invalid email or password', 401);
  db.run(`UPDATE users SET last_login=datetime('now') WHERE id=?`, [user.id]);
  saveDb();
  const payload = {
    userId: user.id, empId: user.employee_id, role: user.role,
    email: user.email, name: `${user.first_name} ${user.last_name}`,
    emp_no: user.emp_no, department: user.department, job_title: user.job_title,
    shift_id: user.shift_id, report_to: user.report_to
  };
  const token = jwt.sign(payload, JWT_SECRET);
  ok(res, { token, user: payload });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const db = await getDb();
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return err(res, 'Both passwords required');
  if (new_password.length < 6) return err(res, 'New password must be at least 6 characters');
  const user = get(db, `SELECT * FROM users WHERE id=?`, [req.user.userId]);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return err(res, 'Current password incorrect');
  db.run(`UPDATE users SET password_hash=? WHERE id=?`, [bcrypt.hashSync(new_password, 10), req.user.userId]);
  saveDb();
  ok(res, { message: 'Password changed successfully' });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const db = await getDb();
  const emp = get(db, `SELECT e.*, s.name as shift_name, s.start_time, s.end_time FROM employees e LEFT JOIN shifts s ON e.shift_id=s.id WHERE e.id=?`, [req.user.empId]);
  ok(res, { ...req.user, employee: emp });
});

// ── USER MANAGEMENT (Admin only) ─────────────────────────────────────────────

app.get('/api/users', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const users = all(db, `SELECT u.id, u.email, u.role, u.is_active, u.last_login, u.employee_id,
    e.first_name, e.last_name, e.emp_no, e.department FROM users u LEFT JOIN employees e ON u.employee_id=e.id ORDER BY u.id`);
  ok(res, users);
});

app.post('/api/users', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const { employee_id, email, password, role } = req.body;
  if (!email || !password) return err(res, 'Email and password required');
  if (password.length < 6) return err(res, 'Password must be at least 6 characters');
  try {
    db.run(`INSERT INTO users(employee_id,email,password_hash,role) VALUES(?,?,?,?)`,
      [employee_id||null, email.toLowerCase(), bcrypt.hashSync(password, 10), role||'employee']);
    const id = lastId(db); saveDb();
    ok(res, get(db, `SELECT id,email,role,is_active,employee_id FROM users WHERE id=?`, [id]), 201);
  } catch(e) { err(res, 'Email already exists'); }
});

app.put('/api/users/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const { role, is_active, password } = req.body;
  if (password) {
    if (password.length < 6) return err(res, 'Password must be at least 6 characters');
    db.run(`UPDATE users SET password_hash=? WHERE id=?`, [bcrypt.hashSync(password, 10), req.params.id]);
  }
  if (role) db.run(`UPDATE users SET role=? WHERE id=?`, [role, req.params.id]);
  if (is_active !== undefined) db.run(`UPDATE users SET is_active=? WHERE id=?`, [is_active?1:0, req.params.id]);
  saveDb();
  ok(res, get(db, `SELECT id,email,role,is_active,employee_id FROM users WHERE id=?`, [req.params.id]));
});

// ── EMPLOYEES ────────────────────────────────────────────────────────────────

app.get('/api/employees', authMiddleware, async (req, res) => {
  const db = await getDb();
  const { q, dept, status } = req.query;
  let sql = `SELECT e.*, s.name as shift_name, s.start_time, s.end_time,
    (e.first_name||' '||e.last_name) as full_name,
    (r.first_name||' '||r.last_name) as reports_to_name,
    u.role as user_role, u.is_active as account_active
    FROM employees e LEFT JOIN shifts s ON e.shift_id=s.id
    LEFT JOIN employees r ON e.report_to=r.id
    LEFT JOIN users u ON u.employee_id=e.id WHERE 1=1`;
  const params = [];

  // Employees can only see basic info of colleagues; managers see their team
  if (req.user.role === 'employee') {
    sql += ` AND e.id=?`; params.push(req.user.empId);
  } else if (req.user.role === 'manager') {
    sql += ` AND (e.id=? OR e.report_to=?)`; params.push(req.user.empId, req.user.empId);
  } else {
    if (q) { sql += ` AND (e.first_name||' '||e.last_name LIKE ? OR e.emp_no LIKE ? OR e.email LIKE ? OR e.department LIKE ?)`; const w=`%${q}%`; params.push(w,w,w,w); }
    if (dept) { sql += ` AND e.department=?`; params.push(dept); }
    if (status) { sql += ` AND e.status=?`; params.push(status); }
  }
  sql += ` ORDER BY e.id`;
  ok(res, all(db, sql, params));
});

app.get('/api/employees/stats/summary', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const total = get(db,`SELECT COUNT(*) as c FROM employees`).c;
  const active = get(db,`SELECT COUNT(*) as c FROM employees WHERE status='Active'`).c;
  const depts = get(db,`SELECT COUNT(DISTINCT department) as c FROM employees`).c;
  const avgSal = (get(db,`SELECT AVG(basic_salary) as a FROM employees`)||{}).a||0;
  ok(res, { total, active, departments: depts, avg_salary: Math.round(avgSal) });
});

app.get('/api/employees/:id', authMiddleware, async (req, res) => {
  const db = await getDb();
  // Employees can only view their own profile
  if (req.user.role === 'employee' && req.user.empId != req.params.id) return err(res,'Access denied',403);
  const emp = get(db, `SELECT e.*, s.name as shift_name, s.start_time, s.end_time, s.grace_minutes,
    (r.first_name||' '||r.last_name) as reports_to_name
    FROM employees e LEFT JOIN shifts s ON e.shift_id=s.id LEFT JOIN employees r ON e.report_to=r.id WHERE e.id=?`, [req.params.id]);
  if (!emp) return err(res,'Not found',404);
  ok(res, emp);
});

app.post('/api/employees', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {emp_no,first_name,last_name,email,phone,department,role,employment_type,join_date,basic_salary,status,report_to,shift_id} = req.body;
  if (!emp_no||!first_name||!last_name||!email) return err(res,'emp_no, first_name, last_name, email required');
  try {
    db.run(`INSERT INTO employees(emp_no,first_name,last_name,email,phone,department,role,employment_type,join_date,basic_salary,status,report_to,shift_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [emp_no,first_name,last_name,email,phone||'',department,role,employment_type||'Full-time',join_date||'',basic_salary||0,status||'Active',report_to||null,shift_id||1]);
    const id=lastId(db); saveDb();
    ok(res, get(db,`SELECT * FROM employees WHERE id=?`,[id]), 201);
  } catch(e) { err(res, e.message.includes('UNIQUE')?'Emp no or email already exists':e.message); }
});

app.put('/api/employees/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {emp_no,first_name,last_name,email,phone,department,role,employment_type,join_date,basic_salary,status,report_to,shift_id} = req.body;
  try {
    db.run(`UPDATE employees SET emp_no=?,first_name=?,last_name=?,email=?,phone=?,department=?,role=?,employment_type=?,join_date=?,basic_salary=?,status=?,report_to=?,shift_id=?,updated_at=datetime('now') WHERE id=?`,
      [emp_no,first_name,last_name,email,phone||'',department,role,employment_type,join_date||'',basic_salary,status,report_to||null,shift_id||1,req.params.id]);
    saveDb(); ok(res, get(db,`SELECT * FROM employees WHERE id=?`,[req.params.id]));
  } catch(e) { err(res, e.message); }
});

app.delete('/api/employees/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  db.run(`DELETE FROM employees WHERE id=?`,[req.params.id]); saveDb();
  ok(res, {deleted:true});
});

// ── SHIFTS ───────────────────────────────────────────────────────────────────

app.get('/api/shifts', authMiddleware, async (req, res) => {
  const db = await getDb();
  ok(res, all(db,`SELECT s.*, COUNT(e.id) as employee_count FROM shifts s LEFT JOIN employees e ON e.shift_id=s.id GROUP BY s.id ORDER BY s.id`));
});

app.post('/api/shifts', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {name,start_time,end_time,grace_minutes,half_day_hours,work_days} = req.body;
  if (!name) return err(res,'Name required');
  db.run(`INSERT INTO shifts(name,start_time,end_time,grace_minutes,half_day_hours,work_days) VALUES(?,?,?,?,?,?)`,
    [name,start_time||'09:00',end_time||'18:00',grace_minutes||15,half_day_hours||4,work_days||'Mon-Fri']);
  const id=lastId(db); saveDb();
  ok(res, get(db,`SELECT * FROM shifts WHERE id=?`,[id]),201);
});

app.put('/api/shifts/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {name,start_time,end_time,grace_minutes,half_day_hours,work_days} = req.body;
  db.run(`UPDATE shifts SET name=?,start_time=?,end_time=?,grace_minutes=?,half_day_hours=?,work_days=? WHERE id=?`,
    [name,start_time,end_time,grace_minutes,half_day_hours,work_days,req.params.id]);
  saveDb(); ok(res, get(db,`SELECT * FROM shifts WHERE id=?`,[req.params.id]));
});

app.delete('/api/shifts/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  db.run(`DELETE FROM shifts WHERE id=?`,[req.params.id]); saveDb(); ok(res,{deleted:true});
});

// ── ATTENDANCE ───────────────────────────────────────────────────────────────

app.get('/api/attendance', authMiddleware, async (req, res) => {
  const db = await getDb();
  const {date,employee_id,month} = req.query;
  let sql = `SELECT a.*, e.first_name, e.last_name, e.emp_no, e.department, e.shift_id,
    s.name as shift_name, s.start_time, s.end_time
    FROM attendance a JOIN employees e ON a.employee_id=e.id
    LEFT JOIN shifts s ON e.shift_id=s.id WHERE 1=1`;
  const params = [];
  // Role-based filtering
  if (req.user.role === 'employee') { sql += ` AND a.employee_id=?`; params.push(req.user.empId); }
  else if (req.user.role === 'manager') { sql += ` AND (a.employee_id=? OR e.report_to=?)`; params.push(req.user.empId,req.user.empId); }
  else {
    if (employee_id) { sql += ` AND a.employee_id=?`; params.push(employee_id); }
  }
  if (date) { sql += ` AND a.date=?`; params.push(date); }
  if (month) { sql += ` AND a.date LIKE ?`; params.push(`${month}%`); }
  sql += ` ORDER BY a.date DESC, e.id`;
  ok(res, all(db,sql,params));
});

app.post('/api/attendance', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const {employee_id,date,status,check_in,check_out,worked_seconds,note} = req.body;
  if (!employee_id||!date) return err(res,'employee_id and date required');
  const ex = get(db,`SELECT id FROM attendance WHERE employee_id=? AND date=?`,[employee_id,date]);
  if (ex) db.run(`UPDATE attendance SET status=?,check_in=?,check_out=?,worked_seconds=?,note=?,updated_at=datetime('now') WHERE employee_id=? AND date=?`,
    [status||'Present',check_in||'',check_out||'',worked_seconds||0,note||'',employee_id,date]);
  else db.run(`INSERT INTO attendance(employee_id,date,status,check_in,check_out,worked_seconds,note) VALUES(?,?,?,?,?,?,?)`,
    [employee_id,date,status||'Present',check_in||'',check_out||'',worked_seconds||0,note||'']);
  saveDb(); ok(res, get(db,`SELECT * FROM attendance WHERE employee_id=? AND date=?`,[employee_id,date]));
});

// ── CLOCK IN / OUT ───────────────────────────────────────────────────────────

app.get('/api/attendance/session/:employee_id', authMiddleware, async (req, res) => {
  const db = await getDb();
  // Employees can only check own session
  if (req.user.role==='employee' && req.user.empId!=req.params.employee_id) return err(res,'Access denied',403);
  ok(res, get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[req.params.employee_id,todayStr()]));
});

app.post('/api/attendance/clock-in', authMiddleware, async (req, res) => {
  const db = await getDb();
  // Employee can only clock in for themselves
  const empId = req.user.role==='employee' ? req.user.empId : (req.body.employee_id || req.user.empId);
  const today=todayStr(), now=nowStr();
  const ex=get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[empId,today]);
  if (ex&&ex.clock_in_at&&!ex.clock_out_at) return err(res,'Already clocked in');
  if (ex&&ex.clock_out_at) return err(res,'Session already completed for today');
  if (ex) db.run(`UPDATE attendance_sessions SET clock_in_at=?,clock_out_at=NULL WHERE employee_id=? AND date=?`,[now,empId,today]);
  else db.run(`INSERT INTO attendance_sessions(employee_id,date,clock_in_at) VALUES(?,?,?)`,[empId,today,now]);
  const timeStr=new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});
  const attEx=get(db,`SELECT id FROM attendance WHERE employee_id=? AND date=?`,[empId,today]);
  if (attEx) db.run(`UPDATE attendance SET status='Present',check_in=?,updated_at=datetime('now') WHERE employee_id=? AND date=?`,[timeStr,empId,today]);
  else db.run(`INSERT INTO attendance(employee_id,date,status,check_in) VALUES(?,?,'Present',?)`,[empId,today,timeStr]);
  saveDb();
  ok(res,{session:get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[empId,today]),message:'Clocked in',time:now});
});

app.post('/api/attendance/clock-out', authMiddleware, async (req, res) => {
  const db = await getDb();
  const empId = req.user.role==='employee' ? req.user.empId : (req.body.employee_id || req.user.empId);
  const today=todayStr();
  const session=get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[empId,today]);
  if (!session||!session.clock_in_at) return err(res,'No active session');
  if (session.clock_out_at) return err(res,'Already clocked out');
  const now=nowStr();
  const ws=Math.floor((new Date(now)-new Date(session.clock_in_at))/1000);
  db.run(`UPDATE attendance_sessions SET clock_out_at=?,worked_seconds=? WHERE employee_id=? AND date=?`,[now,ws,empId,today]);
  const timeStr=new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});
  const emp=get(db,`SELECT e.*,s.grace_minutes,s.half_day_hours,s.start_time FROM employees e LEFT JOIN shifts s ON e.shift_id=s.id WHERE e.id=?`,[empId]);
  const hours=ws/3600;
  let status='Present';
  if (hours<(emp?.half_day_hours||4)) status='Half Day';
  else {
    const cinTime=new Date(session.clock_in_at);
    const cinMin=cinTime.getHours()*60+cinTime.getMinutes();
    const [sh,sm]=(emp?.start_time||'09:00').split(':').map(Number);
    if (cinMin>sh*60+sm+(emp?.grace_minutes||15)) status='Late';
  }
  const attEx=get(db,`SELECT id FROM attendance WHERE employee_id=? AND date=?`,[empId,today]);
  if (attEx) db.run(`UPDATE attendance SET check_out=?,worked_seconds=?,status=?,updated_at=datetime('now') WHERE employee_id=? AND date=?`,[timeStr,ws,status,empId,today]);
  else db.run(`INSERT INTO attendance(employee_id,date,status,check_out,worked_seconds) VALUES(?,?,?,?,?)`,[empId,today,status,timeStr,ws]);
  saveDb();
  ok(res,{session:get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[empId,today]),worked_seconds:ws,status,message:'Clocked out'});
});

app.get('/api/attendance/today-summary', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const today=todayStr();
  const active=get(db,`SELECT COUNT(*) as c FROM attendance_sessions WHERE date=? AND clock_in_at IS NOT NULL AND clock_out_at IS NULL`,[today]).c;
  const completed=get(db,`SELECT COUNT(*) as c FROM attendance_sessions WHERE date=? AND clock_out_at IS NOT NULL`,[today]).c;
  const totalActive=get(db,`SELECT COUNT(*) as c FROM employees WHERE status='Active'`).c;
  ok(res,{active_sessions:active,completed_sessions:completed,not_clocked_in:Math.max(0,totalActive-active-completed)});
});

app.get('/api/attendance/monthly-summary', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const {month} = req.query;
  if (!month) return err(res,'month required');
  let sql = `SELECT e.id,e.first_name,e.last_name,e.emp_no,e.department,
    SUM(CASE WHEN a.status NOT IN ('Holiday','Weekend') THEN 1 ELSE 0 END) as working_days,
    SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) as present,
    SUM(CASE WHEN a.status='WFH' THEN 1 ELSE 0 END) as wfh,
    SUM(CASE WHEN a.status='Late' THEN 1 ELSE 0 END) as late,
    SUM(CASE WHEN a.status='Half Day' THEN 1 ELSE 0 END) as half_day,
    SUM(CASE WHEN a.status='Absent' THEN 1 ELSE 0 END) as absent,
    SUM(COALESCE(a.worked_seconds,0)) as total_worked_seconds
    FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.date LIKE ?`;
  const params = [`${month}%`];
  if (req.user.role==='manager') { sql+=` WHERE e.id=? OR e.report_to=?`; params.push(req.user.empId,req.user.empId); }
  sql += ` GROUP BY e.id ORDER BY e.id`;
  ok(res, all(db,sql,params));
});

// ── REGULARIZATIONS ──────────────────────────────────────────────────────────

app.get('/api/regularizations', authMiddleware, async (req, res) => {
  const db = await getDb();
  let sql = `SELECT r.*, e.first_name, e.last_name, e.emp_no FROM regularizations r JOIN employees e ON r.employee_id=e.id WHERE 1=1`;
  const params = [];
  if (req.user.role==='employee') { sql+=` AND r.employee_id=?`; params.push(req.user.empId); }
  else if (req.user.role==='manager') { sql+=` AND (r.employee_id=? OR e.report_to=?)`; params.push(req.user.empId,req.user.empId); }
  else if (req.query.status) { sql+=` AND r.status=?`; params.push(req.query.status); }
  sql += ` ORDER BY r.created_at DESC`;
  ok(res, all(db,sql,params));
});

app.post('/api/regularizations', authMiddleware, async (req, res) => {
  const db = await getDb();
  const empId = req.user.role==='employee' ? req.user.empId : (req.body.employee_id||req.user.empId);
  const {date,requested_in,requested_out,reason} = req.body;
  if (!date||!reason) return err(res,'date and reason required');
  db.run(`INSERT INTO regularizations(employee_id,date,requested_in,requested_out,reason) VALUES(?,?,?,?,?)`,[empId,date,requested_in||'',requested_out||'',reason]);
  const id=lastId(db); saveDb();
  ok(res, get(db,`SELECT r.*,e.first_name,e.last_name FROM regularizations r JOIN employees e ON r.employee_id=e.id WHERE r.id=?`,[id]),201);
});

app.put('/api/regularizations/:id/action', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const {status,reviewed_by} = req.body;
  if (!['Approved','Rejected'].includes(status)) return err(res,'Status must be Approved or Rejected');
  const reg=get(db,`SELECT * FROM regularizations WHERE id=?`,[req.params.id]);
  if (!reg) return err(res,'Not found',404);
  db.run(`UPDATE regularizations SET status=?,reviewed_by=?,reviewed_on=date('now') WHERE id=?`,[status,reviewed_by||req.user.name,req.params.id]);
  if (status==='Approved') {
    const [ih,im]=(reg.requested_in||'09:00').split(':').map(Number);
    const [oh,om]=(reg.requested_out||'18:00').split(':').map(Number);
    const ws=(oh*60+om-ih*60-im)*60;
    const ex=get(db,`SELECT id FROM attendance WHERE employee_id=? AND date=?`,[reg.employee_id,reg.date]);
    if (ex) db.run(`UPDATE attendance SET status='Present',check_in=?,check_out=?,worked_seconds=?,note='Regularized',updated_at=datetime('now') WHERE employee_id=? AND date=?`,[reg.requested_in,reg.requested_out,ws,reg.employee_id,reg.date]);
    else db.run(`INSERT INTO attendance(employee_id,date,status,check_in,check_out,worked_seconds,note) VALUES(?,?,'Present',?,?,?,'Regularized')`,[reg.employee_id,reg.date,reg.requested_in,reg.requested_out,ws]);
  }
  saveDb(); ok(res, get(db,`SELECT * FROM regularizations WHERE id=?`,[req.params.id]));
});

// ── HOLIDAYS ─────────────────────────────────────────────────────────────────

app.get('/api/holidays', authMiddleware, async (req, res) => {
  const db = await getDb();
  ok(res, all(db,`SELECT * FROM holidays ORDER BY date`));
});

app.post('/api/holidays', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {date,name} = req.body;
  if (!date||!name) return err(res,'date and name required');
  try {
    db.run(`INSERT INTO holidays(date,name) VALUES(?,?)`,[date,name]);
    const id=lastId(db); saveDb();
    ok(res, get(db,`SELECT * FROM holidays WHERE id=?`,[id]),201);
  } catch(e) { err(res,'Holiday for this date already exists'); }
});

app.delete('/api/holidays/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  db.run(`DELETE FROM holidays WHERE id=?`,[req.params.id]); saveDb();
  ok(res,{deleted:true});
});

// ── LEAVE ─────────────────────────────────────────────────────────────────────

app.get('/api/leaves', authMiddleware, async (req, res) => {
  const db = await getDb();
  let sql=`SELECT l.*,e.first_name,e.last_name,e.emp_no,e.department FROM leave_requests l JOIN employees e ON l.employee_id=e.id WHERE 1=1`;
  const params=[];
  if (req.user.role==='employee') { sql+=` AND l.employee_id=?`; params.push(req.user.empId); }
  else if (req.user.role==='manager') { sql+=` AND (l.employee_id=? OR e.report_to=?)`; params.push(req.user.empId,req.user.empId); }
  else {
    if (req.query.employee_id) { sql+=` AND l.employee_id=?`; params.push(req.query.employee_id); }
    if (req.query.status) { sql+=` AND l.status=?`; params.push(req.query.status); }
  }
  sql+=` ORDER BY l.created_at DESC`;
  ok(res, all(db,sql,params));
});

app.post('/api/leaves', authMiddleware, async (req, res) => {
  const db = await getDb();
  const empId = req.user.role==='employee' ? req.user.empId : (req.body.employee_id||req.user.empId);
  const {leave_type,from_date,to_date,days,reason,applied_on} = req.body;
  if (!from_date||!to_date) return err(res,'from_date and to_date required');
  db.run(`INSERT INTO leave_requests(employee_id,leave_type,from_date,to_date,days,reason,applied_on) VALUES(?,?,?,?,?,?,?)`,
    [empId,leave_type||'Casual',from_date,to_date,days||1,reason||'',applied_on||todayStr()]);
  const id=lastId(db); saveDb();
  ok(res, get(db,`SELECT l.*,e.first_name,e.last_name FROM leave_requests l JOIN employees e ON l.employee_id=e.id WHERE l.id=?`,[id]),201);
});

app.put('/api/leaves/:id/action', authMiddleware, requireRole('admin','manager'), async (req, res) => {
  const db = await getDb();
  const {status,approved_by} = req.body;
  if (!['Approved','Rejected','Cancelled','Pullback'].includes(status)) return err(res,'Invalid status');
  const leave=get(db,`SELECT * FROM leave_requests WHERE id=?`,[req.params.id]);
  if (!leave) return err(res,'Not found',404);
  // Managers can only action their team's leaves
  if (req.user.role==='manager') {
    const emp=get(db,`SELECT report_to FROM employees WHERE id=?`,[leave.employee_id]);
    if (emp?.report_to!=req.user.empId && leave.employee_id!=req.user.empId) return err(res,'Access denied',403);
  }
  const approvedOn=status==='Approved'?todayStr():null;
  db.run(`UPDATE leave_requests SET status=?,approved_by=?,approved_on=?,updated_at=datetime('now') WHERE id=?`,
    [status,approved_by||req.user.name,approvedOn,req.params.id]);
  saveDb(); ok(res, get(db,`SELECT * FROM leave_requests WHERE id=?`,[req.params.id]));
});

app.get('/api/leaves/balance/:employee_id', authMiddleware, async (req, res) => {
  const db = await getDb();
  if (req.user.role==='employee'&&req.user.empId!=req.params.employee_id) return err(res,'Access denied',403);
  const year=req.query.year||new Date().getFullYear();
  const policy=all(db,`SELECT * FROM leave_policy`);
  const used=all(db,`SELECT leave_type,SUM(days) as used FROM leave_requests WHERE employee_id=? AND status='Approved' AND from_date LIKE ? GROUP BY leave_type`,[req.params.employee_id,`${year}%`]);
  const usedMap=Object.fromEntries(used.map(u=>[u.leave_type,u.used]));
  ok(res, policy.map(p=>({leave_type:p.leave_type,total:p.days_per_year,used:usedMap[p.leave_type]||0,remaining:p.days_per_year-(usedMap[p.leave_type]||0)})));
});

// ── PAYROLL ───────────────────────────────────────────────────────────────────

app.get('/api/payroll', authMiddleware, async (req, res) => {
  const db = await getDb();
  let sql=`SELECT p.*,e.first_name,e.last_name,e.emp_no,e.department FROM payroll p JOIN employees e ON p.employee_id=e.id WHERE 1=1`;
  const params=[];
  if (req.user.role==='employee') { sql+=` AND p.employee_id=? AND p.status='Paid'`; params.push(req.user.empId); }
  else {
    if (req.query.month) { sql+=` AND p.month=?`; params.push(req.query.month); }
    if (req.query.employee_id) { sql+=` AND p.employee_id=?`; params.push(req.query.employee_id); }
    if (req.query.status) { sql+=` AND p.status=?`; params.push(req.query.status); }
  }
  sql+=` ORDER BY p.month DESC,e.id`;
  ok(res, all(db,sql,params));
});

app.post('/api/payroll/run', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {month} = req.body;
  if (!month) return err(res,'month required');
  const settings=getSettings(db);
  const pfRate=parseFloat(settings.pf_rate)||12, tdsRate=parseFloat(settings.tds_rate)||10;
  const employees=all(db,`SELECT * FROM employees WHERE status='Active'`);
  let created=0,skipped=0;
  for (const emp of employees) {
    if (get(db,`SELECT id FROM payroll WHERE employee_id=? AND month=?`,[emp.id,month])) { skipped++; continue; }
    const s=calcSalary(emp.basic_salary,pfRate,tdsRate);
    db.run(`INSERT INTO payroll(employee_id,month,basic,hra,travel_allowance,special_allowance,gross,pf_deduction,esi_deduction,tds_deduction,net_pay,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'Draft')`,
      [emp.id,month,emp.basic_salary,s.hra,s.ta,s.special,s.gross,s.pf_deduction,s.esi_deduction,s.tds_deduction,s.net_pay]);
    created++;
  }
  saveDb(); ok(res,{created,skipped,month,message:`${created} drafts created, ${skipped} skipped`});
});

app.put('/api/payroll/:id/status', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {status,processed_by} = req.body;
  if (!['Draft','Processing','Paid'].includes(status)) return err(res,'Invalid status');
  db.run(`UPDATE payroll SET status=?,processed_by=?,processed_on=?,updated_at=datetime('now') WHERE id=?`,
    [status,processed_by||req.user.name,status==='Paid'?todayStr():null,req.params.id]);
  saveDb(); ok(res, get(db,`SELECT p.*,e.first_name,e.last_name FROM payroll p JOIN employees e ON p.employee_id=e.id WHERE p.id=?`,[req.params.id]));
});

app.get('/api/payroll/payslip/:employee_id/:month', authMiddleware, async (req, res) => {
  const db = await getDb();
  if (req.user.role==='employee'&&req.user.empId!=req.params.employee_id) return err(res,'Access denied',403);
  const ps=get(db,`SELECT p.*,e.first_name,e.last_name,e.emp_no,e.department,e.role FROM payroll p JOIN employees e ON p.employee_id=e.id WHERE p.employee_id=? AND p.month=?`,[req.params.employee_id,req.params.month]);
  if (!ps) return err(res,'Payslip not found',404);
  ps.company_name=getSettings(db).company_name;
  ok(res, ps);
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────

app.get('/api/settings', authMiddleware, async (req, res) => {
  const db = await getDb();
  const settings=getSettings(db);
  const policy=all(db,`SELECT * FROM leave_policy`);
  ok(res,{...settings,leave_policy:policy});
});

app.put('/api/settings', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const {company_name,pf_rate,tds_rate,esi_rate,working_hours_per_day,leave_policy} = req.body;
  const upsert=(k,v)=>{if(v!==undefined)db.run(`INSERT OR REPLACE INTO company_settings(key,value,updated_at) VALUES(?,?,datetime('now'))`,[k,String(v)]);};
  upsert('company_name',company_name); upsert('pf_rate',pf_rate); upsert('tds_rate',tds_rate);
  upsert('esi_rate',esi_rate); upsert('working_hours_per_day',working_hours_per_day);
  if (leave_policy&&Array.isArray(leave_policy)) {
    for (const lp of leave_policy) db.run(`UPDATE leave_policy SET days_per_year=? WHERE leave_type=?`,[lp.days_per_year,lp.leave_type]);
  }
  saveDb();
  const settings=getSettings(db);
  ok(res,{...settings,leave_policy:all(db,`SELECT * FROM leave_policy`)});
});

// ── DASHBOARD ────────────────────────────────────────────────────────────────

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const db = await getDb();
  const today=todayStr();
  if (req.user.role==='employee') {
    const empId=req.user.empId;
    const session=get(db,`SELECT * FROM attendance_sessions WHERE employee_id=? AND date=?`,[empId,today]);
    const leaveBalance=all(db,`SELECT lp.leave_type,lp.days_per_year,COALESCE(SUM(lr.days),0) as used FROM leave_policy lp LEFT JOIN leave_requests lr ON lr.leave_type=lp.leave_type AND lr.employee_id=? AND lr.status='Approved' GROUP BY lp.leave_type`,[empId]);
    const recentAtt=all(db,`SELECT * FROM attendance WHERE employee_id=? ORDER BY date DESC LIMIT 7`,[empId]);
    const myLeaves=all(db,`SELECT * FROM leave_requests WHERE employee_id=? ORDER BY created_at DESC LIMIT 5`,[empId]);
    const myPayslips=all(db,`SELECT * FROM payroll WHERE employee_id=? AND status='Paid' ORDER BY month DESC LIMIT 3`,[empId]);
    ok(res,{role:'employee',session,leave_balance:leaveBalance,recent_attendance:recentAtt,my_leaves:myLeaves,my_payslips:myPayslips});
  } else {
    const totalEmp=get(db,`SELECT COUNT(*) as c FROM employees`).c;
    const activeEmp=get(db,`SELECT COUNT(*) as c FROM employees WHERE status='Active'`).c;
    const activeSessions=get(db,`SELECT COUNT(*) as c FROM attendance_sessions WHERE date=? AND clock_in_at IS NOT NULL AND clock_out_at IS NULL`,[today]).c;
    const pendingLeaves=get(db,`SELECT COUNT(*) as c FROM leave_requests WHERE status='Pending'`).c;
    const pendingRegs=get(db,`SELECT COUNT(*) as c FROM regularizations WHERE status='Pending'`).c;
    const avgSal=(get(db,`SELECT AVG(basic_salary) as a FROM employees`)||{}).a||0;
    const recentLeaves=all(db,`SELECT l.*,e.first_name,e.last_name FROM leave_requests l JOIN employees e ON l.employee_id=e.id WHERE l.status='Pending' ORDER BY l.created_at DESC LIMIT 5`);
    const todaySessions=all(db,`SELECT s.*,e.first_name,e.last_name,e.emp_no FROM attendance_sessions s JOIN employees e ON s.employee_id=e.id WHERE s.date=? ORDER BY s.clock_in_at DESC LIMIT 10`,[today]);
    ok(res,{role:req.user.role,total_employees:totalEmp,active_employees:activeEmp,active_sessions:activeSessions,pending_leaves:pendingLeaves,pending_regularizations:pendingRegs,avg_salary:Math.round(avgSal),recent_leaves:recentLeaves,today_sessions:todaySessions});
  }
});

// ── ORG CHART ────────────────────────────────────────────────────────────────

app.get('/api/org-chart', authMiddleware, async (req, res) => {
  const db = await getDb();
  const employees=all(db,`SELECT id,first_name,last_name,role,department,status,report_to,shift_id FROM employees ORDER BY id`);
  function buildTree(parentId) {
    return employees.filter(e=>(e.report_to||null)===(parentId||null)).map(e=>({...e,children:buildTree(e.id)}));
  }
  ok(res, buildTree(null));
});

// ── SERVE FRONTEND ───────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ────────────────────────────────────────────────────────────────────

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\n🚀 PeopleHR running at http://localhost:${PORT}`);
    console.log(`   First time? Run: node database/seed.js\n`);
  });
}
start().catch(e => { console.error(e); process.exit(1); });
