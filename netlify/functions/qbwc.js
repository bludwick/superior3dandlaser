// QuickBooks Web Connector (QBWC) SOAP endpoint.
//
// QBWC runs on the admin's Windows machine alongside QB Desktop. It polls
// this endpoint on an interval (configured in the .qwc file) and invokes the
// following SOAP methods in sequence:
//
//   serverVersion        → returns our version string
//   clientVersion        → approves the QBWC client version
//   authenticate         → validates username/password, returns session ticket
//   sendRequestXML       → we return the next qbXML request to execute
//   receiveResponseXML   → we ingest the response and return % progress
//   closeConnection      → end of session; we return 'OK'
//   connectionError, getLastError → error reporting paths
//
// The SOAP envelope shape is narrow and well-documented; we parse it by hand
// (regex) and parse the qbXML body with xml2js.

const bcrypt = require('bcryptjs');
const xml2js = require('xml2js');

const qb = require('./_lib/qb-queue');

const SERVER_VERSION = '1.0.0';
const MIN_QBWC_VERSION = '2.1.0.30';

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function soapEnvelope(methodName, responseField, value) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${methodName}Response xmlns="http://developer.intuit.com/">
      <${responseField}>${value}</${responseField}>
    </${methodName}Response>
  </soap:Body>
</soap:Envelope>`;
}

function soapAuthEnvelope(ticket, companyFile) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <authenticateResponse xmlns="http://developer.intuit.com/">
      <authenticateResult>
        <string>${xmlEscape(ticket)}</string>
        <string>${xmlEscape(companyFile)}</string>
      </authenticateResult>
    </authenticateResponse>
  </soap:Body>
</soap:Envelope>`;
}

function soapResponse(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body,
  };
}

function detectMethod(body) {
  const names = [
    'serverVersion', 'clientVersion', 'authenticate',
    'sendRequestXML', 'receiveResponseXML',
    'closeConnection', 'connectionError', 'getLastError',
  ];
  for (const n of names) {
    // Tolerant to namespace prefix and whitespace.
    if (new RegExp(`<(?:[a-zA-Z0-9_]+:)?${n}[\\s>]`).test(body)) return n;
  }
  return null;
}

function getTagText(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_]+:)?${tag}>`);
  const m = xml.match(re);
  if (!m) return null;
  // Strip CDATA wrappers and decode basic entities.
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1];
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── qbXML builders ──────────────────────────────────────────────────────────
const QBXML_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">`;
const QBXML_FOOTER = `  </QBXMLMsgsRq>
</QBXML>`;

function buildCustomerQueryRq(email) {
  return `${QBXML_HEADER}
    <CustomerQueryRq requestID="1">
      <MaxReturned>1</MaxReturned>
      <ActiveStatus>All</ActiveStatus>
      <NameFilter>
        <MatchCriterion>Contains</MatchCriterion>
        <Name>${xmlEscape(email)}</Name>
      </NameFilter>
    </CustomerQueryRq>
${QBXML_FOOTER}`;
}

function buildCustomerAddRq(job) {
  const fullName = (job.customerName || job.customerEmail || 'Customer').slice(0, 41);
  return `${QBXML_HEADER}
    <CustomerAddRq requestID="1">
      <CustomerAdd>
        <Name>${xmlEscape(fullName)}</Name>
        ${job.customerName ? `<CompanyName>${xmlEscape(job.customerName)}</CompanyName>` : ''}
        ${job.customerEmail ? `<Email>${xmlEscape(job.customerEmail)}</Email>` : ''}
        ${job.customerPhone ? `<Phone>${xmlEscape(job.customerPhone)}</Phone>` : ''}
      </CustomerAdd>
    </CustomerAddRq>
${QBXML_FOOTER}`;
}

