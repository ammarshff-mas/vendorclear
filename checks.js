/**
 * VendorClear Check Engine
 * All checks are deterministic — no AI, no LLM calls.
 * Arithmetic, regex, date math, TLV decoding only.
 *
 * Output contract (what the frontend expects):
 *   check      = { id, level: 'pass'|'fail'|'warn'|'info', label, detail, rule }
 *   evaluation = { paymentState, checks[], blockers:number, warnings:number,
 *                  nextAction, urgent, rejectionWindow, qr }
 */

const db = require('./db');

const AUTH_OK = ['cleared', 'reported', 'valid'];
const AUTH_BAD = ['rejected', 'invalid', 'cancelled'];

const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toFixed(2) : String(n));
const check = (id, level, label, detail, rule) => ({ id, level, label, detail, rule });

// ─── ZATCA QR TLV Decoder ───────────────────────────────────────────

function decodeZatcaQr(base64Str) {
  const fail = (error) => ({
    ok: false, sellerName: null, vatNumber: null, timestamp: null,
    total: null, vatTotal: null, hasCryptographicStamp: false, error, tags: []
  });
  try {
    const buf = Buffer.from(String(base64Str).replace(/\s+/g, ''), 'base64');
    const tags = [];
    let offset = 0;
    while (offset < buf.length) {
      if (offset + 2 > buf.length) return fail('QR payload is truncated');
      const tag = buf[offset];
      const len = buf[offset + 1];
      offset += 2;
      if (offset + len > buf.length) return fail('QR payload is truncated');
      tags.push({ tag, length: len, buf: buf.slice(offset, offset + len) });
      offset += len;
    }
    const text = (n) => {
      const t = tags.find((x) => x.tag === n);
      return t ? t.buf.toString('utf8') : null;
    };
    if (tags.length < 5 || [1, 2, 3, 4, 5].some((n) => text(n) === null)) {
      return fail('QR is not a ZATCA TLV payload (tags 1 to 5 are required)');
    }
    return {
      ok: true,
      sellerName: text(1),
      vatNumber: text(2),
      timestamp: text(3),
      total: text(4),
      vatTotal: text(5),
      hasCryptographicStamp: tags.some((t) => t.tag >= 6 && t.tag <= 9),
      error: null,
      tags: tags.map((t) => ({ tag: t.tag, length: t.length, value: t.tag >= 6 ? `[${t.length} bytes]` : t.buf.toString('utf8') }))
    };
  } catch (e) {
    return fail(`Failed to decode QR: ${e.message}`);
  }
}

// ─── Rejection window (Malaysia, 72 hours) ──────────────────────────

function checkRejectionWindow(invoice) {
  if (invoice.country !== 'MY' || !invoice.validatedAt) return null;
  const validatedAt = new Date(invoice.validatedAt);
  if (isNaN(validatedAt.getTime())) return null;
  const deadline = new Date(validatedAt.getTime() + 72 * 3600 * 1000);
  const hoursLeft = Math.max(0, (deadline.getTime() - Date.now()) / 3600000);
  return {
    open: hoursLeft > 0,
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    deadline: deadline.toISOString()
  };
}

// ─── Tax ID checks ──────────────────────────────────────────────────

function taxIdCheck(taxId, country) {
  if (country === 'SA') {
    const rule = 'KSA VAT numbers are 15 digits, starting and ending with 3';
    if (!taxId) return check('tax_id', 'fail', 'Supplier VAT number missing', 'No VAT number is on file for this supplier.', rule);
    return /^3\d{13}3$/.test(taxId)
      ? check('tax_id', 'pass', 'Supplier VAT number format', `${taxId} is a valid KSA VAT number format.`, rule)
      : check('tax_id', 'fail', 'Supplier VAT number format invalid', `${taxId} is not 15 digits starting and ending with 3.`, rule);
  }
  const rule = 'Malaysian TINs start with a prefix such as C or IG followed by digits';
  if (!taxId) return check('tax_id', 'fail', 'Supplier TIN missing', 'No TIN is on file for this supplier.', rule);
  return /^(C|IG)\d+$/.test(taxId)
    ? check('tax_id', 'pass', 'Supplier TIN format', `${taxId} is a valid TIN format.`, rule)
    : check('tax_id', 'fail', 'Supplier TIN format invalid', `${taxId} does not start with C or IG followed by digits.`, rule);
}

