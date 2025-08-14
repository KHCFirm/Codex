import PDFDocument from 'pdfkit';

/**
 * Env vars
 *  - FILEVINE_CLIENT_ID
 *  - FILEVINE_CLIENT_SECRET
 *  - FILEVINE_PAT_TOKEN
 *  - DEBUG (optional: "true" | "false"; default "true")
 *
 * US-only; global hosts (api.filevineapp.com).
 */

const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
const GATEWAY_UTILS_BASE  = 'https://api.filevineapp.com/fv-app/v2';     // non-regional utils
const GATEWAY_REGION_BASE = 'https://api.filevineapp.com/fv-app/v2-us';  // **US regional base** (fix 404s)
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
      utilsBase: GATEWAY_UTILS_BASE,
      regionBase: GATEWAY_REGION_BASE,
      projectId
    });

    // 1) Token
    const token = await getBearerToken(reqId);

    // 2) Resolve user/org (ensure **numeric strings**)
    const { userId, orgId } = await getUserAndOrgIds(token, reqId);
    dlog(`[${reqId}] Using gateway headers`, { 'x-fv-userid': userId, 'x-fv-orgid': orgId });

    // 3) Pull notes & emails (multi-strategy to be resilient)
    const [notesRaw, emails] = await Promise.all([
      pullWithStrategies('notes', projectId, token, userId, orgId, reqId),
      pullWithStrategies('emails', projectId, token, userId, orgId, reqId)
    ]);
    dlog(`[${reqId}] Fetch complete`, { notesCount: notesRaw.length, emailsCount: emails.length });

    // 3b) Attach comments to notes (normalized by native IDs; includes author)
    const notes = await attachCommentsToNotes({
      notes: notesRaw,
      projectId,
      token,
      userId,
      orgId,
      reqId
    });

    // 4) Normalize + merge chronologically
    const merged = [
      ...notes.map((n, index) => {
        if (index === 0) debugDateFields([n], 'Note', reqId);
        return {
          type: 'Note',
          id: normalizeId(n?.id ?? n?.noteId),
          created: extractDate(n, 'note'),
          author: extractAuthor(n),
          title: n?.title || n?.subject || '',
          body: n?.body || n?.text || n?.content || '',
          comments: Array.isArray(n?.comments) ? n.comments : []
        };
      }),
      ...emails.map((e, index) => {
        if (index === 0) debugDateFields([e], 'Email', reqId);
        return {
          type: 'Email',
          id: normalizeId(e?.id ?? e?.emailId),
          created: extractDate(e, 'email'),
          author: extractAuthor(e),
          title: e?.subject || e?.title || '',
          body: e?.body || e?.content || e?.text || ''
        };
      })
    ].sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));

    dlog(`[${reqId}] Merge complete`, { mergedCount: merged.length });

    // 5) PDF stream
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
        const headerBits = [item.type, fmt(item.created)];
        if (item.author) headerBits.push(String(item.author));
        doc.fontSize(12).fillColor('#000').text(headerBits.join(' • '));

        if (item.title) {
          doc.font('Helvetica-Bold').text(item.title);
          doc.font('Helvetica');
        }
        if (item.body) {
          doc.fontSize(11).fillColor('#111').text(stripHtml(item.body), { align: 'left' });
        }

        // Render comments for notes (with author + timestamp)
        if (item.type === 'Note' && Array.isArray(item.comments) && item.comments.length) {
          doc.moveDown(0.25);
          doc.fontSize(11).fillColor('#000').text(`Comments (${item.comments.length}):`);
          for (const c of item.comments) {
            const head = `— ${fmt(c.created)}${c.author ? ` • ${c.author}` : ''}`;
            doc.fontSize(10).fillColor('#333').text(head, { indent: 16 });
            if (c.body) {
              doc.fontSize(10).fillColor('#111').text(stripHtml(c.body), { indent: 32 });
            }
            doc.moveDown(0.1);
          }
        }

        doc.moveDown(0.25);
        doc.strokeColor('#ddd').lineWidth(1)
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

