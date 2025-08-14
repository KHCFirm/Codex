import PDFDocument from 'pdfkit';

/**
 * Env vars (set in Vercel Project Settings → Environment Variables):
 *  - FILEVINE_CLIENT_ID
 *  - FILEVINE_CLIENT_SECRET
 *  - FILEVINE_PAT_TOKEN
 */
const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
// Use v2-us for US tenants; switch to v2-ca if your tenant is in Canada.
const GATEWAY_BASE = 'https://api.filevineapp.com/fv-app/v2-us';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      res.statusCode = 400;
      return res.end('Missing projectId');
    }

    // 1) Get bearer token via PAT + client credentials
    const token = await getBearerToken();

    // 2) Resolve User ID and Org ID for gateway headers
    const { userId, orgId } = await getUserAndOrgIds(token);

    // 3) Pull notes + emails with pagination
    const [notes, emails] = await Promise.all([
      pullAllPages(`${GATEWAY_BASE}/projects/${encodeURIComponent(projectId)}/notes`, token, userId, orgId),
      pullAllPages(`${GATEWAY_BASE}/projects/${encodeURIComponent(projectId)}/emails`, token, userId, orgId)
    ]);

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
        doc.fontSize(12).fillColor('#000').text(
          `${item.type} • ${fmt(item.created)}${item.author ? ` • ${item.author}` : ''}`,
          { continued: false }
        );
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
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Error: ${err.message}`);
  }
}

function fmt(d) {
  try {
    return new Date(d).toLocaleString('en-US', { hour12: false });
  } catch {
    return d || '';
  }
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, '').replace(/\s+$/g, '');
}

async function getBearerToken() {
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

  const resp = await fetch(IDENTITY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  if (!resp.ok) throw new Error(`Identity token error: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in identity response');
  return data.access_token;
}

async function getUserAndOrgIds(bearer) {
  const resp = await fetchWithRetry(`${GATEWAY_BASE}/utils/GetUserOrgsWithToken`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearer}`,
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) throw new Error(`GetUserOrgsWithToken error: ${resp.status}`);
  const data = await resp.json();

  // Prefer current user and primary org if present
  let userId = data?.userId || data?.user?.id || data?.user?.userId;
  let orgId = data?.orgId || data?.org?.id || data?.orgs?.[0]?.orgId || data?.orgs?.[0]?.id;
  if (!userId || !orgId) throw new Error('Could not resolve userId/orgId from gateway response');
  return { userId, orgId };
}

async function pullAllPages(baseUrl, bearer, userId, orgId) {
  const out = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const resp = await fetchWithRetry(url.toString(), {
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'x-fv-userid': String(userId),
        'x-fv-orgid': String(orgId),
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) throw new Error(`${url.pathname} error: ${resp.status}`);

    const data = await resp.json();
    const items = data?.items || data?.data || data?.results || [];
    out.push(...items);

    const hasMore = data?.hasMore === true || (items.length === limit);
    if (!hasMore) break;
    offset += limit;
  }
  return out;
}

/**
 * Minimal retry for transient 5xx responses.
 */
async function fetchWithRetry(input, init = {}, retries = 2, delayMs = 250) {
  let attempt = 0;
  while (true) {
    const resp = await fetch(input, init);
    if (resp.status < 500 || retries === 0) return resp;
    attempt++;
    await sleep(delayMs * attempt); // backoff
    retries--;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
