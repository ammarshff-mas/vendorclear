const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'vendorclear.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL CHECK(country IN ('SA','MY')),
    taxId TEXT,
    registrationNo TEXT,
    sstNo TEXT,
    email TEXT,
    source TEXT DEFAULT 'user',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    supplierId TEXT NOT NULL REFERENCES suppliers(id),
    country TEXT NOT NULL CHECK(country IN ('SA','MY')),
    invoiceNumber TEXT NOT NULL,
    issueDate TEXT,
    dueDate TEXT,
    currency TEXT NOT NULL CHECK(currency IN ('SAR','MYR')),
    subtotal REAL DEFAULT 0,
    taxAmount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    poNumber TEXT,
    invoiceType TEXT DEFAULT 'standard',
    authorityStatus TEXT DEFAULT 'pending',
    authorityStatusSource TEXT,
    internalStatus TEXT DEFAULT 'pending',
    zatcaQr TEXT,
    myinvoisLink TEXT,
    myinvoisUuid TEXT,
    validatedAt TEXT,
    source TEXT DEFAULT 'user',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS fix_requests (
    id TEXT PRIMARY KEY,
    invoiceId TEXT NOT NULL REFERENCES invoices(id),
    token TEXT NOT NULL UNIQUE,
    message TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','responded','resolved')),
    supplierResponse TEXT,
    correctedInvoiceNumber TEXT,
    createdBy TEXT DEFAULT 'user',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    invoiceId TEXT REFERENCES invoices(id),
    supplierId TEXT REFERENCES suppliers(id),
    actor TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    detail TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