function normalizeId(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.native != null) return String(v.native);
    if (v.id != null) return String(v.id);
    if (v.noteId != null) return String(v.noteId);
  }
  return String(v);
}

function firstString(...vals) {
  for (const v of vals) {
    if (!v && v !== 0) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function composeName(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const fn = firstString(obj.firstName, obj.givenName);
  const ln = firstString(obj.lastName, obj.surname);
  const disp = firstString(obj.displayName, obj.fullName, obj.name);
  if (fn || ln) return `${fn} ${ln}`.trim();
  return disp;
}

function extractAuthor(obj) {
  // Try common shapes first
  const direct = firstString(
    obj?.createdBy?.name,
    obj?.author?.name,
    obj?.user?.name,
    obj?.from?.name,
    obj?.sender?.name,
    obj?.createdByName,
    obj?.authorName,
    obj?.creatorName,
    obj?.createdByFullName,
    obj?.ownerName,
    obj?.createdBy,
    obj?.author,
    obj?.user,
    obj?.from,
    obj?.sender
  );
  if (direct) return direct;

  // Compose from sub-objects if present
  const composed = firstString(
    composeName(obj?.createdBy),
    composeName(obj?.author),
    composeName(obj?.user),
    composeName(obj?.from),
    composeName(obj?.sender),
    composeName(obj?.owner),
    composeName(obj?.creator)
  );
  if (composed) return composed;

  // E-mail fallback (e.g., { from: { email } })
  const emailish = firstString(
    obj?.from?.email,
    obj?.sender?.email,
    obj?.createdBy?.email,
    obj?.author?.email
  );
  return emailish;
}

function debugDateFields(items, type, reqId) {
  if (items.length > 0) {
    const sample = items[0];
    const dateFields = Object.keys(sample).filter(key =>
      key.toLowerCase().includes('date') ||
      key.toLowerCase().includes('time') ||
      key.toLowerCase().includes('created') ||
      key.toLowerCase().includes('received') ||
      key.toLowerCase().includes('sent')
    );

    dlog(`[${reqId}] ${type} sample date fields:`, {
      availableFields: dateFields,
      sampleValues: dateFields.reduce((acc, field) => {
        acc[field] = sample[field];
        return acc;
      }, {}),
      allFields: Object.keys(sample).slice(0, 10)
    });
  }
}

function extractDate(item, type) {
  const dateFields =
    type === 'note'
      ? [
          'createdDate','created','date','dateCreated','createDate',
          'timestamp','createdAt','dateTime','noteDate','updatedDate'
        ]
      : type === 'email'
      ? [
          'dateReceived','dateSent','createdDate','created','date',
          'dateCreated','createDate','timestamp','createdAt','dateTime',
          'receivedDate','sentDate','emailDate','updatedDate'
        ]
      : [
          'createdDate','created','date','dateCreated','createDate',
          'timestamp','createdAt','dateTime','commentDate','updatedDate'
        ];

  for (const field of dateFields) {
    const value = item?.[field];
    if (value) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return value;
    }
  }
  console.warn(`No valid date found for ${type}:`, Object.keys(item || {}));
  return new Date().toISOString();
}

function fmt(d) {
  if (!d) return 'No Date';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return 'Invalid Date';
    return date.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch {
    return 'Date Error';
  }
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
  if (!resp.ok) {
    await logErrorBody(resp, reqId, 'identity');
    throw new Error(`Identity token error: ${resp.status}`);
  }
  const data = await safeJson(resp, reqId, 'identity');
  if (!data.access_token) throw new Error('No access_token in identity response');
  dlog(`[${reqId}] Token acquired (length)`, { accessTokenLength: String(data.access_token).length });
  return data.access_token; // never log token value
}

async function getUserAndOrgIds(bearer, reqId) {
  const url = `${GATEWAY_UTILS_BASE}/utils/GetUserOrgsWithToken`;
  dlog(`[${reqId}] POST ${url} (utils)`);
  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Accept': 'application/json' }
  }, reqId);
  dlog(`[${reqId}] GetUserOrgsWithToken response`, { status: resp.status });
  if (!resp.ok) {
    await logErrorBody(resp, reqId, 'GetUserOrgsWithToken');
    throw new Error(`GetUserOrgsWithToken error: ${resp.status}`);
  }
  const data = await safeJson(resp, reqId, 'getUserOrgsWithToken');

  // Robust extraction → **numbers/strings only**
  const userId = pickUserId(data);
  const orgId  = pickOrgId(data);

  dlog(`[${reqId}] Resolved IDs`, { userId, orgId, keys: Object.keys(data || {}) });
  if (!userId || !orgId) throw new Error('Could not resolve userId/orgId from gateway response');
  return { userId: String(userId), orgId: String(orgId) };
}