// ─── Main Evaluation ────────────────────────────────────────────────

function evaluateInvoice(invoice) {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(invoice.supplierId);
  const checks = [];
  const isSA = invoice.country === 'SA';
  const taxLabel = isSA ? 'VAT' : 'Tax';
  const rate = isSA ? 0.15 : 0.06;
  const rateLabel = isSA ? '15%' : '6%';

  // Required fields
  const missing = [];
  if (!invoice.invoiceNumber) missing.push('invoice number');
  if (!invoice.issueDate) missing.push('issue date');
  if (!invoice.subtotal) missing.push('subtotal');
  if (!invoice.total) missing.push('total');
  checks.push(missing.length === 0
    ? check('required_fields', 'pass', 'Required fields present', 'Invoice number, issue date, subtotal and total are filled in.', 'Invoice number, issue date, subtotal and total are required')
    : check('required_fields', 'fail', 'Required fields missing', `Missing: ${missing.join(', ')}.`, 'Invoice number, issue date, subtotal and total are required'));

  // Duplicate
  const dup = db.prepare('SELECT id FROM invoices WHERE invoiceNumber = ? AND supplierId = ? AND id != ?')
    .get(invoice.invoiceNumber, invoice.supplierId, invoice.id);
  checks.push(dup
    ? check('duplicate', 'fail', 'Possible duplicate', `Invoice ${invoice.invoiceNumber} from this supplier was already filed.`, 'Same supplier and invoice number must not appear twice')
    : check('duplicate', 'pass', 'No duplicate found', 'This supplier has not used this invoice number before.', 'Same supplier and invoice number must not appear twice'));

  // Supplier tax ID
  checks.push(taxIdCheck(supplier ? supplier.taxId : null, invoice.country));

  // Tax arithmetic
  const expectedTax = invoice.subtotal * rate;
  const taxRule = `${taxLabel} must equal ${rateLabel} of the subtotal (±0.05)`;
  checks.push(Math.abs(expectedTax - invoice.taxAmount) <= 0.05
    ? check('tax_arithmetic', 'pass', `${taxLabel} arithmetic`, `${rateLabel} of ${fmt(invoice.subtotal)} = ${fmt(expectedTax)}, matches the ${fmt(invoice.taxAmount)} on the invoice.`, taxRule)
    : check('tax_arithmetic', 'fail', `${taxLabel} arithmetic mismatch`, `${rateLabel} of ${fmt(invoice.subtotal)} = ${fmt(expectedTax)}, but the invoice shows ${fmt(invoice.taxAmount)} (diff ${fmt(Math.abs(expectedTax - invoice.taxAmount))}).`, taxRule));

  // Total arithmetic
  const expectedTotal = invoice.subtotal + invoice.taxAmount;
  const totalRule = `Subtotal + ${taxLabel.toLowerCase()} must equal the total (±0.05)`;
  checks.push(Math.abs(expectedTotal - invoice.total) <= 0.05
    ? check('total_arithmetic', 'pass', 'Total arithmetic', `${fmt(invoice.subtotal)} + ${fmt(invoice.taxAmount)} = ${fmt(expectedTotal)}, matches the total.`, totalRule)
    : check('total_arithmetic', 'fail', 'Total arithmetic mismatch', `${fmt(invoice.subtotal)} + ${fmt(invoice.taxAmount)} = ${fmt(expectedTotal)}, but the invoice total is ${fmt(invoice.total)} (diff ${fmt(Math.abs(expectedTotal - invoice.total))}).`, totalRule));

  // Country-specific evidence
  let qr = null;
  if (isSA) {
    if (!invoice.zatcaQr) {
      checks.push(check('qr_evidence', 'warn', 'ZATCA QR not attached', 'Upload the invoice image or paste the QR Base64 so it can be compared with the printed totals.', 'Every ZATCA e-invoice carries a QR with seller, VAT number, timestamp, total and VAT'));
    } else {
      qr = decodeZatcaQr(invoice.zatcaQr);
      const qrRule = 'QR total (tag 4) and VAT (tag 5) must equal the printed total and VAT';
      if (!qr.ok) {
        checks.push(check('qr_totals', 'fail', 'ZATCA QR could not be decoded', qr.error, qrRule));
      } else {
        const diffs = [];
        if (Math.abs(parseFloat(qr.total) - invoice.total) > 0.05) diffs.push(`QR total (${qr.total}) ≠ invoice total (${invoice.total})`);
        if (Math.abs(parseFloat(qr.vatTotal) - invoice.taxAmount) > 0.05) diffs.push(`QR VAT (${qr.vatTotal}) ≠ invoice tax (${invoice.taxAmount})`);
        checks.push(diffs.length === 0
          ? check('qr_totals', 'pass', 'ZATCA QR matches printed totals', `QR total ${qr.total} and VAT ${qr.vatTotal} match the invoice.`, qrRule)
          : check('qr_totals', 'fail', 'ZATCA QR does not match printed totals', diffs.join('; '), qrRule));

        if (supplier && supplier.taxId && qr.vatNumber && qr.vatNumber !== supplier.taxId) {
          checks.push(check('qr_seller', 'fail', 'QR seller VAT differs from supplier', `QR carries ${qr.vatNumber}, supplier record has ${supplier.taxId}.`, 'QR tag 2 must equal the supplier VAT number'));
        }
        checks.push(qr.hasCryptographicStamp
          ? check('qr_stamp', 'pass', 'QR has a cryptographic stamp', 'Tags 6 to 9 are present.', 'Phase 2 QR codes carry a cryptographic stamp (tags 6 to 9)')
          : check('qr_stamp', 'info', 'QR has no cryptographic stamp', 'Tags 6 to 9 are absent, so authenticity cannot be confirmed from the QR alone.', 'Phase 2 QR codes carry a cryptographic stamp (tags 6 to 9)'));
      }
    }
  } else {
    const linkRule = 'Validation link looks like {portal}/{uuid}/share/{longId} and its UUID matches the invoice';
    if (!invoice.myinvoisLink) {
      checks.push(check('myinvois_link', 'warn', 'MyInvois validation link missing', 'Paste the link from the validated e-invoice QR so its format can be checked.', linkRule));
    } else {
      const m = /^https?:\/\/[^/]+\/([0-9a-fA-F-]{36})\/share\/[A-Za-z0-9]+/.exec(invoice.myinvoisLink);
      if (!m) {
        checks.push(check('myinvois_link', 'fail', 'MyInvois link format invalid', `${invoice.myinvoisLink} does not match the expected pattern.`, linkRule));
      } else if (invoice.myinvoisUuid && m[1].toLowerCase() !== invoice.myinvoisUuid.toLowerCase()) {
        checks.push(check('myinvois_link', 'fail', 'MyInvois link UUID mismatch', `Link carries ${m[1]}, invoice has ${invoice.myinvoisUuid}.`, linkRule));
      } else {
        checks.push(check('myinvois_link', 'pass', 'MyInvois link format', 'Link format is valid and matches the invoice UUID.', linkRule));
      }
    }
  }

  // Authority status
  const status = invoice.authorityStatus;
  const authLabel = isSA ? 'ZATCA' : 'LHDN MyInvois';
  if (AUTH_BAD.includes(status)) {
    checks.push(check('authority', 'fail', `${authLabel} status: ${status}`, `The tax authority status is ${status}, so this invoice cannot be paid.`, 'Authority status must be cleared, reported or valid'));
  } else if (isSA && status === 'reported' && invoice.invoiceType !== 'simplified') {
    checks.push(check('authority', 'fail', 'Standard invoice only reported', 'Standard (B2B) invoices must be cleared by ZATCA, not just reported.', 'Standard (B2B) invoices must be cleared; simplified invoices are reported'));
  } else if (AUTH_OK.includes(status)) {
    checks.push(check('authority', 'pass', `${authLabel} status: ${status}`, 'The tax authority accepts this invoice.', 'Authority status must be cleared, reported or valid'));
  } else {
    checks.push(check('authority', 'warn', `Awaiting ${authLabel}`, `Authority status is ${String(status).replace(/_/g, ' ')}.`, 'Authority status must be cleared, reported or valid'));
  }

  // Malaysian rejection window (information)
  const rejectionWindow = checkRejectionWindow(invoice);
  if (rejectionWindow) {
    checks.push(rejectionWindow.open
      ? check('rejection_window', 'info', 'Buyer rejection window open', `${rejectionWindow.hoursLeft} hours left to reject this validated e-invoice on MyInvois.`, 'A buyer can reject a validated e-invoice only within 72 hours of validation')
      : check('rejection_window', 'info', 'Buyer rejection window closed', 'More than 72 hours have passed since validation. A credit or debit note is now needed.', 'A buyer can reject a validated e-invoice only within 72 hours of validation'));
  }

  const blockers = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  const authorityOk = AUTH_OK.includes(status) && !AUTH_BAD.includes(status);

  let paymentState;
  if (invoice.internalStatus === 'paid') paymentState = 'paid';
  else if (invoice.internalStatus === 'rejected') paymentState = 'rejected';
  else if (blockers > 0) paymentState = 'blocked';
  else if (!authorityOk) paymentState = 'awaiting_authority';
  else if (invoice.internalStatus !== 'approved') paymentState = 'needs_approval';
  else paymentState = 'ready';

  const urgent = blockers > 0 && !!rejectionWindow && rejectionWindow.open && paymentState === 'blocked';

  let nextAction;
  if (paymentState === 'blocked') {
    const fails = checks.filter((c) => c.level === 'fail');
    nextAction = `Fix ${fails.length} issue(s): ${fails.map((c) => c.detail).join(' ')}`;
  } else if (paymentState === 'awaiting_authority') {
    nextAction = isSA ? 'Wait for ZATCA clearance, or record the clearance once you have it.' : 'Wait for LHDN validation, or record the validation once you have it.';
  } else if (paymentState === 'needs_approval') {
    nextAction = invoice.internalStatus === 'on_hold' ? 'On hold. Release it by approving when ready.' : 'Approve for payment.';
  } else if (paymentState === 'ready') {
    nextAction = 'Safe to pay.';
  } else if (paymentState === 'paid') {
    nextAction = 'Paid. Nothing to do.';
  } else {
    nextAction = 'Rejected internally. Ask the supplier for a corrected invoice.';
  }

  return { paymentState, checks, blockers, warnings, nextAction, urgent, rejectionWindow, qr };
}

