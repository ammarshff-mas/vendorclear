/**
 * VendorClear Check Engine
 * All checks are deterministic — no AI, no LLM calls.
 * Arithmetic, regex, date math, TLV decoding only.
 */

const db = require('./db');

// ─── ZATCA QR TLV Decoder ───────────────────────────────────────────

function decodeZatcaQr(base64Str) {
  try {
    const buf = Buffer.from(base64Str, 'base64');
    const tags = [];
    let offset = 0;
    while (offset < buf.length) {
      if (offset + 2 > buf.length) break;
      const tag = buf[offset];
      const len = buf[offset + 1];
      offset += 2;
      if (offset + len > buf.length) break;
      const val = buf.slice(offset, offset + len);
      tags.push({ tag, length: len, value: val.toString('utf8'), raw: val });
      offset += len;
    }

    const getTag = (n) => {
      const t = tags.find(t => t.tag === n);
      return t ? t.value : null;
    };

    return {
      ok: tags.length >= 5,
      sellerName: getTag(1),
      vatNumber: getTag(2),
      timestamp: getTag(3),
      total: getTag(4) ? parseFloat(getTag(4)) : null,
      vatTotal: getTag(5) ? parseFloat(getTag(5)) : null,
      hasCryptographicStamp: tags.some(t => t.tag >= 6 && t.tag <= 9),
      error: tags.length < 5 ? 'QR code has fewer than 5 tags' : null,
      tags: tags.map(t => ({
        tag: t.tag,
        length: t.length,
        value: t.tag >= 6 ? `[${t.length} bytes]` : t.value
      }))
    };
  } catch (e) {
    return {
      ok: false,
      sellerName: null,
      vatNumber: null,
      timestamp: null,
      total: null,
      vatTotal: null,
      hasCryptographicStamp: false,
      error: `Failed to decode QR: ${e.message}`,
      tags: []
    };
  }
}

// ─── Check Functions ────────────────────────────────────────────────

function checkVatNumberFormat(taxId, country) {
  if (country === 'SA') {
    // Saudi VAT: 15 digits, starts and ends with 3
    if (!taxId) return { pass: false, code: 'vat_format', message: 'Missing VAT number' };
    const valid = /^3\d{13}3$/.test(taxId);
    return {
      pass: valid,
      code: 'vat_format',
      message: valid ? 'VAT number format valid' : `VAT number must be 15 digits starting and ending with 3, got: ${taxId}`
    };
  }
  if (country === 'MY') {
    // Malaysia TIN: starts with C or IG prefix + digits
    if (!taxId) return { pass: false, code: 'tin_format', message: 'Missing TIN' };
    const valid = /^(C|IG)\d+$/.test(taxId);
    return {
      pass: valid,
      code: 'tin_format',
      message: valid ? 'TIN format valid' : `TIN must start with C or IG followed by digits, got: ${taxId}`
    };
  }
  return { pass: true, code: 'tax_id', message: 'No tax ID check for this country' };
}

function checkVatArithmetic(subtotal, taxAmount, country) {
  if (subtotal == null || taxAmount == null) {
    return { pass: false, code: 'vat_arithmetic', message: 'Missing subtotal or tax amount' };
  }
  const rate = country === 'SA' ? 0.15 : (country === 'MY' ? 0.06 : 0);
  const rateLabel = country === 'SA' ? '15%' : '6%';
  if (rate === 0) return { pass: true, code: 'vat_arithmetic', message: 'No VAT rate for this country' };

  const expected = subtotal * rate;
  const diff = Math.abs(expected - taxAmount);
  const pass = diff <= 0.05;
  return {
    pass,
    code: 'vat_arithmetic',
    message: pass
      ? `VAT arithmetic correct (${rateLabel} of ${subtotal.toFixed(2)} = ${expected.toFixed(2)})`
      : `VAT arithmetic mismatch: ${rateLabel} of ${subtotal.toFixed(2)} = ${expected.toFixed(2)}, but tax is ${taxAmount.toFixed(2)} (diff: ${diff.toFixed(2)})`
  };
}