function pickUserId(data) {
  const candidates = [
    data?.userId,
    data?.user,
    data?.user?.id,
    data?.user?.userId,
    data?.user?.native
  ];
  for (const c of candidates) {
    if (typeof c === 'number' || typeof c === 'string') return c;
    if (c && typeof c === 'object' && (typeof c.native === 'number' || typeof c.native === 'string')) return c.native;
  }
  return null;
}

function pickOrgId(data) {
  const candidates = [
    data?.orgId,
    data?.org,
    data?.org?.id,
    data?.orgs?.[0]?.orgId,
    data?.orgs?.[0]?.id
  ];
  for (const c of candidates) {
    if (typeof c === 'number' || typeof c === 'string') return c;
    if (c && typeof c === 'object' && (typeof c.id === 'number' || typeof c.id === 'string')) return c.id;
  }
  return null;
}

/**
 * Try multiple plausible endpoints/methods for "notes" or "emails".
 * Stops on first 2xx and paginates with the same route.
 */
async function pullWithStrategies(kind, projectId, bearer, userId, orgId, reqId) {
  const limit = 50;
  const base = `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}`;

  const strategies = kind === 'notes'
    ? [
        { label: 'GET notes',               method: 'GET',  url: `${base}/notes` },
        { label: 'GET activity/notes',      method: 'GET',  url: `${base}/activity/notes` },
        { label: 'GET activity?types=note', method: 'GET',  url: `${base}/activity`, qp: { types: 'note' } },
        { label: 'GET notes/list',          method: 'GET',  url: `${base}/notes/list` },
        { label: 'POST notes',              method: 'POST', url: `${base}/notes`,      body: ({offset, limit}) => ({ offset, limit }) },
        { label: 'POST notes/list',         method: 'POST', url: `${base}/notes/list`, body: ({offset, limit}) => ({ offset, limit }) },
      ]
    : [
        { label: 'GET emails',               method: 'GET',  url: `${base}/emails` },
        { label: 'GET activity/emails',      method: 'GET',  url: `${base}/activity/emails` },
        { label: 'GET activity?types=email', method: 'GET',  url: `${base}/activity`, qp: { types: 'email' } },
        { label: 'GET emails/list',          method: 'GET',  url: `${base}/emails/list` },
        { label: 'POST emails',              method: 'POST', url: `${base}/emails`,      body: ({offset, limit}) => ({ offset, limit }) },
        { label: 'POST emails/list',         method: 'POST', url: `${base}/emails/list`, body: ({offset, limit}) => ({ offset, limit }) },
      ];

  for (const strat of strategies) {
    try {
      const items = await pullAllPagesWithOneRoute(strat, bearer, userId, orgId, limit, reqId, kind);
      dlog(`[${reqId}] ${kind} using strategy`, { strategy: strat.label, total: items.length });
      if (items) return items;
    } catch (e) {
      dlog(`[${reqId}] ${kind} failed strategy`, { strategy: strat.label, error: e?.message });
      continue;
    }
  }
  throw new Error(`No ${kind} route matched; tried ${strategies.map(s => s.label).join(' | ')}`);
}