function buildLines(job, defaultItemName, taxCodeRef) {
  const lines = (job.items || []).map((it) => {
    const qty  = parseFloat(it.qty) || 1;
    const rate = parseFloat(it.unitPrice) || 0;
    const desc = [it.partName || 'Part', it.material || '', it.color || ''].filter(Boolean).join(' — ');
    return `        <InvoiceLineAdd>
          <ItemRef><FullName>${xmlEscape(defaultItemName)}</FullName></ItemRef>
          <Desc>${xmlEscape(desc)}</Desc>
          <Quantity>${qty}</Quantity>
          <Rate>${rate.toFixed(2)}</Rate>
          <SalesTaxCodeRef><FullName>${xmlEscape(taxCodeRef)}</FullName></SalesTaxCodeRef>
        </InvoiceLineAdd>`;
  }).join('\n');
  return lines || `        <InvoiceLineAdd>
          <ItemRef><FullName>${xmlEscape(defaultItemName)}</FullName></ItemRef>
          <Desc>Print Job ${xmlEscape(job.id || '')}</Desc>
          <Quantity>1</Quantity>
          <Rate>${(parseFloat(job.total) || 0).toFixed(2)}</Rate>
          <SalesTaxCodeRef><FullName>${xmlEscape(taxCodeRef)}</FullName></SalesTaxCodeRef>
        </InvoiceLineAdd>`;
}

function buildSalesReceiptLines(job, defaultItemName, taxCodeRef) {
  // Same shape, different element name.
  return buildLines(job, defaultItemName, taxCodeRef).replace(/InvoiceLineAdd/g, 'SalesReceiptLineAdd');
}

function buildInvoiceAddRq(job, customerListId, settings) {
  const taxCode = (parseFloat(job.tax) || 0) > 0 ? settings.defaultTaxCode : settings.nonTaxCode;
  return `${QBXML_HEADER}
    <InvoiceAddRq requestID="1">
      <InvoiceAdd>
        <CustomerRef><ListID>${xmlEscape(customerListId)}</ListID></CustomerRef>
        <TxnDate>${(job.createdAt || new Date().toISOString()).slice(0, 10)}</TxnDate>
        <RefNumber>${xmlEscape(job.id || '')}</RefNumber>
        ${job.notes ? `<Memo>${xmlEscape(String(job.notes).slice(0, 4000))}</Memo>` : ''}
${buildLines(job, settings.defaultItemName, taxCode)}
      </InvoiceAdd>
    </InvoiceAddRq>
${QBXML_FOOTER}`;
}

function buildSalesReceiptAddRq(job, customerListId, settings) {
  const taxCode = (parseFloat(job.tax) || 0) > 0 ? settings.defaultTaxCode : settings.nonTaxCode;
  return `${QBXML_HEADER}
    <SalesReceiptAddRq requestID="1">
      <SalesReceiptAdd>
        <CustomerRef><ListID>${xmlEscape(customerListId)}</ListID></CustomerRef>
        <TxnDate>${(job.paidAt || job.createdAt || new Date().toISOString()).slice(0, 10)}</TxnDate>
        <RefNumber>${xmlEscape(job.id || '')}</RefNumber>
        ${settings.paymentMethod ? `<PaymentMethodRef><FullName>${xmlEscape(settings.paymentMethod)}</FullName></PaymentMethodRef>` : ''}
        ${job.notes ? `<Memo>${xmlEscape(String(job.notes).slice(0, 4000))}</Memo>` : ''}
${buildSalesReceiptLines(job, settings.defaultItemName, taxCode)}
      </SalesReceiptAdd>
    </SalesReceiptAddRq>
${QBXML_FOOTER}`;
}

function buildReceivePaymentAddRq(job, customerListId, invoiceTxnId, settings) {
  const amount = (parseFloat(job.total) || 0).toFixed(2);
  return `${QBXML_HEADER}
    <ReceivePaymentAddRq requestID="1">
      <ReceivePaymentAdd>
        <CustomerRef><ListID>${xmlEscape(customerListId)}</ListID></CustomerRef>
        <TxnDate>${(job.paidAt || new Date().toISOString()).slice(0, 10)}</TxnDate>
        <RefNumber>PMT-${xmlEscape(job.id || '')}</RefNumber>
        <TotalAmount>${amount}</TotalAmount>
        ${settings.paymentMethod ? `<PaymentMethodRef><FullName>${xmlEscape(settings.paymentMethod)}</FullName></PaymentMethodRef>` : ''}
        <AppliedToTxnAdd>
          <TxnID>${xmlEscape(invoiceTxnId)}</TxnID>
          <PaymentAmount>${amount}</PaymentAmount>
        </AppliedToTxnAdd>
      </ReceivePaymentAdd>
    </ReceivePaymentAddRq>
${QBXML_FOOTER}`;
}