function checkTotalArithmetic(subtotal, taxAmount, total) {
  if (subtotal == null || taxAmount == null || total == null) {
    return { pass: false, code: 'total_arithmetic', message: 'Missing subtotal, tax, or total' };
  }
  const expected = subtotal + taxAmount;
  const diff = Math.abs(expected - total);
  const pass = diff <= 0.05;
  return {
    pass,
    code: 'total_arithmetic',
    message: pass
      ? `Total arithmetic correct (${subtotal.toFixed(2)} + ${taxAmount.toFixed(2)} = ${expected.toFixed(2)})`
      : `Total mismatch: ${subtotal.toFixed(2)} + ${taxAmount.toFixed(2)} = ${expected.toFixed(2)}, but total is ${total.toFixed(2)} (diff: ${diff.toFixed(2)})`
  };
}

function checkQrTotals(invoice) {
  if (invoice.country !== 'SA' || !invoice.zatcaQr) {
    return null; // Not applicable
  }
  const qr = decodeZatcaQr(invoice.zatcaQr);
  if (!qr.ok) {
    return { pass: false, code: 'qr_decode', message: qr.error || 'Failed to decode ZATCA QR', qr };
  }

  const checks = [];
  // Compare QR total vs invoice total
  if (qr.total != null && Math.abs(qr.total - invoice.total) > 0.05) {
    checks.push(`QR total (${qr.total}) ≠ invoice total (${invoice.total})`);
  }
  // Compare QR VAT vs invoice tax
  if (qr.vatTotal != null && Math.abs(qr.vatTotal - invoice.taxAmount) > 0.05) {
    checks.push(`QR VAT (${qr.vatTotal}) ≠ invoice tax (${invoice.taxAmount})`);
  }

  const pass = checks.length === 0;
  return {
    pass,
    code: 'qr_totals',
    message: pass ? 'QR totals match invoice totals' : checks.join('; '),
    qr
  };
}

function checkMyinvoisLink(link) {
  if (!link) return { pass: false, code: 'myinvois_link', message: 'Missing MyInvois validation link' };
  // Pattern: base URL + uuid + share + long ID
  const valid = /^https?:\/\/.+\/[0-9a-f-]{36}\/share\/[a-zA-Z0-9]+/.test(link);
  return {
    pass: valid,
    code: 'myinvois_link',
    message: valid ? 'MyInvois link format valid' : `Invalid MyInvois link format: ${link}`
  };
}

function checkDuplicate(invoice) {
  const existing = db.prepare(
    'SELECT id, invoiceNumber FROM invoices WHERE invoiceNumber = ? AND supplierId = ? AND id != ?'
  ).get(invoice.invoiceNumber, invoice.supplierId, invoice.id);

  if (existing) {
    return {
      pass: false,
      code: 'duplicate',
      message: `Duplicate invoice number ${invoice.invoiceNumber} from same supplier (existing: ${existing.id})`
    };
  }
  return { pass: true, code: 'duplicate', message: 'No duplicate found' };
}

function checkMissingFields(invoice) {
  const missing = [];
  if (!invoice.invoiceNumber) missing.push('invoiceNumber');
  if (!invoice.issueDate) missing.push('issueDate');
  if (invoice.subtotal == null || invoice.subtotal === 0) missing.push('subtotal');
  if (invoice.total == null || invoice.total === 0) missing.push('total');

  return {
    pass: missing.length === 0,
    code: 'missing_fields',
    message: missing.length === 0 ? 'All required fields present' : `Missing: ${missing.join(', ')}`
  };
}

function checkRejectionWindow(invoice) {
  if (invoice.country !== 'MY' || !invoice.validatedAt) return null;

  const validatedAt = new Date(invoice.validatedAt);
  const deadline = new Date(validatedAt.getTime() + 72 * 60 * 60 * 1000);
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60));

  return {
    open: hoursLeft > 0,
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    deadline: deadline.toISOString()
  };
}

// ─── Main Evaluation ────────────────────────────────────────────────