/** Pull all pages with a single route (GET query or POST body). */
async function pullAllPagesWithOneRoute(strat, bearer, userId, orgId, limit, reqId, label) {
  const out = [];
  let offset = 0;

  while (true) {
    const hasBody = typeof strat.body === 'function';
    let urlObj = new URL(strat.url);
    let init = {
      method: strat.method,
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'x-fv-userid': String(userId),
        'x-fv-orgid': String(orgId),
        'Accept': 'application/json'
      }
    };

    if (strat.method === 'GET') {
      urlObj.searchParams.set('limit', String(limit));
      urlObj.searchParams.set('offset', String(offset));
      if (strat.qp) for (const [k, v] of Object.entries(strat.qp)) urlObj.searchParams.set(k, String(v));
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ limit, offset, ...(hasBody ? strat.body({ offset, limit }) : {}) });
    }

    const urlStr = urlObj.toString();
    dlog(`[${reqId}] ${strat.method} ${urlStr} (${label})`, { offset, limit, strategy: strat.label, headers: { 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId) } });
    const resp = await fetchWithRetry(urlStr, init, reqId);
    dlog(`[${reqId}] ${label} page response`, { status: resp.status, offset, strategy: strat.label });

    if (!resp.ok) {
      await logErrorBody(resp, reqId, `${label}-page(${strat.label})`);
      throw new Error(`${urlObj.pathname} ${strat.method} error: ${resp.status}`);
    }

    const data = await safeJson(resp, reqId, `${label}-page(${strat.label})`);
    const items = extractItems(data);
    out.push(...items);

    const hasMore = inferHasMore(data, items, limit, offset);
    dlog(`[${reqId}] ${label} page parsed`, {
      itemsReceived: items.length,
      totalAccumulated: out.length,
      hasMore,
      strategy: strat.label
    });

    if (!hasMore) break;
    offset += limit;
  }
  return out;
}

function extractItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.activityItems)) return data.activityItems;
  if (data.page && Array.isArray(data.page.items)) return data.page.items;
  return [];
}

function inferHasMore(data, items, limit, _offset) {
  if (data?.hasMore === true) return true;
  if (data?.nextOffset != null) return true;
  return items.length === limit;
}

/** Retry + logging for transient errors. */
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

