/**
 * MCP Streamable HTTP handler
 * Implements JSON-RPC 2.0 over HTTP for Claude MCP connector.
 * Tools: create_supplier, update_supplier, create_invoice, update_invoice,
 *        get_invoice_status, get_compliance_summary, get_payment_readiness,
 *        create_fix_request, list_suppliers, list_invoices, reset_demo
 */

const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateInvoice, evaluateSupplier } = require('./checks');
const { seedData } = require('./seed');

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_supplier',
    description: 'Add a new supplier with tax ID, country, and registration details. Returns the created supplier.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Supplier company name' },
        country: { type: 'string', enum: ['SA', 'MY'], description: 'SA for Saudi Arabia, MY for Malaysia' },
        taxId: { type: 'string', description: 'VAT number (SA) or TIN (MY)' },
        registrationNo: { type: 'string', description: 'Commercial registration number (SA only)' },
        sstNo: { type: 'string', description: 'SST registration number (MY only)' },
        email: { type: 'string', description: 'Supplier email for fix requests' }
      },
      required: ['name', 'country']
    }
  },
  {
    name: 'update_supplier',
    description: 'Update an existing supplier\'s details.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Supplier ID' },
        name: { type: 'string' },
        taxId: { type: 'string' },
        registrationNo: { type: 'string' },
        sstNo: { type: 'string' },
        email: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_invoice',
    description: 'File a new supplier invoice. VendorClear will automatically run compliance checks. Returns the invoice with its evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', enum: ['SA', 'MY'] },
        supplierId: { type: 'string', description: 'Supplier ID. If unknown, create the supplier first.' },
        invoiceNumber: { type: 'string', description: 'Invoice number from the document' },
        issueDate: { type: 'string', description: 'Issue date (YYYY-MM-DD)' },
        currency: { type: 'string', enum: ['SAR', 'MYR'] },
        subtotal: { type: 'number', description: 'Subtotal before tax' },
        taxAmount: { type: 'number', description: 'Tax/VAT amount' },
        total: { type: 'number', description: 'Total including tax' },
        poNumber: { type: 'string', description: 'Purchase order number' },
        invoiceType: { type: 'string', enum: ['standard', 'simplified'], description: 'standard (B2B) or simplified (B2C)' },
        zatcaQr: { type: 'string', description: 'Base64-encoded ZATCA QR code data (Saudi invoices)' },
        myinvoisLink: { type: 'string', description: 'MyInvois validation link (Malaysian invoices)' },
        myinvoisUuid: { type: 'string', description: 'MyInvois document UUID' },
        validatedAt: { type: 'string', description: 'When the invoice was validated by the authority (ISO 8601)' }
      },
      required: ['country', 'supplierId', 'invoiceNumber', 'currency', 'subtotal', 'taxAmount', 'total']
    }
  },
  {
    name: 'update_invoice',
    description: 'Update an invoice\'s fields — authority status, internal approval, amounts, or authority data. Checks re-run automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Invoice ID' },
        authorityStatus: { type: 'string', enum: ['pending', 'cleared', 'valid', 'rejected', 'reported'], description: 'Status from ZATCA or LHDN' },
        internalStatus: { type: 'string', enum: ['pending', 'approved', 'on_hold', 'rejected', 'paid'], description: 'Internal finance team approval' },
        subtotal: { type: 'number' },
        taxAmount: { type: 'number' },
        total: { type: 'number' },
        zatcaQr: { type: 'string' },
        myinvoisLink: { type: 'string' },
        myinvoisUuid: { type: 'string' },
        validatedAt: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_invoice_status',
    description: 'Get the full compliance evaluation of an invoice: payment state, all checks, blockers, warnings, QR decode, rejection window.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Invoice ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_compliance_summary',
    description: 'Get the dashboard summary: counts by payment state, amounts ready/blocked, open rejection windows, and the action queue.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payment_readiness',
    description: 'List all invoices that are ready to pay this week.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_fix_request',
    description: 'Send a fix request to a supplier for a blocked invoice. Returns a public link the supplier opens without login.',
    inputSchema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Invoice ID' },
        message: { type: 'string', description: 'Message to the supplier explaining what needs fixing' }
      },
      required: ['invoiceId', 'message']
    }
  },
  {
    name: 'list_suppliers',
    description: 'List all suppliers, optionally filtered by country.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', enum: ['SA', 'MY'], description: 'Filter by country' }
      }
    }
  },
  {
    name: 'list_invoices',
    description: 'List all invoices with their evaluations, optionally filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        supplierId: { type: 'string', description: 'Filter by supplier' },
        country: { type: 'string', enum: ['SA', 'MY'] },
        paymentState: { type: 'string', enum: ['ready', 'blocked', 'awaiting_authority', 'needs_approval'] }
      }
    }
  },
  {
    name: 'reset_demo',
    description: 'Reset to sample data with 3 suppliers and 3 invoices. Use before demos.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ─── Tool Handlers ──────────────────────────────────────────────────

let BASE_URL = process.env.PUBLIC_URL || '';

function handleTool(name, args) {
  switch (name) {
    case 'create_supplier': return createSupplier(args);
    case 'update_supplier': return updateSupplier(args);
    case 'create_invoice': return createInvoice(args);
    case 'update_invoice': return updateInvoice(args);
    case 'get_invoice_status': return getInvoiceStatus(args);
    case 'get_compliance_summary': return getComplianceSummary();
    case 'get_payment_readiness': return getPaymentReadiness();
    case 'create_fix_request': return createFixRequest(args);
    case 'list_suppliers': return listSuppliers(args);
    case 'list_invoices': return listInvoices(args);
    case 'reset_demo': return resetDemo();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function createSupplier(args) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO suppliers (id, name, country, taxId, registrationNo, sstNo, email, source, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', ?, ?)
  `).run(id, args.name, args.country, args.taxId || null, args.registrationNo || null,
    args.sstNo || null, args.email || null, now, now);

  logActivity(null, id, 'claude', 'supplier_created', `Supplier "${args.name}" created`);

  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  const eval_ = evaluateSupplier(supplier);
  return { ...supplier, ...eval_ };
}

function updateSupplier(args) {
  const { id, ...fields } = args;
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!supplier) throw new Error(`Supplier not found: ${id}`);

  const updates = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['name', 'taxId', 'registrationNo', 'sstNo', 'email'].includes(k)) {
      updates.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    logActivity(null, id, 'claude', 'supplier_updated', `Updated: ${Object.keys(fields).join(', ')}`);
  }

  const updated = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  const eval_ = evaluateSupplier(updated);
  return { ...updated, ...eval_ };
}

function createInvoice(args) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO invoices (id, supplierId, country, invoiceNumber, issueDate, currency, subtotal, taxAmount, total, poNumber, invoiceType, authorityStatus, internalStatus, zatcaQr, myinvoisLink, myinvoisUuid, validatedAt, source, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, 'claude', ?, ?)
  `).run(
    id, args.supplierId, args.country, args.invoiceNumber,
    args.issueDate || null, args.currency,
    args.subtotal, args.taxAmount, args.total,
    args.poNumber || null, args.invoiceType || 'standard',
    args.zatcaQr || null, args.myinvoisLink || null,
    args.myinvoisUuid || null, args.validatedAt || null,
    now, now
  );

  logActivity(id, args.supplierId, 'claude', 'invoice_created', `Invoice ${args.invoiceNumber} filed`);

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  const evaluation = evaluateInvoice(invoice);
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplierId);

  return { ...invoice, evaluation, supplier: supplier || { name: 'Unknown' } };
}

function updateInvoice(args) {
  const { id, ...fields } = args;
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw new Error(`Invoice not found: ${id}`);

  const allowed = ['authorityStatus', 'authorityStatusSource', 'internalStatus', 'subtotal', 'taxAmount', 'total', 'zatcaQr', 'myinvoisLink', 'myinvoisUuid', 'validatedAt', 'poNumber', 'invoiceNumber', 'issueDate', 'dueDate'];
  const updates = [];
  const values = [];
  const changes = [];

  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      updates.push(`${k} = ?`);
      values.push(v);
      changes.push(`${k}: ${invoice[k]} → ${v}`);
    }
  }

  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE invoices SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    logActivity(id, invoice.supplierId, 'claude', 'invoice_updated', changes.join(', '));
  }

  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  const evaluation = evaluateInvoice(updated);
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(updated.supplierId);

  return { ...updated, evaluation, supplier: supplier || { name: 'Unknown' } };
}

