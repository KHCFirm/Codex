import PDFDocument from 'pdfkit';

/**
 * Environment variables (Vercel → Project → Settings → Environment Variables)
 *  - FILEVINE_CLIENT_ID
 *  - FILEVINE_CLIENT_SECRET
 *  - FILEVINE_PAT_TOKEN
 *  - FILEVINE_HOST   (optional, default: https://khcfirm.filevineapp.com)
 *  - DEBUG           (optional: "true" | "false"; default: "true")
 *
 * Notes:
 * - US ONLY per your instruction (no Canada branch). All project resources use /fv-app/v2-us.
 * - Utils endpoint (GetUserOrgsWithToken) uses the non-regional base /fv-app/v2.
 */

const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
const FILEVINE_HOST = (process.env.FILEVINE_HOST || 'https://khcfirm.filevineapp.com').replace(/\/+$/, '');
const GATEWAY_UTILS_BASE = `${FILEVINE_HOST}/fv-app/v2`;     // non-regional
const GATEWAY_REGION_BASE = `${FILEVINE_HOST}/fv-app/v2-us`; // US regional
const DEBUG = (process.env.DEBUG ?? 'true').toLowerCase() !== 'false';

const REQ = () => Math.random().toString(36).slice(2, 10);
const dlog = (...args) => { if (DEBUG) console.log('[debug]', ...args); };