async function logErrorBody(resp, reqId, tag) {
  try {
    const clone = resp.clone?.() ?? resp;
    const text = await clone.text();
    dlog(`[${reqId}] ${tag} error body`, { snippet: text.slice(0, 600) });
  } catch (err) {
    dlog(`[${reqId}] ${tag} error body read failed`, { message: err?.message });
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
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- comments helpers & flow ---------- */

function extractEmbeddedComments(note) {
  const arrays = [
    note?.comments,
    note?.replies,
    note?.commentItems,
    note?.noteComments,
    note?.thread?.comments,
    note?.page?.items
  ];
  const found = arrays.find(a => Array.isArray(a)) || [];
  return found.map(c => ({
    id: normalizeId(c?.id ?? c?.commentId),
    created: extractDate(c, 'comment'),
    author: extractAuthor(c),
    body: c?.body || c?.text || c?.content || ''
  }));
}

function commentsLinkFromNote(note) {
  return (
    note?._links?.comments?.href ||
    note?.links?.comments?.href ||
    note?.links?.comments ||
    null
  );
}

function absolutizeCommentsUrl(explicitUrl, projectBase) {
  if (!explicitUrl) return null;
  if (/^https?:\/\//i.test(explicitUrl)) return explicitUrl; // already absolute
  // Handle "/notes/{id}/comments" forms (relative to project base)
  if (explicitUrl.startsWith('/')) return `${projectBase}${explicitUrl}`;
  // Handle "notes/{id}/comments" (no leading slash)
  return `${projectBase}/${explicitUrl}`;
}

async function attachCommentsToNotes({ notes, projectId, token, userId, orgId, reqId }) {
  if (!Array.isArray(notes) || !notes.length) return [];

  dlog(`[${reqId}] Attaching comments to ${notes.length} notes`);
  const MAX_CONCURRENCY = 4;
  const queue = notes.slice();
  const results = [];
  let active = 0;

  return await new Promise((resolve) => {
    const runNext = async () => {
      if (!queue.length && active === 0) return resolve(results);
      while (active < MAX_CONCURRENCY && queue.length) {
        const note = queue.shift();
        active++;
        (async () => {
          try {
            const noteId = normalizeId(note?.id ?? note?.noteId);
            const pre = extractEmbeddedComments(note);
            if (pre.length) {
              results.push({ ...note, comments: pre });
            } else if (!noteId) {
              dlog(`[${reqId}] No usable noteId; skipping comment fetch`);
              results.push({ ...note, comments: [] });
            } else {
              const comments = await getNoteComments({
                projectId,
                noteId,
                explicitUrl: commentsLinkFromNote(note),
                bearer: token,
                userId,
                orgId,
                reqId
              });
              results.push({ ...note, comments });
            }
          } catch (err) {
            dlog(`[${reqId}] comments fetch failed`, { error: err?.message });
            results.push({ ...note, comments: [] });
          } finally {
            active--;
            runNext();
          }
        })();
      }
    };
    runNext();
  });
}

async function getNoteComments({ projectId, noteId, explicitUrl, bearer, userId, orgId, reqId }) {
  const projectBase = `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}`;
  const nid  = encodeURIComponent(String(noteId));
  const limit = 50;

  // Try explicit per-item link first (make absolute if needed)
  if (explicitUrl) {
    const abs = absolutizeCommentsUrl(explicitUrl, projectBase);
    try {
      const items = await pullAllPagesWithOneRoute(
        { label: 'GET link:comments', method: 'GET', url: abs },
        bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`
      );
      if (Array.isArray(items) && items.length) return normalizeComments(items);
    } catch (e) {
      dlog(`[${reqId}] comments explicit link failed`, { url: explicitUrl, abs, error: e?.message });
    }
  }

  const strategies = [
    { label: 'GET notes/{id}/comments',  method: 'GET',  url: `${projectBase}/notes/${nid}/comments` },
    { label: 'GET notes/{id}/replies',   method: 'GET',  url: `${projectBase}/notes/${nid}/replies` },
    { label: 'POST notes/{id}/comments', method: 'POST', url: `${projectBase}/notes/${nid}/comments`,
      body: ({offset, limit}) => ({ offset, limit }) },

    // collection-level comments endpoints
    { label: 'GET comments',             method: 'GET',  url: `${projectBase}/comments`, qp: { parentType: 'note', parentId: String(noteId) } },
    { label: 'GET comments/list',        method: 'GET',  url: `${projectBase}/comments/list`, qp: { parentType: 'note', parentId: String(noteId), limit, offset: 0 } },
    { label: 'POST comments',            method: 'POST', url: `${projectBase}/comments`,
      body: ({offset, limit}) => ({ parentType: 'note', parentId: String(noteId), offset, limit }) },
    { label: 'POST comments/list',       method: 'POST', url: `${projectBase}/comments/list`,
      body: ({offset, limit}) => ({ parentType: 'note', parentId: String(noteId), offset, limit }) },

    // activity fallback
    { label: 'GET activity?types=comment', method: 'GET',
      url: `${projectBase}/activity`, qp: { types: 'comment', parentType: 'note', parentId: String(noteId) } },
  ];

  for (const strat of strategies) {
    try {
      const items = await pullAllPagesWithOneRoute(
        strat, bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`
      );
      if (Array.isArray(items) && items.length) return normalizeComments(items);
    } catch (e) {
      dlog(`[${reqId}] comments failed strategy`, { noteId, strategy: strat.label, error: e?.message });
    }
  }

  dlog(`[${reqId}] All comment strategies failed for note`, { noteId });
  return [];
}

function normalizeComments(items) {
  return items.map(c => ({
    id: normalizeId(c?.id ?? c?.commentId),
    created: extractDate(c, 'comment'),
    author: extractAuthor(c),
    body: c?.body || c?.text || c?.content || ''
  }));
}
