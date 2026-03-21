# PeopleHR — Full-Stack HRMS

A complete Human Resource Management System with live attendance clock-in/out, leave management, payroll processing, and payslip generation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express.js |
| Database | SQLite (via better-sqlite3) |
| Frontend | Vanilla HTML/CSS/JS (served by Express) |
| API | RESTful JSON API |

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Seed the database (first time only)
```bash
npm run seed
```
This creates `hrms.db` with:
- 10 sample employees across Engineering, Sales, HR, Finance, Marketing
- 4 shifts (General, Early Bird, Flexi, Weekend)
- 13 public holidays for 2024
- March 2024 attendance records
- Sample leave requests and regularizations
- February payroll (paid) + March payroll (draft)

### 3. Start the server
```bash
npm start
```

### 4. Open in browser
```
http://localhost:3000
```

---

## Features

### People
- **Employees** — Full CRUD with emp no, department, role, shift assignment, reporting structure, salary
- **Org Chart** — Visual hierarchy tree showing reporting relationships

### Attendance
- **Live clock-in/out** — Real-time timer per employee, persistent sessions in SQLite
- **Today's log** — View and manage all attendance for the current day
- **Monthly report** — Attendance % per employee with visual progress bars
- **Regularization** — Employees request corrections; admin approves/rejects; approved records auto-update attendance
- **Holidays** — Manage public holiday calendar

### Leave
- **Leave requests** — Apply, approve, reject, cancel, pullback, re-approve
- **Leave balances** — Per-employee annual balance by leave type

### Payroll
- **Salary structure** — Auto-calculated India-standard (HRA 40%, TA ₹2,000, Special 10%, PF 12%, ESI, TDS)
- **Payroll run** — Generate draft payroll for any month, process, mark paid, rollback
- **Payslips** — Formatted payslip for every paid payroll record

### Admin
- **Settings** — Company name, PF rate, TDS rate, annual leave policy

---

## API Reference

### Employees
```
GET    /api/employees              List all (supports ?q=search&dept=&status=)
GET    /api/employees/:id          Get one
POST   /api/employees              Create
PUT    /api/employees/:id          Update
DELETE /api/employees/:id          Delete
GET    /api/employees/stats/summary  Summary stats
```

### Attendance
```
GET  /api/attendance               List (supports ?date=&employee_id=&month=YYYY-MM)
POST /api/attendance               Upsert attendance record
POST /api/attendance/clock-in      Clock in (body: {employee_id})
POST /api/attendance/clock-out     Clock out (body: {employee_id})
GET  /api/attendance/session/:id   Get today's session for employee
GET  /api/attendance/today-summary Today's stats
GET  /api/attendance/monthly-summary?month=YYYY-MM
```

### Leave
```
GET  /api/leaves                   List (supports ?employee_id=&status=&q=)
POST /api/leaves                   Create
PUT  /api/leaves/:id/action        Approve/Reject/Cancel/Pullback
GET  /api/leaves/balance/:id       Balance for employee (supports ?year=)
```

### Payroll
```
GET  /api/payroll                  List (supports ?month=&employee_id=&status=)
POST /api/payroll/run              Generate draft for month (body: {month})
PUT  /api/payroll/:id/status       Change status (Draft/Processing/Paid)
GET  /api/payroll/payslip/:id/:month  Get payslip data
```

### Other
```
GET/POST    /api/shifts
PUT/DELETE  /api/shifts/:id
GET/POST    /api/holidays
DELETE      /api/holidays/:id
GET/POST    /api/regularizations
PUT         /api/regularizations/:id/action
GET         /api/org-chart
GET/PUT     /api/settings
GET         /api/dashboard
```

---

## Database Schema

Tables: `employees`, `shifts`, `attendance`, `attendance_sessions`, `regularizations`, `holidays`, `leave_requests`, `leave_policy`, `payroll`, `company_settings`

SQLite WAL mode enabled for concurrent reads.

---

## Environment

Default port: `3000`

Override with:
```bash
PORT=8080 npm start
```

---

## Project Structure

```
hrms-app/
├── server.js              # Express API server (all routes)
├── package.json
├── hrms.db                # SQLite database (auto-created)
├── database/
│   ├── schema.js          # Table definitions + initDb()
│   └── seed.js            # Sample data seeder
└── public/
    └── index.html         # Full frontend SPA
```