// ── qbXML response parsing ──────────────────────────────────────────────────
async function parseQbxml(xml) {
  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false, mergeAttrs: true });
  return parser.parseStringPromise(xml);
}

// Walk a parsed response looking for the first *Rs node and return its attrs + retObj.
function extractRs(parsed) {
  if (!parsed || !parsed.QBXML || !parsed.QBXML.QBXMLMsgsRs) return null;
  const msgs = parsed.QBXML.QBXMLMsgsRs;
  for (const key of Object.keys(msgs)) {
    if (/Rs$/.test(key)) {
      return { name: key, node: msgs[key] };
    }
  }
  return null;
}

// ── Task → qbXML (multi-step sync for a single job) ─────────────────────────
// To add an invoice we may need to first query/add the customer. We track
// sub-steps inside task.payload.stage:
//   stage (undefined|null) → CustomerQueryRq
//   stage='queried'        → CustomerAddRq (if query failed) OR skip to main op
//   stage='customer_ready' → main op (Invoice / SalesReceipt / Payment)
async function buildRequestForTask(task, settings) {
  const job = await qb.getJob(task.jobId);
  if (!job) {
    throw new Error(`Job not found: ${task.jobId}`);
  }
  task.payload = task.payload || {};

  // Resolve customer listId if we have it cached or already resolved this round.
  if (!task.payload.customerListId) {
    const cached = await qb.getCachedCustomer(job.customerEmail);
    if (cached && cached.listId) {
      task.payload.customerListId = cached.listId;
    }
  }

  if (!task.payload.customerListId) {
    if (!task.payload.stage || task.payload.stage === 'init') {
      task.payload.stage = 'querying_customer';
      await qb.saveTask(task);
      return buildCustomerQueryRq(job.customerEmail || job.customerName || '');
    }
    if (task.payload.stage === 'needs_add') {
      task.payload.stage = 'adding_customer';
      await qb.saveTask(task);
      return buildCustomerAddRq(job);
    }
  }

  // Main operation.
  const customerListId = task.payload.customerListId;
  if (task.op === 'invoice') {
    return buildInvoiceAddRq(job, customerListId, settings);
  }
  if (task.op === 'sales_receipt') {
    return buildSalesReceiptAddRq(job, customerListId, settings);
  }
  if (task.op === 'payment') {
    // We need the invoice TxnID — stored on a prior 'invoice' task for this job.
    const all = await qb.listTasks();
    const invoiceTask = all.find(t => t.jobId === task.jobId && t.op === 'invoice' && t.status === 'done' && t.qbTxnId);
    if (!invoiceTask) {
      throw new Error(`No completed invoice task found for jobId=${task.jobId}`);
    }
    return buildReceivePaymentAddRq(job, customerListId, invoiceTask.qbTxnId, settings);
  }
  throw new Error(`Unknown op: ${task.op}`);
}

