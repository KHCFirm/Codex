import PDFDocument from 'pdfkit';

/**
 * Env vars
 *  - FILEVINE_CLIENT_ID
 *  - FILEVINE_CLIENT_SECRET
 *  - FILEVINE_PAT_TOKEN
 *  - DEBUG (optional: "true" | "false"; default "true")
 *
 * New API gateway (global): api.filevineapp.com/fv-app/v2
 * Notes/comments are NOT project-scoped in v2; use /notes/{noteId}/comments.
 */

const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
const GATEWAY_UTILS_BASE  = 'https://api.filevineapp.com/fv-app/v2'; // non-regional
const GATEWAY_REGION_BASE = 'https://api.filevineapp.com/fv-app/v2'; // keep global v2
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

    // 3) Pull notes & emails
    const [notesRaw, emails] = await Promise.all([
      pullWithStrategies('notes', projectId, token, userId, orgId, reqId),
      pullWithStrategies('emails', projectId, token, userId, orgId, reqId)
    ]);
    dlog(`[${reqId}] Fetch complete`, { notesCount: notesRaw.length, emailsCount: emails.length });

    // 3a) DEBUG: show author candidates for the first note we got back
    debugNoteAuthorFields(notesRaw, reqId);

    // 3b) Attach comments to notes
    const notesWithComments = await attachCommentsToNotes({
      notes: notesRaw,
      projectId,
      token,
      userId,
      orgId,
      reqId
    });

    // 3c) Enrich authors for notes missing a clear author (follows HAL _links.createdBy, then /users/{id})
    await enrichNoteAuthors(notesWithComments, token, userId, orgId, reqId);

    // 3d) Enrich authors for comments that lack a name (resolve via /users/{id})
    await enrichCommentAuthors(notesWithComments, token, userId, orgId, reqId);

    // 3e) DEBUG: show the extracted/enriched author outcome for the first note
    if (Array.isArray(notesWithComments) && notesWithComments.length) {
      const first = notesWithComments[0];
      dlog(`[${reqId}] First note author extracted`, {
        extracted: extractNoteAuthor(first),
        enriched: first?.__author ?? null
      });
    }

    // 4) Normalize + merge chronologically
    const merged = [
      ...notesWithComments.map((n, index) => {
        if (index === 0) debugDateFields([n], 'Note', reqId);
        return {
          type: 'Note',
          id: normalizeId(n?.id ?? n?.noteId),
          created: extractDate(n, 'note'),
          author: n?.__author || extractNoteAuthor(n), // ← prefer enriched, fallback to extractor
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
        doc
          .fontSize(12)
          .fillColor('#000')
          .text(`${item.type} • ${fmt(item.created)}${item.author ? ` • ${item.author}` : ''}`);
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
            const header = `— ${fmt(c.created)}${c.author ? ` • ${c.author}` : ''}`;
            doc.fontSize(10).fillColor('#333').text(header, { indent: 16 });
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

/** Generic author extractor used for emails/comments (hardened). */
function extractAuthor(obj) {
  if (!obj || typeof obj !== 'object') return '';
  // Try to pick a name from any nested object fields first
  const nested = [obj.createdBy, obj.author, obj.user, obj.from, obj.sender];
  for (const cand of nested) {
    const name = pickName(cand);
    if (name) return name;
  }
  // As a fallback, check direct `.name` properties
  if (obj.createdBy?.name) return String(obj.createdBy.name);
  if (obj.author?.name)   return String(obj.author.name);
  if (obj.user?.name)     return String(obj.user.name);
  if (obj.from?.name)     return String(obj.from.name);
  if (obj.sender?.name)   return String(obj.sender.name);
  return '';
}

/** NOTE-SPECIFIC author extractor: checks common v2 shapes, including HAL. */
function extractNoteAuthor(note) {
  // 1) If HAL link exposes a title for the creator, prefer it
  const halCreatedBy =
    (note?._links?.createdBy && typeof note._links.createdBy === 'object' && note._links.createdBy.title) ||
    (note?.links?.createdBy && typeof note.links.createdBy === 'object' && note.links.createdBy.title);
  if (halCreatedBy && typeof halCreatedBy === 'string') return halCreatedBy;

  // 2) Try rich/nested objects and common flat name fields
  const candidates = [
    note?.createdBy,
    note?.createdByUser,
    note?.author,
    note?.user,
    note?.owner,
    note?.sender,
    note?.from,
    note?._embedded?.createdBy,
    note?._embedded?.createdByUser,
    note?._embedded?.author,
    note?._embedded?.user,
    note?._embedded?.owner,
    note?.createdByName,
    note?.createdByDisplayName,
    note?.authorName,
    note?.userFullName,
    note?.userName,
    note?.displayName,
    note?.fullName
  ];

  for (const c of candidates) {
    const name = pickName(c);
    if (name) return name;
  }

  // 3) Check embedded users, if any, with ID matching
  const idCandidates = collectAuthorIdCandidates(note);
  const users = note?._embedded?.users || note?.embedded?.users;
  if (Array.isArray(users) && idCandidates.length) {
    for (const u of users) {
      const uid = String(u?.id ?? u?.userId ?? u?.native ?? '');
      if (uid && idCandidates.includes(uid)) {
        const nm = pickName(u);
        if (nm) return nm;
      }
    }
  }

  // 4) Fallback to the generic extractor (covers some additional shapes)
  return extractAuthor(note);
}

/** Convert different object shapes into a name string. */
function pickName(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    const name =
      x.name ||
      x.fullName ||
      x.displayName ||
      x.userFullName ||
      (x.firstName || x.lastName ? `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() : '');
    if (name) return String(name);
    // Sometimes the HAL link object carries a title key
    if (x.title && typeof x.title === 'string') return x.title;
  }
  return '';
}

function collectAuthorIdCandidates(note) {
  const ids = [];
  const push = (v) => { if (v != null) ids.push(String(v)); };
  push(note?.createdById);
  push(note?.createdByUserId);
  push(note?.userId);
  push(note?.authorId);
  if (note?.createdBy && typeof note.createdBy === 'object') {
    push(note.createdBy.id);
    push(note.createdBy.userId);
    push(note.createdBy.native);
  }
  return ids.filter(Boolean);
}

function debugNoteAuthorFields(notes, reqId) {
  if (!Array.isArray(notes) || !notes.length) return;
  const n = notes[0];
  const snapshot = {
    createdBy: summarize(n?.createdBy),
    createdByUser: summarize(n?.createdByUser),
    author: summarize(n?.author),
    user: summarize(n?.user),
    owner: summarize(n?.owner),
    from: summarize(n?.from),
    sender: summarize(n?.sender),
    createdByName: n?.createdByName,
    createdByDisplayName: n?.createdByDisplayName,
    authorName: n?.authorName,
    userFullName: n?.userFullName,
    userName: n?.userName,
    displayName: n?.displayName,
    fullName: n?.fullName,
    createdById:
      n?.createdById ?? n?.createdByUserId ?? n?.userId ?? n?.authorId ??
      (typeof n?.createdBy === 'object' && (n.createdBy.id ?? n.createdBy.native)) ?? null,
    '_links.createdBy': summarize(n?._links?.createdBy),
    '_embedded.createdBy': summarize(n?._embedded?.createdBy),
    '_embedded.users.len': Array.isArray(n?._embedded?.users) ? n._embedded.users.length : 0
  };
  dlog(`[${reqId}] First note author debug`, snapshot);
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
    if (isNaN(date.getTime())) {
      console.warn('Invalid date value:', d);
      return 'Invalid Date';
    }
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (err) {
    console.warn('Date formatting error:', err.message, 'for value:', d);
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

function toAbsoluteUrl(pathOrUrl) {
  // If Filevine returns a relative HAL link (e.g., "/users/{id}"), make it absolute.
  try {
    return new URL(pathOrUrl, GATEWAY_REGION_BASE).toString();
  } catch {
    return String(pathOrUrl || '');
  }
}

async function getBearerToken(reqId) {
  const client_id = process.env.FILEVINE_CLIENT_ID;
  const client_secret = process.env.FILEVINE_CLIENT_SECRET;
  const pat_token = process.env.FILEVINE_PAT_TOKEN;
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
        { label: 'GET notes',              method: 'GET',  url: `${base}/notes` },
        { label: 'GET activity/notes',     method: 'GET',  url: `${base}/activity/notes` },
        { label: 'GET activity?types=note',method: 'GET',  url: `${base}/activity`, qp: { types: 'note' } },
        { label: 'GET notes/list',         method: 'GET',  url: `${base}/notes/list` },
        { label: 'POST notes',             method: 'POST', url: `${base}/notes`,      body: ({offset, limit}) => ({ offset, limit }) },
        { label: 'POST notes/list',        method: 'POST', url: `${base}/notes/list`, body: ({offset, limit}) => ({ offset, limit }) },
      ]
    : [
        { label: 'GET emails',              method: 'GET',  url: `${base}/emails` },
        { label: 'GET activity/emails',     method: 'GET',  url: `${base}/activity/emails` },
        { label: 'GET activity?types=email',method: 'GET',  url: `${base}/activity`, qp: { types: 'email' } },
        { label: 'GET emails/list',         method: 'GET',  url: `${base}/emails/list` },
        { label: 'POST emails',             method: 'POST', url: `${base}/emails`,      body: ({offset, limit}) => ({ offset, limit }) },
        { label: 'POST emails/list',        method: 'POST', url: `${base}/emails/list`, body: ({offset, limit}) => ({ offset, limit }) },
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
    const init = {
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
    dlog(`[${reqId}] ${strat.method} ${urlStr} (${label})`, {
      offset, limit, strategy: strat.label,
      headers: { 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId) }
    });

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
  if (Array.isArray(data.comments)) return data.comments;
  return [];
}

function inferHasMore(data, items, limit, _offset) {
  if (data?.hasMore === true) return true;
  if (typeof data?.hasMore === 'string' && data.hasMore.toLowerCase() === 'true') return true;
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
  return found.map(c => {
    // Resolve name if present inline, else keep blank to be enriched later
    const authorName = extractAuthor(c);
    // Capture an author-id for enrichment if needed
    let authorId = null;
    if (c?.createdById) {
      authorId = typeof c.createdById === 'object'
                ? (c.createdById.native || c.createdById.id || c.createdById.userId)
                : c.createdById;
    }
    if (!authorId) {
      authorId = c?.createdByUserId || c?.userId || c?.authorId || null;
    }
    return ({
      id: normalizeId(c?.id ?? c?.commentId),
      created: extractDate(c, 'comment'),
      author: authorName,
      body: c?.body || c?.text || c?.content || '',
      __authorId: authorId
    });
  });
}

function commentsLinkFromNote(note) {
  const candidate =
    note?._links?.comments?.href ||
    note?._links?.comments ||
    note?.links?.comments?.href ||
    note?.links?.comments ||
    null;
  return candidate ? String(candidate) : null;
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
              const link = commentsLinkFromNote(note);
              const comments = await getNoteComments({
                projectId,
                noteId,
                explicitUrl: link,
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
  const limit = 50;
  const nid  = encodeURIComponent(String(noteId));

  // 1) Try explicit per-item HAL link first (often "/notes/{id}/comments")
  if (explicitUrl) {
    const abs = toAbsoluteUrl(explicitUrl);
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

  // 2) Fallback: global notes resource (NOT project-scoped) → /notes/{noteId}/comments
  const strategies = [
    { label: 'GET /notes/{id}/comments', method: 'GET', url: `${GATEWAY_REGION_BASE}/notes/${nid}/comments` }
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
  return items.map(c => {
    // Determine author name if available
    const authorName = extractAuthor(c);
    // Capture the creator's ID (native user ID) for fallback enrichment
    let authorId = null;
    if (c?.createdById) {
      authorId = typeof c.createdById === 'object'
                ? (c.createdById.native || c.createdById.id || c.createdById.userId)
                : c.createdById;
    }
    if (!authorId) {
      authorId = c?.createdByUserId || c?.userId || c?.authorId || null;
    }
    return ({
      id: normalizeId(c?.id ?? c?.commentId),
      created: extractDate(c, 'comment'),
      author: authorName,
      body: c?.body || c?.text || c?.content || '',
      __authorId: authorId
    });
  });
}

/* ---------- author enrichment ---------- */

function createdByLinkFromNote(note) {
  return (
    (note?._links?.createdBy?.href || note?._links?.createdBy) ||
    (note?.links?.createdBy?.href   || note?.links?.createdBy) ||
    null
  ) ? String((note?._links?.createdBy?.href || note?._links?.createdBy || note?.links?.createdBy?.href || note?.links?.createdBy)) : null;
}

/**
 * For notes whose author name isn't obvious, try to resolve it by:
 *  1) Following the HAL createdBy link (GET that URL, cache it, pick a name)
 *  2) If no HAL link, request /users/{creatorId} based on createdById-like fields
 *  3) Matching against _embedded.users (if present) by creator id
 */
async function enrichNoteAuthors(notes, bearer, userId, orgId, reqId) {
  if (!Array.isArray(notes) || !notes.length) return;

  // Which notes still lack an author name?
  const unresolved = notes.filter(n => {
    const already = n?.__author || extractNoteAuthor(n);
    return !already;
  });
  if (!unresolved.length) {
    dlog(`[${reqId}] author enrichments`, { totalNotes: notes.length, unresolvedBefore: 0, unresolvedAfter: 0 });
    return;
  }

  // 1) Follow HAL createdBy links (dedup + cache)
  const hrefToNotes = new Map();
  for (const n of unresolved) {
    const href = createdByLinkFromNote(n);
    if (href) {
      const abs = toAbsoluteUrl(href);
      if (!hrefToNotes.has(abs)) hrefToNotes.set(abs, []);
      hrefToNotes.get(abs).push(n);
    } else {
      // 2) Fallback: construct a user URL from the note's creator ID
      let creatorId = null;
      if (n?.createdById) {
        creatorId = typeof n.createdById === 'object'
          ? (n.createdById.native || n.createdById.id || n.createdById.userId)
          : n.createdById;
      }
      if (!creatorId) creatorId = n?.createdByUserId || n?.userId || n?.authorId || null;
      if (creatorId) {
        const abs = toAbsoluteUrl(`/users/${creatorId}`);
        if (!hrefToNotes.has(abs)) hrefToNotes.set(abs, []);
        hrefToNotes.get(abs).push(n);
      }
    }
  }

  const entries = Array.from(hrefToNotes.entries());
  const MAX_CONCURRENCY = Math.min(6, Math.max(1, entries.length));
  let idx = 0;

  async function worker() {
    while (idx < entries.length) {
      const [abs, bucket] = entries[idx++];
      try {
        const init = {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'x-fv-userid': String(userId),
            'x-fv-orgid': String(orgId),
            'Accept': 'application/json'
          }
        };
        dlog(`[${reqId}] GET ${abs} (author-resolve)`);
        const resp = await fetchWithRetry(abs, init, reqId);
        dlog(`[${reqId}] author-resolve response`, { status: resp.status });
        if (!resp.ok) {
          await logErrorBody(resp, reqId, 'author-resolve');
          continue;
        }
        const data = await safeJson(resp, reqId, 'author-resolve');
        const name =
          pickName(data) ||
          pickName(data?.user) ||
          pickName(data?.person) ||
          pickName(data?.profile) ||
          data?.displayName ||
          data?.fullName ||
          data?.name ||
          '';
        if (name) {
          for (const n of bucket) n.__author = name;
        } else {
          dlog(`[${reqId}] author-resolve no usable name`, { keys: Object.keys(data || {}) });
        }
      } catch (e) {
        dlog(`[${reqId}] author-resolve failed`, { url: abs, error: e?.message });
      }
    }
  }
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()));

  // 3) Embedded users matching by id (for any still unresolved)
  for (const n of unresolved) {
    if (n.__author) continue;
    const idCandidates = collectAuthorIdCandidates(n);
    const users = n?._embedded?.users || n?.embedded?.users;
    if (Array.isArray(users) && idCandidates.length) {
      for (const u of users) {
        const uid = String(u?.id ?? u?.userId ?? u?.native ?? '');
        if (uid && idCandidates.includes(uid)) {
          const nm = pickName(u);
          if (nm) { n.__author = nm; break; }
        }
      }
    }
  }

  const still = notes.filter(n => !(n.__author || extractNoteAuthor(n))).length;
  dlog(`[${reqId}] author enrichments`, {
    totalNotes: notes.length,
    unresolvedBefore: unresolved.length,
    unresolvedAfter: still,
    halLinksFollowed: entries.length
  });
}

/**
 * For comments that don't include a ready-made author name,
 * resolve via /users/{id} using the captured __authorId on each comment.
 */
async function enrichCommentAuthors(notes, bearer, userId, orgId, reqId) {
  if (!Array.isArray(notes) || !notes.length) return;

  const userUrlMap = new Map(); // userUrl -> list of comment objects needing that user
  for (const note of notes) {
    if (!Array.isArray(note?.comments)) continue;
    for (const c of note.comments) {
      if (!c?.author) {
        const uid = c?.__authorId;
        if (!uid) continue;
        const absUrl = toAbsoluteUrl(`/users/${uid}`);
        if (!userUrlMap.has(absUrl)) userUrlMap.set(absUrl, []);
        userUrlMap.get(absUrl).push(c);
      }
    }
  }

  if (userUrlMap.size === 0) {
    dlog(`[${reqId}] Comment author enrichment: none needed (all names present)`);
    return;
  }

  const entries = Array.from(userUrlMap.entries());
  const MAX_CONCURRENCY = Math.min(6, entries.length);
  let idx = 0;

  async function worker() {
    while (idx < entries.length) {
      const [userUrl, commentList] = entries[idx++];
      try {
        dlog(`[${reqId}] GET ${userUrl} (comment-author-resolve)`);
        const resp = await fetchWithRetry(userUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'x-fv-userid': String(userId),
            'x-fv-orgid': String(orgId),
            'Accept': 'application/json'
          }
        }, reqId);
        dlog(`[${reqId}] comment-author-resolve response`, { status: resp.status });
        if (!resp.ok) {
          await logErrorBody(resp, reqId, 'comment-author-resolve');
          continue;
        }
        const data = await safeJson(resp, reqId, 'comment-author-resolve');
        const name = pickName(data)
          || pickName(data?.user)
          || pickName(data?.person)
          || pickName(data?.profile)
          || data?.displayName
          || data?.fullName
          || data?.name
          || '';
        if (name) {
          commentList.forEach(c => { c.author = name; });
        } else {
          dlog(`[${reqId}] comment-author-resolve: no name found`, { keys: Object.keys(data || {}) });
        }
      } catch (e) {
        dlog(`[${reqId}] comment-author-resolve failed`, { url: userUrl, error: e?.message });
      }
    }
  }
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()));
  dlog(`[${reqId}] Comment author enrichment complete`, { totalUsers: userUrlMap.size });
}