function getInvoiceStatus(args) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(args.id);
  if (!invoice) throw new Error(`Invoice not found: ${args.id}`);

  const evaluation = evaluateInvoice(invoice);
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplierId);
  const fixRequests = db.prepare('SELECT * FROM fix_requests WHERE invoiceId = ? ORDER BY createdAt DESC').all(invoice.id);
  const activity = db.prepare('SELECT * FROM activity WHERE invoiceId = ? ORDER BY createdAt DESC LIMIT 20').all(invoice.id);

  return { ...invoice, evaluation, supplier: supplier || { name: 'Unknown' }, fixRequests, activity };
}

function getComplianceSummary() {
  const invoices = db.prepare('SELECT * FROM invoices').all();
  const byState = { ready: 0, blocked: 0, awaiting_authority: 0, needs_approval: 0 };
  const amounts = {
    ready: { SAR: 0, MYR: 0 },
    blocked: { SAR: 0, MYR: 0 },
    awaiting_authority: { SAR: 0, MYR: 0 },
    needs_approval: { SAR: 0, MYR: 0 }
  };
  const windowsOpen = [];
  const queue = [];
  const ready = [];

  for (const inv of invoices) {
    const evaluation = evaluateInvoice(inv);
    const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(inv.supplierId);
    const state = evaluation.paymentState;

    byState[state] = (byState[state] || 0) + 1;
    if (amounts[state]) {
      amounts[state][inv.currency] = (amounts[state][inv.currency] || 0) + inv.total;
    }

    if (evaluation.rejectionWindow && evaluation.rejectionWindow.open) {
      windowsOpen.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        hoursLeft: evaluation.rejectionWindow.hoursLeft,
        blocked: state === 'blocked'
      });
    }

    if (state !== 'ready') {
      queue.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        state,
        supplier: supplier ? supplier.name : 'Unknown',
        country: inv.country,
        currency: inv.currency,
        total: inv.total,
        nextAction: evaluation.nextAction,
        urgent: evaluation.urgent
      });
    } else {
      ready.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        supplier: supplier ? supplier.name : 'Unknown',
        currency: inv.currency,
        total: inv.total
      });
    }
  }

  // Sort queue: urgent first, then by total desc
  queue.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || b.total - a.total);

  return { byState, amounts, windowsOpen, queue, ready };
}