async function ingestResponseForTask(task, responseXml) {
  const parsed = await parseQbxml(responseXml).catch(e => {
    throw new Error('qbXML parse error: ' + e.message);
  });
  const rs = extractRs(parsed);
  if (!rs) throw new Error('No response block found in qbXML');

  const statusCode = rs.node.statusCode || (rs.node.$ && rs.node.$.statusCode) || '0';
  const statusMsg  = rs.node.statusMessage || (rs.node.$ && rs.node.$.statusMessage) || '';

  // Stage-based dispatch.
  if (rs.name === 'CustomerQueryRs') {
    const ret = rs.node.CustomerRet;
    if (ret) {
      const one = Array.isArray(ret) ? ret[0] : ret;
      task.payload.customerListId = one.ListID || null;
      task.payload.stage = 'customer_ready';
      await qb.saveTask(task);
      const job = await qb.getJob(task.jobId);
      if (job && job.customerEmail) {
        await qb.saveCachedCustomer(job.customerEmail, {
          listId: one.ListID,
          editSeq: one.EditSequence,
          name: one.Name,
        });
      }
    } else {
      task.payload.stage = 'needs_add';
      await qb.saveTask(task);
    }
    return { done: false };
  }

  if (rs.name === 'CustomerAddRs') {
    if (String(statusCode) !== '0' && String(statusCode) !== '500') {
      throw new Error(`CustomerAdd failed [${statusCode}]: ${statusMsg}`);
    }
    const ret = rs.node.CustomerRet;
    const one = Array.isArray(ret) ? ret[0] : ret;
    if (!one || !one.ListID) throw new Error('CustomerAdd returned no ListID');
    task.payload.customerListId = one.ListID;
    task.payload.stage = 'customer_ready';
    await qb.saveTask(task);
    const job = await qb.getJob(task.jobId);
    if (job && job.customerEmail) {
      await qb.saveCachedCustomer(job.customerEmail, {
        listId: one.ListID,
        editSeq: one.EditSequence,
        name: one.Name,
      });
    }
    return { done: false };
  }

  if (String(statusCode) !== '0') {
    throw new Error(`${rs.name} failed [${statusCode}]: ${statusMsg}`);
  }

  if (rs.name === 'InvoiceAddRs') {
    const ret = rs.node.InvoiceRet;
    const txnId = ret && ret.TxnID ? ret.TxnID : null;
    await qb.markTaskDone(task.id, txnId, { payload: { ...task.payload, stage: 'complete' } });
    return { done: true, txnId };
  }
  if (rs.name === 'SalesReceiptAddRs') {
    const ret = rs.node.SalesReceiptRet;
    const txnId = ret && ret.TxnID ? ret.TxnID : null;
    await qb.markTaskDone(task.id, txnId, { payload: { ...task.payload, stage: 'complete' } });
    return { done: true, txnId };
  }
  if (rs.name === 'ReceivePaymentAddRs') {
    const ret = rs.node.ReceivePaymentRet;
    const txnId = ret && ret.TxnID ? ret.TxnID : null;
    await qb.markTaskDone(task.id, txnId, { payload: { ...task.payload, stage: 'complete' } });
    return { done: true, txnId };
  }

  throw new Error(`Unhandled response type: ${rs.name}`);
}

// ── Session ticket ─────────────────────────────────────────────────────────
// Tickets are opaque; we just mint a random string per session. QBWC echoes
// the same value back on every call, so we don't need to persist it.
function mintTicket() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Handlers ────────────────────────────────────────────────────────────────
async function handleServerVersion() {
  return soapResponse(soapEnvelope('serverVersion', 'serverVersionResult', SERVER_VERSION));
}

async function handleClientVersion() {
  // Empty string = accept. Return 'W:message' for warning, 'E:message' to reject.
  return soapResponse(soapEnvelope('clientVersion', 'clientVersionResult', ''));
}

async function handleAuthenticate(body) {
  const u = getTagText(body, 'strUserName') || '';
  const p = getTagText(body, 'strPassword') || '';
  const settings = await qb.getSettings();

  if (!settings.qbwcUsername || !settings.qbwcPasswordHash) {
    console.error('[qbwc] authenticate: QBWC credentials not configured');
    return soapResponse(soapAuthEnvelope('', 'nvu'));
  }
  if (u !== settings.qbwcUsername) {
    return soapResponse(soapAuthEnvelope('', 'nvu'));
  }
  const ok = await bcrypt.compare(p, settings.qbwcPasswordHash).catch(() => false);
  if (!ok) {
    return soapResponse(soapAuthEnvelope('', 'nvu'));
  }

  // Check for pending work.
  const tasks = await qb.listTasks();
  const pending = tasks.filter(t => t.status === 'pending');
  if (!pending.length) {
    // Ticket + 'none' tells QBWC: authenticated, no work this round.
    return soapResponse(soapAuthEnvelope(mintTicket(), 'none'));
  }

  // Empty companyFile = use whichever file is currently open in QB Desktop.
  await qb.saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncError: null });
  return soapResponse(soapAuthEnvelope(mintTicket(), settings.companyFile || ''));
}

async function handleSendRequestXML() {
  const settings = await qb.getSettings();
  const task = await qb.claimNextPendingTask();
  if (!task) {
    return soapResponse(soapEnvelope('sendRequestXML', 'sendRequestXMLResult', ''));
  }
  try {
    const xml = await buildRequestForTask(task, settings);
    return soapResponse(soapEnvelope('sendRequestXML', 'sendRequestXMLResult', xmlEscape(xml)));
  } catch (err) {
    console.error('[qbwc] buildRequestForTask error:', err.message);
    await qb.markTaskFailed(task.id, err.message);
    // Return empty string — QBWC moves on to receiveResponseXML with no-op.
    return soapResponse(soapEnvelope('sendRequestXML', 'sendRequestXMLResult', ''));
  }
}

