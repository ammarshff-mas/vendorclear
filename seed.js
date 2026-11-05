/**
 * Seed data: 3 suppliers and 3 invoices matching the sample PDFs.
 */
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

function seedData() {
  // Clear existing data
  db.exec('DELETE FROM activity');
  db.exec('DELETE FROM fix_requests');
  db.exec('DELETE FROM invoices');
  db.exec('DELETE FROM suppliers');

  const now = new Date().toISOString();

  // ─── Suppliers ──────────────────────────────────────────────
  const suppliers = [
    {
      id: uuidv4(),
      name: 'Jeddah Freight Partners',
      country: 'SA',
      taxId: '311234567800003',
      registrationNo: '4030123456',
      email: 'accounts@jeddahfreight.sa',
      source: 'system'
    },
    {
      id: uuidv4(),
      name: 'Dammam Office Supplies',
      country: 'SA',
      taxId: '302345678900003',
      registrationNo: '2050987654',
      email: 'billing@damoffice.sa',
      source: 'system'
    },
    {
      id: uuidv4(),
      name: 'Petaling Events Sdn Bhd',
      country: 'MY',
      taxId: 'C21987654030',
      sstNo: 'B10-1234-56789012',
      email: 'finance@petalingevents.my',
      source: 'system'
    }
  ];

  const insertSupplier = db.prepare(`
    INSERT INTO suppliers (id, name, country, taxId, registrationNo, sstNo, email, source, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of suppliers) {
    insertSupplier.run(
      s.id, s.name, s.country, s.taxId,
      s.registrationNo || null, s.sstNo || null,
      s.email || null, s.source, now, now
    );
  }

  // ─── ZATCA QR for sample invoices ───────────────────────────
  // Build TLV-encoded QR data
  function buildTlv(tags) {
    const buffers = tags.map(([tag, value]) => {
      const valBuf = Buffer.from(value, 'utf8');
      return Buffer.concat([Buffer.from([tag, valBuf.length]), valBuf]);
    });
    return Buffer.concat(buffers).toString('base64');
  }

  // JFP invoice: QR totals deliberately MISMATCH printed totals
  // Invoice total=14375.00 tax=1875.00, but QR says total=14475 vat=1890
  const jfpQr = buildTlv([
    [1, 'Jeddah Freight Partners'],
    [2, '311234567800003'],
    [3, '2026-10-28T14:30:00Z'],
    [4, '14475.00'],  // Mismatched! Invoice says 14375.00
    [5, '1890.00']    // Mismatched! Invoice says 1875.00
  ]);

  // DOS invoice: QR totals match - clean invoice
  const dosQr = buildTlv([
    [1, 'Dammam Office Supplies'],
    [2, '302345678900003'],
    [3, '2026-10-25T09:15:00Z'],
    [4, '2185.00'],
    [5, '285.00']
  ]);

  // ─── Invoices ───────────────────────────────────────────────
  // Malaysia validated time: set to ~48 hours ago so window is still open
  const validatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const invoices = [
    {
      id: uuidv4(),
      supplierId: suppliers[0].id, // Jeddah Freight
      country: 'SA',
      invoiceNumber: 'KSA-JFP-2026-0931',
      issueDate: '2026-10-28',
      currency: 'SAR',
      subtotal: 12500.00,
      taxAmount: 1875.00,
      total: 14375.00,
      poNumber: 'PO-2026-0445',
      invoiceType: 'standard',
      authorityStatus: 'cleared',
      authorityStatusSource: 'manual',
      internalStatus: 'pending',
      zatcaQr: jfpQr,
      source: 'system'
    },
    {
      id: uuidv4(),
      supplierId: suppliers[1].id, // Dammam Office
      country: 'SA',
      invoiceNumber: 'KSA-DOS-00451',
      issueDate: '2026-10-25',
      currency: 'SAR',
      subtotal: 1900.00,
      taxAmount: 285.00,
      total: 2185.00,
      poNumber: 'PO-2026-0398',
      invoiceType: 'standard',
      authorityStatus: 'cleared',
      authorityStatusSource: 'manual',
      internalStatus: 'pending',
      zatcaQr: dosQr,
      source: 'system'
    },
    {
      id: uuidv4(),
      supplierId: suppliers[2].id, // Petaling Events
      country: 'MY',
      invoiceNumber: 'MY-PEV-7781',
      issueDate: '2026-11-01',
      currency: 'MYR',
      subtotal: 8400.00,
      taxAmount: 520.00,   // Should be 504.00 (6% of 8400) — deliberate mismatch
      total: 8920.00,       // Should be 8904.00 — deliberate mismatch
      invoiceType: 'standard',
      authorityStatus: 'valid',
      authorityStatusSource: 'myinvois',
      internalStatus: 'pending',
      myinvoisLink: 'https://myinvois.hasil.gov.my/e8f1a2b3-c4d5-6e7f-8901-abcdef123456/share/abc123def456',
      myinvoisUuid: 'e8f1a2b3-c4d5-6e7f-8901-abcdef123456',
      validatedAt: validatedAt,
      source: 'system'
    }
  ];

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, supplierId, country, invoiceNumber, issueDate, currency, subtotal, taxAmount, total, poNumber, invoiceType, authorityStatus, authorityStatusSource, internalStatus, zatcaQr, myinvoisLink, myinvoisUuid, validatedAt, source, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const inv of invoices) {
    insertInvoice.run(
      inv.id, inv.supplierId, inv.country, inv.invoiceNumber,
      inv.issueDate, inv.currency, inv.subtotal, inv.taxAmount, inv.total,
      inv.poNumber || null, inv.invoiceType,
      inv.authorityStatus, inv.authorityStatusSource || null,
      inv.internalStatus,
      inv.zatcaQr || null, inv.myinvoisLink || null,
      inv.myinvoisUuid || null, inv.validatedAt || null,
      inv.source, now, now
    );
  }

  // ─── Activity logs ──────────────────────────────────────────
  const insertActivity = db.prepare(`
    INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const inv of invoices) {
    insertActivity.run(
      uuidv4(), inv.id, inv.supplierId, 'system', 'invoice_created',
      `Invoice ${inv.invoiceNumber} created from sample data`, now
    );
  }

  console.log(`Seeded ${suppliers.length} suppliers and ${invoices.length} invoices`);
}

// Run if called directly
if (require.main === module) {
  seedData();
  console.log('Done');
}

module.exports = { seedData };