function evaluateInvoice(invoice) {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(invoice.supplierId);
  const taxId = supplier ? supplier.taxId : null;

  const checks = [];

  // Missing fields
  checks.push(checkMissingFields(invoice));

  // Duplicate
  checks.push(checkDuplicate(invoice));

  // Tax ID format
  checks.push(checkVatNumberFormat(taxId, invoice.country));

  // VAT arithmetic
  checks.push(checkVatArithmetic(invoice.subtotal, invoice.taxAmount, invoice.country));

  // Total arithmetic
  checks.push(checkTotalArithmetic(invoice.subtotal, invoice.taxAmount, invoice.total));

  // Country-specific
  if (invoice.country === 'SA') {
    const qrCheck = checkQrTotals(invoice);
    if (qrCheck) checks.push(qrCheck);
  }

  if (invoice.country === 'MY') {
    if (invoice.myinvoisLink) {
      checks.push(checkMyinvoisLink(invoice.myinvoisLink));
    }
  }

  const blockers = checks.filter(c => !c.pass);
  const warnings = [];

  // QR decode info
  let qr = null;
  if (invoice.country === 'SA' && invoice.zatcaQr) {
    const qrCheck = checks.find(c => c.code === 'qr_totals' || c.code === 'qr_decode');
    qr = qrCheck ? qrCheck.qr : decodeZatcaQr(invoice.zatcaQr);
  }

  // Rejection window
  const rejectionWindow = checkRejectionWindow(invoice);

  // Payment state logic
  let paymentState;
  if (blockers.length > 0) {
    paymentState = 'blocked';
  } else if (!['cleared', 'valid'].includes(invoice.authorityStatus)) {
    paymentState = 'awaiting_authority';
  } else if (invoice.internalStatus !== 'approved') {
    paymentState = 'needs_approval';
  } else {
    paymentState = 'ready';
  }

  // Urgency: has blockers AND open rejection window
  const urgent = blockers.length > 0 && rejectionWindow && rejectionWindow.open;

  // Next action
  let nextAction = '';
  if (paymentState === 'blocked') {
    nextAction = `Fix ${blockers.length} issue(s): ${blockers.map(b => b.message).join('; ')}`;
  } else if (paymentState === 'awaiting_authority') {
    nextAction = invoice.country === 'SA'
      ? 'Submit to ZATCA for clearance'
      : 'Validate on MyInvois portal';
  } else if (paymentState === 'needs_approval') {
    nextAction = 'Approve for payment';
  } else {
    nextAction = 'Ready to pay';
  }

  return {
    paymentState,
    checks,
    blockers,
    warnings,
    nextAction,
    urgent: !!urgent,
    rejectionWindow,
    qr
  };
}

// ─── Supplier Readiness ─────────────────────────────────────────────

function evaluateSupplier(supplier) {
  const checks = [];
  let total = 0;
  let passed = 0;

  // Tax ID check
  total++;
  const taxCheck = checkVatNumberFormat(supplier.taxId, supplier.country);
  checks.push(taxCheck);
  if (taxCheck.pass) passed++;

  // Has email
  total++;
  const emailCheck = {
    pass: !!supplier.email,
    code: 'has_email',
    message: supplier.email ? 'Email on file' : 'No email on file'
  };
  checks.push(emailCheck);
  if (emailCheck.pass) passed++;

  // Country-specific
  if (supplier.country === 'MY') {
    total++;
    const sst = {
      pass: !!supplier.sstNo,
      code: 'sst_number',
      message: supplier.sstNo ? 'SST number on file' : 'Missing SST number'
    };
    checks.push(sst);
    if (sst.pass) passed++;
  }

  if (supplier.country === 'SA') {
    total++;
    const reg = {
      pass: !!supplier.registrationNo,
      code: 'registration',
      message: supplier.registrationNo ? 'CR number on file' : 'Missing CR number'
    };
    checks.push(reg);
    if (reg.pass) passed++;
  }

  const readiness = total > 0 ? Math.round((passed / total) * 100) : 0;
  return { readiness, checks };
}

module.exports = {
  evaluateInvoice,
  evaluateSupplier,
  decodeZatcaQr,
  checkRejectionWindow
};