async function handleReceiveResponseXML(body) {
  const responseXml = getTagText(body, 'response') || '';
  const hresult    = getTagText(body, 'hresult')  || '';
  const message    = getTagText(body, 'message')  || '';

  // Locate the in-progress task.
  const all = await qb.listTasks();
  const task = all.find(t => t.status === 'in_progress');

  if (!task) {
    return soapResponse(soapEnvelope('receiveResponseXML', 'receiveResponseXMLResult', '100'));
  }

  if (hresult) {
    await qb.markTaskFailed(task.id, `QBWC hresult=${hresult} ${message}`);
    await qb.saveSettings({ lastSyncError: `${hresult} ${message}`.slice(0, 500) });
    return soapResponse(soapEnvelope('receiveResponseXML', 'receiveResponseXMLResult', '100'));
  }

  try {
    const result = await ingestResponseForTask(task, responseXml);
    // If this task still has more stages, return a progress < 100 so QBWC calls us again.
    if (!result.done) {
      // Re-open task so next sendRequestXML picks it up as pending.
      task.status = 'pending';
      await qb.saveTask(task);
      return soapResponse(soapEnvelope('receiveResponseXML', 'receiveResponseXMLResult', '50'));
    }

    // Any more pending tasks in the queue?
    const remaining = (await qb.listTasks()).filter(t => t.status === 'pending').length;
    return soapResponse(soapEnvelope(
      'receiveResponseXML',
      'receiveResponseXMLResult',
      remaining > 0 ? '50' : '100',
    ));
  } catch (err) {
    console.error('[qbwc] ingestResponseForTask error:', err.message);
    await qb.markTaskFailed(task.id, err.message);
    await qb.saveSettings({ lastSyncError: err.message.slice(0, 500) });
    return soapResponse(soapEnvelope('receiveResponseXML', 'receiveResponseXMLResult', '100'));
  }
}

async function handleCloseConnection() {
  await qb.saveSettings({ lastSyncAt: new Date().toISOString() });
  return soapResponse(soapEnvelope('closeConnection', 'closeConnectionResult', 'OK'));
}

async function handleConnectionError(body) {
  const msg = getTagText(body, 'message') || '';
  const hresult = getTagText(body, 'hresult') || '';
  console.error('[qbwc] connectionError:', hresult, msg);
  await qb.saveSettings({ lastSyncError: `${hresult} ${msg}`.slice(0, 500) });
  return soapResponse(soapEnvelope('connectionError', 'connectionErrorResult', 'done'));
}

async function handleGetLastError() {
  const settings = await qb.getSettings();
  return soapResponse(soapEnvelope('getLastError', 'getLastErrorResult',
    xmlEscape(settings.lastSyncError || '')));
}

// ── Entry ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  // QBWC describes itself via WSDL on GET; we don't need to serve one because
  // the .qwc file bundles all the necessary metadata. Respond with a simple
  // status page to confirm the endpoint is live.
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'QBWC endpoint is live. POST SOAP requests only.',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const method = detectMethod(body);
  console.log('[qbwc] method=' + method);

  try {
    if (method === 'serverVersion')       return await handleServerVersion();
    if (method === 'clientVersion')       return await handleClientVersion();
    if (method === 'authenticate')        return await handleAuthenticate(body);
    if (method === 'sendRequestXML')      return await handleSendRequestXML();
    if (method === 'receiveResponseXML')  return await handleReceiveResponseXML(body);
    if (method === 'closeConnection')     return await handleCloseConnection();
    if (method === 'connectionError')     return await handleConnectionError(body);
    if (method === 'getLastError')        return await handleGetLastError();
  } catch (err) {
    console.error('[qbwc] handler error:', err.message, err.stack);
    return { statusCode: 500, body: 'Internal error: ' + err.message };
  }

  return { statusCode: 400, body: 'Unknown SOAP method' };
};