function getPaymentReadiness() {
  const summary = getComplianceSummary();
  return {
    ready: summary.ready,
    totalReady: {
      SAR: summary.amounts.ready.SAR,
      MYR: summary.amounts.ready.MYR
    },
    windowsClosingSoon: summary.windowsOpen.filter(w => w.hoursLeft < 24)
  };
}

function createFixRequest(args) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(args.invoiceId);
  if (!invoice) throw new Error(`Invoice not found: ${args.invoiceId}`);

  const token = uuidv4().replace(/-/g, '').slice(0, 16);
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO fix_requests (id, invoiceId, token, message, status, createdBy, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'open', 'claude', ?, ?)
  `).run(id, args.invoiceId, token, args.message, now, now);

  logActivity(args.invoiceId, invoice.supplierId, 'claude', 'fix_request_created', `Fix request sent: ${args.message}`);

  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplierId);

  return {
    id,
    token,
    invoiceId: args.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    supplierName: supplier ? supplier.name : 'Unknown',
    message: args.message,
    publicUrl: `${BASE_URL}/#/fix/${token}`,
    status: 'open'
  };
}

function listSuppliers(args) {
  let query = 'SELECT * FROM suppliers';
  const params = [];
  if (args && args.country) {
    query += ' WHERE country = ?';
    params.push(args.country);
  }
  query += ' ORDER BY name';

  const suppliers = db.prepare(query).all(...params);
  return suppliers.map(s => {
    const eval_ = evaluateSupplier(s);
    const invoiceCount = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE supplierId = ?').get(s.id).count;
    return { ...s, ...eval_, invoiceCount };
  });
}

function listInvoices(args) {
  let query = 'SELECT * FROM invoices';
  const conditions = [];
  const params = [];

  if (args && args.supplierId) { conditions.push('supplierId = ?'); params.push(args.supplierId); }
  if (args && args.country) { conditions.push('country = ?'); params.push(args.country); }

  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY createdAt DESC';

  const invoices = db.prepare(query).all(...params);
  const results = invoices.map(inv => {
    const evaluation = evaluateInvoice(inv);
    const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(inv.supplierId);
    return { ...inv, evaluation, supplier: supplier || { name: 'Unknown' } };
  });

  // Filter by payment state if requested
  if (args && args.paymentState) {
    return results.filter(r => r.evaluation.paymentState === args.paymentState);
  }
  return results;
}

function resetDemo() {
  seedData();
  return { success: true, message: 'Demo data reset. 3 suppliers and 3 invoices restored.' };
}

// ─── Activity Logger ────────────────────────────────────────────────

function logActivity(invoiceId, supplierId, actor, action, detail) {
  db.prepare(`
    INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), invoiceId, supplierId, actor, action, detail);
}

// ─── MCP Protocol Handler ───────────────────────────────────────────

function handleMcpRequest(body, baseUrl) {
  if (baseUrl) BASE_URL = baseUrl;
  // Handle single request or batch
  if (Array.isArray(body)) {
    return body.map(req => processJsonRpc(req));
  }
  return processJsonRpc(body);
}

function processJsonRpc(req) {
  const { jsonrpc, id, method, params } = req;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0' } };
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'VendorClear',
              version: '1.0.0'
            }
          }
        };

      case 'notifications/initialized':
        // Notification — no response needed, but if id is present, respond
        if (id !== undefined) {
          return { jsonrpc: '2.0', id, result: {} };
        }
        return null;

      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: { tools: TOOLS }
        };

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const result = handleTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            }
          };
        } catch (e) {
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
              isError: true
            }
          };
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  } catch (e) {
    return {
      jsonrpc: '2.0', id,
      error: { code: -32603, message: `Internal error: ${e.message}` }
    };
  }
}

module.exports = { handleMcpRequest, TOOLS };