// ─── Supplier readiness ─────────────────────────────────────────────

function evaluateSupplier(supplier) {
  const isSA = supplier.country === 'SA';
  const checks = [taxIdCheck(supplier.taxId, supplier.country)];

  checks.push(supplier.email
    ? check('email', 'pass', 'Contact email on file', supplier.email, 'A contact email is needed to send fix requests')
    : check('email', 'warn', 'No contact email', 'Add an email so fix requests can reach this supplier.', 'A contact email is needed to send fix requests'));

  checks.push(supplier.registrationNo
    ? check('registration', 'pass', isSA ? 'CR number on file' : 'BRN on file', supplier.registrationNo, isSA ? 'Commercial registration number identifies the supplier' : 'Business registration number identifies the supplier')
    : check('registration', 'warn', isSA ? 'CR number missing' : 'BRN missing', 'Registration number is not on file.', isSA ? 'Commercial registration number identifies the supplier' : 'Business registration number identifies the supplier'));

  if (!isSA) {
    checks.push(supplier.sstNo
      ? check('sst', 'pass', 'SST number on file', supplier.sstNo, 'SST registration is needed to charge sales and service tax')
      : check('sst', 'warn', 'SST number missing', 'SST registration number is not on file.', 'SST registration is needed to charge sales and service tax'));
  }

  const passed = checks.filter((c) => c.level === 'pass').length;
  return { readiness: Math.round((passed / checks.length) * 100), checks };
}

module.exports = { evaluateInvoice, evaluateSupplier, decodeZatcaQr, checkRejectionWindow };