export default async function handler(req, res) {
  const reqId = REQ();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      res.statusCode = 400;
      return res.end('Missing projectId');
    }

    dlog(`[${reqId}] Start`, {
      host: FILEVINE_HOST,
      utilsBase: GATEWAY_UTILS_BASE,
      regionBase: GATEWAY_REGION_BASE,
      projectId
    });

    // 1) Exchange PAT for bearer token
    const token = await getBearerToken(reqId);

    // 2) Resolve User ID and Org ID (non-regional utils base)
    const { userId, orgId } = await getUserAndOrgIds(token, reqId);

    // 3) Pull notes + emails from regional base (with pagination)
    const [notes, emails] = await Promise.all([
      pullAllPages(`${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/notes`, token, userId, orgId, reqId, 'notes'),
      pullAllPages(`${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/emails`, token, userId, orgId, reqId, 'emails')
    ]);

    dlog(`[${reqId}] Fetch complete`, { notesCount: notes.length, emailsCount: emails.length });

    // 4) Normalize + merge chronologically
    const merged = [
      ...notes.map(n => ({
        type: 'Note',
        id: n?.id ?? n?.noteId,
        created: n?.createdDate || n?.created || n?.date,
        author: n?.createdBy?.name || n?.author?.name || n?.user?.name,
        title: n?.title || '',
        body: n?.body || n?.text || ''
      })),
      ...emails.map(e => ({
        type: 'Email',
        id: e?.id ?? e?.emailId,
        created: e?.createdDate || e?.dateReceived || e?.date,
        author: e?.from?.name || e?.sender?.name || e?.createdBy?.name,
        title: e?.subject || '',
        body: e?.body || ''
      }))
    ].sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));

    dlog(`[${reqId}] Merge complete`, { mergedCount: merged.length });

    // 5) Stream a PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({ margin: 50, info: { Title: `Project ${projectId} Notes & Emails` } });
    doc.pipe(res);

    doc.fontSize(20).text(`Project ${projectId} — Notes & Emails`, { underline: true });
    doc.moveDown(0.5);
    const generatedAt = new Date().toLocaleString('en-US', { hour12: false });
    doc.fontSize(10).fillColor('#666').text(`Generated: ${generatedAt}`);
    doc.moveDown();

    if (!merged.length) {
      doc.fontSize(12).fillColor('#000').text('No notes or emails found.');
    } else {
      for (const item of merged) {
        doc.moveDown();
        doc
          .fontSize(12)
          .fillColor('#000')
          .text(`${item.type} • ${fmt(item.created)}${item.author ? ` • ${item.author}` : ''}`, { continued: false });
        if (item.title) {
          doc.font('Helvetica-Bold').text(item.title);
          doc.font('Helvetica');
        }
        if (item.body) doc.fontSize(11).fillColor('#111').text(stripHtml(item.body), { align: 'left' });
        doc.moveDown(0.25);
        doc
          .strokeColor('#ddd')
          .lineWidth(1)
          .moveTo(doc.page.margins.left, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .stroke();
      }
    }

    doc.end();
    dlog(`[${reqId}] PDF streamed`);
  } catch (err) {
    console.error(`[error][${reqId}]`, { message: err?.message, stack: err?.stack });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Error (${reqId}): ${err.message}`);
  }
}

/* ---------- helpers ---------- */

function fmt(d) {
  try { return new Date(d).toLocaleString('en-US', { hour12: false }); }
  catch { return d || ''; }
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function getBearerToken(reqId) {
  const client_id = process.env.FILEVINE_CLIENT_ID;
  const client_secret = process.env.FILEVINE_CLIENT_SECRET;
  const pat_token = process.env.FILEVINE_PAT_TOKEN; // Personal Access Token
  if (!client_id || !client_secret || !pat_token) throw new Error('Missing Filevine credentials in env vars');

  const body = new URLSearchParams();
  body.set('grant_type', 'personal_access_token');
  body.set('scope', 'fv.api.gateway.access tenant filevine.v2.api.* openid email fv.auth.tenant.read');
  body.set('token', pat_token);
  body.set('client_id', client_id);
  body.set('client_secret', client_secret);

  dlog(`[${reqId}] POST ${IDENTITY_URL} (token exchange)`);
  const resp = await fetch(IDENTITY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  dlog(`[${reqId}] Identity response`, { status: resp.status });
  if (!resp.ok) throw new Error(`Identity token error: ${resp.status}`);
  const data = await safeJson(resp, reqId, 'identity');
  if (!data.access_token) throw new Error('No access_token in identity response');
  dlog(`[${reqId}] Token acquired (length)`, { accessTokenLength: String(data.access_token).length });
  return data.access_token; // do NOT log token value
}

async function getUserAndOrgIds(bearer, reqId) {
  const url = `${GATEWAY_UTILS_BASE}/utils/GetUserOrgsWithToken`;
  dlog(`[${reqId}] POST ${url} (utils, non-regional)`);
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Accept': 'application/json' }
  }, reqId);
  dlog(`[${reqId}] GetUserOrgsWithToken response`, { status: resp.status });
  if (!resp.ok) throw new Error(`GetUserOrgsWithToken error: ${resp.status}`);

  const data = await safeJson(resp, reqId, 'getUserOrgsWithToken');
  const userId = data?.userId || data?.user?.id || data?.user?.userId;
  const orgId  = data?.orgId  || data?.org?.id  || data?.orgs?.[0]?.orgId || data?.orgs?.[0]?.id;

  dlog(`[${reqId}] Resolved IDs`, { userId, orgId, keys: Object.keys(data || {}) });
  if (!userId || !orgId) throw new Error('Could not resolve userId/orgId from gateway response');
  return { userId, orgId };
}

async function pullAllPages(baseUrl, bearer, userId, orgId, reqId, label) {
  const out = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    dlog(`[${reqId}] GET ${url.toString()} (${label})`, { offset, limit });
    const resp = await fetchWithRetry(url.toString(), {
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'x-fv-userid': String(userId),
        'x-fv-orgid': String(orgId),
        'Accept': 'application/json'
      }
    }, reqId);
    dlog(`[${reqId}] ${label} page response`, { status: resp.status, offset });

    if (!resp.ok) throw new Error(`${url.pathname} error: ${resp.status}`);

    const data = await safeJson(resp, reqId, `${label}-page`);
    const items = data?.items || data?.data || data?.results || [];
    out.push(...items);

    const hasMore = data?.hasMore === true || (items.length === limit);
    dlog(`[${reqId}] ${label} page parsed`, { itemsReceived: items.length, totalAccumulated: out.length, hasMore });

    if (!hasMore) break;
    offset += limit;
  }
  return out;
}

/** Minimal retry + logging for transient 5xx responses. */
async function fetchWithRetry(input, init = {}, reqId, retries = 2, delayMs = 250) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const resp = await fetch(input, init);
      if (resp.status >= 500 && retries > 0) {
        dlog(`[${reqId}] fetchWithRetry 5xx`, { url: input, status: resp.status, attempt });
        await sleep(delayMs * attempt);
        retries--;
        continue;
      }
      return resp;
    } catch (err) {
      if (retries > 0) {
        dlog(`[${reqId}] fetchWithRetry network error`, { url: input, attempt, message: err?.message });
        await sleep(delayMs * attempt);
        retries--;
        continue;
      }
      throw err;
    }
  }
}

async function safeJson(resp, reqId, tag) {
  try {
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      // Log a redacted preview (no secrets)
      dlog(`[${reqId}] ${tag} JSON preview`, previewJson(json));
      return json;
    } catch {
      dlog(`[${reqId}] ${tag} non-JSON body`, { snippet: text.slice(0, 300) });
      return {};
    }
  } catch (err) {
    dlog(`[${reqId}] ${tag} body read error`, { message: err?.message });
    return {};
  }
}

function previewJson(obj, maxKeys = 20) {
  if (!obj || typeof obj !== 'object') return obj;
  const keys = Object.keys(obj).slice(0, maxKeys);
  const preview = {};
  for (const k of keys) {
    const v = obj[k];
    preview[k] = (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret'))
      ? '[redacted]'
      : summarize(v);
  }
  return preview;
}

function summarize(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return `[array len=${v.length}]`;
  if (typeof v === 'object') return `{object keys=${Object.keys(v).length}}`;
  const s = String(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
