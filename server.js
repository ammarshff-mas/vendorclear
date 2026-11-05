/**
 * VendorClear Server
 * Express app serving:
 *   - REST API under /port/5000/api/
 *   - MCP Streamable HTTP at /port/5000/mcp
 *   - Static frontend from /public
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const { evaluateInvoice, evaluateSupplier } = require('./checks');
const { handleMcpRequest } = require('./mcp-handler');
const { seedData } = require('./seed');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── API Routes (mounted at /port/5000/api AND /api) ────────────

const api = express.Router();

// --- Summary (dashboard) ---
api.get('/summary', (req, res) => {
  try {
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

    queue.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || b.total - a.total);
    res.json({ byState, amounts, windowsOpen, queue, ready });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Invoices ---
api.get('/invoices', (req, res) => {
  try {
    const invoices = db.prepare('SELECT * FROM invoices ORDER BY createdAt DESC').all();
    const results = invoices.map(inv => {
      const evaluation = evaluateInvoice(inv);
      const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(inv.supplierId);
      return { ...inv, evaluation, supplier: supplier || { name: 'Unknown' } };
    });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.get('/invoices/:id', (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const evaluation = evaluateInvoice(invoice);
    const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplierId);
    const fixRequests = db.prepare('SELECT * FROM fix_requests WHERE invoiceId = ? ORDER BY createdAt DESC').all(invoice.id);
    const activity = db.prepare('SELECT * FROM activity WHERE invoiceId = ? ORDER BY createdAt DESC LIMIT 50').all(invoice.id);

    res.json({ ...invoice, evaluation, supplier: supplier || { name: 'Unknown' }, fixRequests, activity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/invoices', (req, res) => {
  try {
    const { country, supplierId, invoiceNumber, issueDate, currency, subtotal, taxAmount, total,
      poNumber, invoiceType, zatcaQr, myinvoisLink, myinvoisUuid, validatedAt } = req.body;

    if (!country || !supplierId || !invoiceNumber || !currency) {
      return res.status(400).json({ error: 'Missing required fields: country, supplierId, invoiceNumber, currency' });
    }

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) return res.status(400).json({ error: `Supplier not found: ${supplierId}` });

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO invoices (id, supplierId, country, invoiceNumber, issueDate, currency, subtotal, taxAmount, total, poNumber, invoiceType, authorityStatus, internalStatus, zatcaQr, myinvoisLink, myinvoisUuid, validatedAt, source, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, 'user', ?, ?)
    `).run(id, supplierId, country, invoiceNumber, issueDate || null, currency,
      subtotal || 0, taxAmount || 0, total || 0, poNumber || null,
      invoiceType || 'standard', zatcaQr || null, myinvoisLink || null,
      myinvoisUuid || null, validatedAt || null, now, now);

    // Log activity
    db.prepare(`INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
      VALUES (?, ?, ?, 'user', 'invoice_created', ?, ?)`).run(
      uuidv4(), id, supplierId, `Invoice ${invoiceNumber} created`, now);

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    const evaluation = evaluateInvoice(invoice);
    res.json({ ...invoice, evaluation, supplier: { name: supplier.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.patch('/invoices/:id', (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const allowed = ['authorityStatus', 'authorityStatusSource', 'internalStatus', 'subtotal',
      'taxAmount', 'total', 'zatcaQr', 'myinvoisLink', 'myinvoisUuid', 'validatedAt',
      'poNumber', 'invoiceNumber', 'issueDate', 'dueDate', 'invoiceType'];
    const updates = [];
    const values = [];
    const changes = [];

    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) {
        updates.push(`${k} = ?`);
        values.push(v);
        changes.push(`${k}: ${invoice[k]} → ${v}`);
      }
    }

    if (updates.length > 0) {
      updates.push("updatedAt = datetime('now')");
      values.push(req.params.id);
      db.prepare(`UPDATE invoices SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      db.prepare(`INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
        VALUES (?, ?, ?, 'user', 'invoice_updated', ?, datetime('now'))`).run(
        uuidv4(), req.params.id, invoice.supplierId, changes.join(', '));
    }

    const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    const evaluation = evaluateInvoice(updated);
    const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(updated.supplierId);
    res.json({ ...updated, evaluation, supplier: supplier || { name: 'Unknown' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Suppliers ---
api.get('/suppliers', (req, res) => {
  try {
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    const results = suppliers.map(s => {
      const eval_ = evaluateSupplier(s);
      const invoiceCount = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE supplierId = ?').get(s.id).count;
      return { ...s, ...eval_, invoiceCount };
    });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.get('/suppliers/:id', (req, res) => {
  try {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const eval_ = evaluateSupplier(supplier);
    const invoiceCount = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE supplierId = ?').get(supplier.id).count;
    const invoices = db.prepare('SELECT * FROM invoices WHERE supplierId = ? ORDER BY createdAt DESC').all(supplier.id);
    const invoicesWithEval = invoices.map(inv => ({ ...inv, evaluation: evaluateInvoice(inv) }));

    res.json({ ...supplier, ...eval_, invoiceCount, invoices: invoicesWithEval });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/suppliers', (req, res) => {
  try {
    const { name, country, taxId, registrationNo, sstNo, email } = req.body;
    if (!name || !country) return res.status(400).json({ error: 'Missing required fields: name, country' });

    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO suppliers (id, name, country, taxId, registrationNo, sstNo, email, source, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
    `).run(id, name, country, taxId || null, registrationNo || null, sstNo || null, email || null, now, now);

    db.prepare(`INSERT INTO activity (id, supplierId, actor, action, detail, createdAt)
      VALUES (?, ?, 'user', 'supplier_created', ?, ?)`).run(uuidv4(), id, `Supplier "${name}" created`, now);

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    const eval_ = evaluateSupplier(supplier);
    res.json({ ...supplier, ...eval_, invoiceCount: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.patch('/suppliers/:id', (req, res) => {
  try {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const allowed = ['name', 'taxId', 'registrationNo', 'sstNo', 'email'];
    const updates = [];
    const values = [];

    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) {
        updates.push(`${k} = ?`);
        values.push(v);
      }
    }

    if (updates.length > 0) {
      updates.push("updatedAt = datetime('now')");
      values.push(req.params.id);
      db.prepare(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const updated = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    const eval_ = evaluateSupplier(updated);
    const invoiceCount = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE supplierId = ?').get(updated.id).count;
    res.json({ ...updated, ...eval_, invoiceCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Activity ---
api.get('/activity', (req, res) => {
  try {
    const activities = db.prepare('SELECT * FROM activity ORDER BY createdAt DESC LIMIT 100').all();
    res.json(activities);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Config ---
api.get('/config', (req, res) => {
  const host = req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  res.json({
    mcpUrl: `${protocol}://${host}/port/5000/mcp`
  });
});

// --- Reset ---
api.post('/reset', (req, res) => {
  try {
    seedData();
    res.json({ success: true, message: 'Demo data reset successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Fix Requests ---
api.get('/public/fix/:token', (req, res) => {
  try {
    const fixReq = db.prepare('SELECT * FROM fix_requests WHERE token = ?').get(req.params.token);
    if (!fixReq) return res.status(404).json({ error: 'Fix request not found' });

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(fixReq.invoiceId);
    const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice?.supplierId);
    const evaluation = invoice ? evaluateInvoice(invoice) : null;

    // Issues = blockers from evaluation
    const issues = evaluation ? evaluation.blockers.map(b => ({
      code: b.code,
      message: b.message,
      pass: false
    })) : [];

    res.json({
      invoice: {
        invoiceNumber: invoice?.invoiceNumber,
        supplierName: supplier?.name || 'Unknown',
        issueDate: invoice?.issueDate,
        currency: invoice?.currency,
        total: invoice?.total,
        issues
      },
      request: {
        message: fixReq.message,
        status: fixReq.status,
        supplierResponse: fixReq.supplierResponse,
        correctedInvoiceNumber: fixReq.correctedInvoiceNumber
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/public/fix/:token/respond', (req, res) => {
  try {
    const fixReq = db.prepare('SELECT * FROM fix_requests WHERE token = ?').get(req.params.token);
    if (!fixReq) return res.status(404).json({ error: 'Fix request not found' });

    const { response, correctedInvoiceNumber } = req.body;

    db.prepare(`UPDATE fix_requests SET supplierResponse = ?, correctedInvoiceNumber = ?, status = 'responded', updatedAt = datetime('now') WHERE id = ?`)
      .run(response || null, correctedInvoiceNumber || null, fixReq.id);

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(fixReq.invoiceId);
    if (invoice) {
      db.prepare(`INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
        VALUES (?, ?, ?, 'supplier', 'fix_response', ?, datetime('now'))`).run(
        uuidv4(), invoice.id, invoice.supplierId,
        `Supplier responded: ${response || ''}${correctedInvoiceNumber ? ` (corrected: ${correctedInvoiceNumber})` : ''}`);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/invoices/:id/fix-requests', (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const token = uuidv4().replace(/-/g, '').slice(0, 16);
    const id = uuidv4();
    const { message } = req.body;

    db.prepare(`INSERT INTO fix_requests (id, invoiceId, token, message, status, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'open', 'user', datetime('now'), datetime('now'))`).run(
      id, req.params.id, token, message || '');

    db.prepare(`INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
      VALUES (?, ?, ?, 'user', 'fix_request_created', ?, datetime('now'))`).run(
      uuidv4(), req.params.id, invoice.supplierId, `Fix request: ${message || ''}`);

    res.json({ id, token, invoiceId: req.params.id, status: 'open', message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.post('/fix-requests/:id/resolve', (req, res) => {
  try {
    const fixReq = db.prepare('SELECT * FROM fix_requests WHERE id = ?').get(req.params.id);
    if (!fixReq) return res.status(404).json({ error: 'Fix request not found' });

    db.prepare(`UPDATE fix_requests SET status = 'resolved', updatedAt = datetime('now') WHERE id = ?`)
      .run(req.params.id);

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(fixReq.invoiceId);
    if (invoice) {
      db.prepare(`INSERT INTO activity (id, invoiceId, supplierId, actor, action, detail, createdAt)
        VALUES (?, ?, ?, 'user', 'fix_request_resolved', 'Fix request resolved', datetime('now'))`).run(
        uuidv4(), invoice.id, invoice.supplierId);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mount API at both paths (frontend uses /port/5000/api)
app.use('/port/5000/api', api);
app.use('/api', api);

// ─── MCP Endpoint ───────────────────────────────────────────────────

function mcpHandler(req, res) {
  // Handle OPTIONS for CORS preflight
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    });
    return res.status(204).end();
  }

  // Handle GET — SSE endpoint for server-to-client notifications (required by spec)
  if (req.method === 'GET') {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Mcp-Session-Id': 'vendorclear-session'
    });
    res.flushHeaders();
    // Keep connection open — client can receive notifications
    // For now, just send a comment to keep alive
    res.write(':ok\n\n');
    // Don't close — let client close
    req.on('close', () => { /* client disconnected */ });
    return;
  }

  // Handle DELETE — session termination
  if (req.method === 'DELETE') {
    return res.status(200).json({ jsonrpc: '2.0', result: {} });
  }

  // POST — JSON-RPC request
  if (req.method === 'POST') {
    const sessionId = req.headers['mcp-session-id'] || 'vendorclear-session';

    try {
      const proto = req.get('x-forwarded-proto') || req.protocol;
      const result = handleMcpRequest(req.body, process.env.PUBLIC_URL || `${proto}://${req.get('host')}`);

      // Filter out null responses (notifications)
      if (result === null) {
        return res.status(202).end();
      }

      if (Array.isArray(result)) {
        const filtered = result.filter(r => r !== null);
        if (filtered.length === 0) return res.status(202).end();
        res.set({
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Mcp-Session-Id': sessionId
        });
        return res.json(filtered.length === 1 ? filtered[0] : filtered);
      }

      res.set({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Mcp-Session-Id': sessionId
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: e.message }
      });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

app.all('/port/5000/mcp', mcpHandler);
app.all('/mcp', mcpHandler);

// ─── Static Files ───────────────────────────────────────────────────

// Serve sample files
app.use('/port/5000/samples', express.static(path.join(__dirname, 'public', 'samples')));
app.use('/samples', express.static(path.join(__dirname, 'public', 'samples')));

// Serve frontend
app.use('/port/5000', express.static(path.join(__dirname, 'public')));
app.use('/', express.static(path.join(__dirname, 'public')));

// SPA fallback - serve index.html for any unmatched route
app.get('*', (req, res) => {
  // Don't serve index.html for API or MCP routes
  if (req.path.includes('/api/') || req.path.includes('/mcp')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ────────────────────────────────────────────────────────

// Seed data if database is empty
const count = db.prepare('SELECT COUNT(*) as count FROM suppliers').get().count;
if (count === 0) {
  console.log('Empty database — seeding sample data...');
  seedData();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VendorClear running on http://0.0.0.0:${PORT}`);
  console.log(`  Frontend: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/port/5000/api/summary`);
  console.log(`  MCP:      http://localhost:${PORT}/port/5000/mcp`);
});
