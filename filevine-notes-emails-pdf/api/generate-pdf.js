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

const DEBUG = String(process.env.DEBUG ?? 'true').toLowerCase() !== 'false';

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

    // 1) OAuth2 (PAT → bearer)
    const token = await getBearerToken(reqId);

    // 2) Resolve user/org
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

    // 3c) Enrich authors for notes missing a clear author (follows HAL _links.createdBy)
    await enrichNoteAuthors(notesWithComments, token, userId, orgId, reqId);
    // 3c.1) Final fallback: resolve note authors by user ID if still missing
    await resolveNoteAuthorsById(notesWithComments, token, userId, orgId, reqId);

    // 3d) DEBUG: show the extracted/enriched author outcome for the first note
    if (notesWithComments.length) {
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

    const doc = new PDFDocument({ margin: 50, info: { Title: `Project ${projectId} Notes/Emails` }});
    doc.pipe(res);

    // Title
    doc.fontSize(18).text(`Project ${projectId} — Notes & Emails`, { align: 'left' }).moveDown(1.0);

    let itemsPrinted = 0;
    for (const item of merged) {
      if (itemsPrinted > 0) doc.moveDown(0.5);
      const hdr = `${item.type} • ${safeDateTime(item.created)} • ${item.author || 'Unknown'}`;
      doc.fontSize(12).text(hdr, { continued: false });
      if (item.title) doc.font('Helvetica-Bold').text(item.title).font('Helvetica');
      if (item.body) doc.fontSize(11).text(stripHtml(item.body));

      if (item.type === 'Note' && Array.isArray(item.comments) && item.comments.length) {
        for (const c of item.comments) {
          doc.moveDown(0.15);
          doc.fontSize(10).text(`— ${safeDateTime(c.created)} • ${c.author || 'Unknown'}`);
          if (c.body) doc.fontSize(10).text(stripHtml(c.body));
        }
      }
      itemsPrinted++;
    }

    doc.end();
  } catch (err) {
    console.error(`[${reqId}] generate-pdf failure`, err);
    res.statusCode = 500;
    res.end(`Failed to generate PDF: ${err?.message || err}`);
  }
}

/* ---------- helpers ---------- */

function normalizeId(x) {
  if (x == null) return '';
  return typeof x === 'object' ? (x.id ?? x.native ?? x.Native ?? '') : String(x);
}

function stripHtml(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function safeDateTime(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(+d)) return String(v);
    return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
  } catch {
    return String(v);
  }
}

function extractDate(item, kind) {
  const candidates = kind === 'email'
    ? [
        item?.createdAt, item?.created, item?.date,
        item?.sentAt, item?.sentDate, item?.receivedAt
      ]
    : [
        item?.createdAt, item?.created, item?.date,
        item?.lastActivity, item?.targetDate, item?.completedDate
      ];
  for (const c of candidates) {
    const d = c ? new Date(c) : null;
    if (d && !isNaN(+d)) return d.toISOString();
  }
  return '';
}

function extractAuthor(item) {
  // Try common shapes for notes, emails, comments
  const pools = [
    item?.author, item?.from, item?.sender, item?.user, item?.owner,
    item?.createdBy, item?.createdByUser, item?.assignee, item?.completer
  ];
  for (const p of pools) {
    const nm = pickName(p);
    if (nm) return nm;
  }
  // flat strings too
  const flat = [
    item?.authorName, item?.createdByName, item?.createdByDisplayName,
    item?.displayName, item?.userFullName, item?.userName, item?.fullName
  ];
  for (const s of flat) {
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return '';
}

/**
 * Notes sometimes use different shapes than comments/emails; this tries common note-specific fields first
 */
function extractNoteAuthor(note) {
  const candidates = [
    note?.author, note?.from, note?.sender, note?.user, note?.owner,
    note?.createdBy, note?.createdByUser, note?.assignee, note?.completer,
    note?.createdByName, note?.createdByDisplayName, note?.authorName,
    note?.userFullName, note?.userName, note?.displayName, note?.fullName
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
  const summarize = (v) => {
    if (v == null) return v;
    if (typeof v === 'string') return v.slice(0, 50);
    if (typeof v === 'object') return `{keys:${Object.keys(v).length}}`;
    return typeof v;
  };
  const n = notes[0];
  dlog(`[${reqId}] first-note author fields`, {
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
      (typeof n?.createdBy === 'object' && (n.createdBy?.id ?? n.createdBy?.userId ?? n.createdBy?.native)) ?? null
  });
}

function debugDateFields(items, label, reqId) {
  if (!Array.isArray(items) || !items.length) return;
  const i = items[0];
  dlog(`[${reqId}] first-${label} date fields`, {
    createdAt: i?.createdAt,
    created: i?.created,
    date: i?.date,
    sentAt: i?.sentAt,
    sentDate: i?.sentDate,
    receivedAt: i?.receivedAt,
    lastActivity: i?.lastActivity,
    targetDate: i?.targetDate,
    completedDate: i?.completedDate
  });
}

/* ---------- URLs / HTTP ---------- */

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

  dlog(`[${reqId}] POST ${IDENTITY_URL} (token)`);
  const resp = await fetchWithRetry(IDENTITY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, reqId);
  dlog(`[${reqId}] token response`, { status: resp.status });
  if (!resp.ok) throw new Error(`Identity error: ${resp.status}`);
  const data = await safeJson(resp, reqId, 'token');
  const access_token = data?.access_token || data?.accessToken || data?.token || null;
  if (!access_token) throw new Error('Missing access token in identity response');
  return access_token;
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
  const orgId = pickOrgId(data);
  if (!userId || !orgId) throw new Error('Unable to resolve user/org ids from token');
  return { userId, orgId };
}

function pickUserId(data) {
  const candidates = [
    data?.userId,
    data?.user?.id,
    data?.user?.userId,
    data?.profile?.userId,
    data?.profile?.id,
    data?.id
  ];
  for (const c of candidates) {
    if (typeof c === 'number' || typeof c === 'string') return c;
    if (c && typeof c === 'object' && (typeof c.id === 'number' || typeof c.id === 'string')) return c.id;
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
 * Stops on first 200 with items.
 */
async function pullWithStrategies(kind, projectId, bearer, userId, orgId, reqId) {
  const limit = 100;
  const baseHeaders = {
    'Authorization': `Bearer ${bearer}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid': String(orgId),
    'Accept': 'application/json'
  };

  const strategies = kind === 'emails'
    ? [
        // Different tenants can expose emails under varying routes
        { label: 'GET emails project-scoped', method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/emails` },
        { label: 'GET emails feed',           method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/feed?type=email` },
        { label: 'GET notes filtered emails', method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/notes?filterByType=email` }
      ]
    : [
        { label: 'GET notes project-scoped', method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/notes` },
        { label: 'GET notes feed',           method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/feed?type=note` }
      ];

  for (const strat of strategies) {
    try {
      const items = await pullAllPagesWithOneRoute(
        strat, bearer, userId, orgId, limit, reqId, `${kind}[project:${projectId}]`
      );
      if (Array.isArray(items) && items.length) return items;
    } catch (e) {
      dlog(`[${reqId}] ${kind} failed strategy`, { strategy: strat.label, error: e?.message });
    }
  }

  dlog(`[${reqId}] All strategies failed for ${kind}`);
  return [];
}

async function pullAllPagesWithOneRoute(strat, bearer, userId, orgId, limit, reqId, tag) {
  const out = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && out.length < 5000) {
    const url = new URL(strat.url);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const hasBody = strat?.body && (strat.method || 'GET').toUpperCase() !== 'GET';
    const init = hasBody
      ? { method: strat.method || 'POST', headers: { 'Authorization': `Bearer ${bearer}`, 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId), 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(strat.body) }
      : { method: strat.method || 'GET',  headers: { 'Authorization': `Bearer ${bearer}`, 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId), 'Accept': 'application/json' } };

    dlog(`[${reqId}] ${strat.label}`, { url: url.toString(), method: init.method });

    const resp = await fetchWithRetry(url.toString(), init, reqId);
    dlog(`[${reqId}] ${strat.label} response`, { status: resp.status });
    if (!resp.ok) {
      await logErrorBody(resp, reqId, strat.label);
      throw new Error(`${strat.label} failed: ${resp.status}`);
    }
    const data = await safeJson(resp, reqId, tag);

    const items = Array.isArray(data?.Items) ? data.Items : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    out.push(...items);

    const count   = typeof data?.Count === 'number' ? data.Count : (Array.isArray(items) ? items.length : 0);
    const limitR  = typeof data?.Limit === 'number' ? data.Limit : limit;
    const hasMoreR = Boolean(data?.HasMore ?? (count >= limitR));

    dlog(`[${reqId}] page`, { received: items.length, outLen: out.length, hasMoreR, offset });

    hasMore = hasMoreR;
    offset += limit;
  }

  return out;
}

/* ---------- author enrichment ---------- */

/** CreatedBy HAL link for a comment. */
function createdByLinkFromComment(comment) {
  const candidate =
    (comment?._links?.createdBy?.href || comment?._links?.createdBy) ||
    (comment?.links?.createdBy?.href   || comment?.links?.createdBy) ||
    null;
  return candidate ? String(candidate) : null;
}

/**
 * Enrich raw comment items in-place with a resolved author name if missing.
 * Strategy:
 *  1) Follow HAL _links.createdBy for each unique URL; cache responses
 *  2) If only an ID is available (authorId/userId/createdById), GET /users/{id}
 */
async function enrichRawCommentAuthors(items, bearer, userId, orgId, reqId) {
  if (!Array.isArray(items) || !items.length) return;

  const unresolved = items.filter(c => {
    const already = c?.__author || extractAuthor(c);
    return !already;
  });
  if (!unresolved.length) return;

  const headers = {
    'Authorization': `Bearer ${bearer}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid' : String(orgId),
    'Accept'     : 'application/json'
  };

  // 1) Resolve via HAL createdBy links
  const hrefToComments = new Map();
  for (const c of unresolved) {
    const href = createdByLinkFromComment(c);
    if (href) {
      const abs = toAbsoluteUrl(href);
      if (!hrefToComments.has(abs)) hrefToComments.set(abs, []);
      hrefToComments.get(abs).push(c);
    }
  }

  for (const [abs, list] of hrefToComments.entries()) {
    try {
      const resp = await fetchWithRetry(abs, { method: 'GET', headers }, reqId);
      if (!resp.ok) {
        await logErrorBody(resp, reqId, 'comment-author-link');
        continue;
      }
      const data = await safeJson(resp, reqId, 'comment-author-link');
      const name = pickName(data);
      if (name) for (const c of list) c.__author = name;
    } catch (e) {
      dlog(`[${reqId}] comment-author-link fetch failed`, { url: abs, error: e?.message });
    }
  }

  // 2) Resolve by user IDs if still missing
  const still = items.filter(c => !(c.__author || extractAuthor(c)));
  if (!still.length) return;

  const idToComments = new Map();
  for (const c of still) {
    const ids = collectAuthorIdCandidates(c);
    for (const id of ids) {
      if (!id) continue;
      const sid = String(id);
      if (!idToComments.has(sid)) idToComments.set(sid, []);
      idToComments.get(sid).push(c);
    }
  }

  for (const [sid, list] of idToComments.entries()) {
    const url = `${GATEWAY_REGION_BASE}/users/${encodeURIComponent(sid)}`;
    try {
      const resp = await fetchWithRetry(url, { method: 'GET', headers }, reqId);
      if (!resp.ok) {
        await logErrorBody(resp, reqId, 'comment-author-id');
        continue;
      }
      const data = await safeJson(resp, reqId, 'comment-author-id');
      const name = pickName(data);
      if (name) for (const c of list) c.__author = name;
    } catch (e) {
      dlog(`[${reqId}] comment-author-id fetch failed`, { id: sid, error: e?.message });
    }
  }
}

function createdByLinkFromNote(note) {
  return (
    (note?._links?.createdBy?.href || note?._links?.createdBy) ||
    (note?.links?.createdBy?.href   || note?.links?.createdBy) ||
    null
  ) ? String(
    (note?._links?.createdBy?.href || note?._links?.createdBy) ||
    (note?.links?.createdBy?.href   || note?.links?.createdBy)
  ) : null;
}

/**
 * For notes whose author name isn't obvious, try to resolve it by:
 *  1) Following the HAL createdBy link (GET that URL, cache it, pick a name)
 *  2) Matching against _embedded.users (if present) by creator id
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
    }
  }

  const entries = Array.from(hrefToNotes.entries());
  const authorCache = new Map();
  const MAX_CONCURRENCY = Math.min(6, Math.max(1, entries.length));

  let inFlight = 0;
  await new Promise((resolve) => {
    const runNext = async () => {
      if (!entries.length && inFlight === 0) return resolve();
      while (inFlight < MAX_CONCURRENCY && entries.length) {
        const [abs, list] = entries.shift();
        inFlight++;
        (async () => {
          try {
            if (!authorCache.has(abs)) {
              const resp = await fetchWithRetry(abs, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${bearer}`, 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId), 'Accept': 'application/json' }
              }, reqId);
              if (resp.ok) {
                const data = await safeJson(resp, reqId, 'note-author-link');
                const nm = pickName(data);
                if (nm) authorCache.set(abs, nm);
              } else {
                await logErrorBody(resp, reqId, 'note-author-link');
              }
            }
            const name = authorCache.get(abs);
            if (name) for (const n of list) n.__author = name;
          } catch (e) {
            dlog(`[${reqId}] note-author-link fetch failed`, { url: abs, error: e?.message });
          } finally {
            inFlight--;
            runNext();
          }
        })();
      }
    };
    runNext();
  });

  // 2) Try _embedded.users if any (ID matching)
  for (const n of notes) {
    if (n.__author || extractNoteAuthor(n)) continue;
    const idCandidates = collectAuthorIdCandidates(n);
    if (!idCandidates.length) continue;
    const users = n?._embedded?.users || n?.embedded?.users;
    if (Array.isArray(users)) {
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
 * Final fallback: resolve note authors by user ID if name still missing.
 */
async function resolveNoteAuthorsById(notes, bearer, userId, orgId, reqId) {
  if (!Array.isArray(notes) || !notes.length) return;
  const pending = notes.filter(n => !(n?.__author || extractNoteAuthor(n)));
  if (!pending.length) return;

  const idMap = new Map();
  for (const n of pending) {
    const ids = collectAuthorIdCandidates(n);
    for (const id of ids) {
      if (!id) continue;
      const sid = String(id);
      if (!idMap.has(sid)) idMap.set(sid, []);
      idMap.get(sid).push(n);
    }
  }

  if (!idMap.size) return;

  const headers = {
    'Authorization': `Bearer ${bearer}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid' : String(orgId),
    'Accept'     : 'application/json'
  };

  for (const [sid, list] of idMap.entries()) {
    const url = `${GATEWAY_REGION_BASE}/users/${encodeURIComponent(sid)}`;
    try {
      const resp = await fetchWithRetry(url, { method: 'GET', headers }, reqId);
      if (!resp.ok) {
        await logErrorBody(resp, reqId, 'note-author-id');
        continue;
      }
      const data = await safeJson(resp, reqId, 'note-author-id');
      const name = pickName(data);
      if (name) for (const n of list) n.__author = name;
    } catch (e) {
      dlog(`[${reqId}] note-author-id fetch failed`, { id: sid, error: e?.message });
    }
  }
}

/* ---------- comments fetching ---------- */

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
            const noteId = note?.id ?? note?.noteId ?? note?.NoteId?.Native ?? note?.NoteId?.id ?? null;
            const link   = note?._links?.comments?.href || note?._links?.comments || note?.links?.comments?.href || note?.links?.comments || null;
            if (!noteId && !link) {
              results.push({ ...note, comments: [] });
            } else {
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
      if (Array.isArray(items) && items.length) { await enrichRawCommentAuthors(items, bearer, userId, orgId, reqId);
      return normalizeComments(items); }
    } catch (e) {
      dlog(`[${reqId}] comments explicit link failed`, { url: explicitUrl, abs, error: e?.message });
    }
  }

  // 2) Fallback: global notes resource (NOT project-scoped) → /notes/{noteId}/comments
  const strategies = [
    { label: 'GET notes/{id}/comments', method: 'GET', url: `${GATEWAY_REGION_BASE}/notes/${nid}/comments` },
    { label: 'GET projects/{id}/notes/{id}/comments', method: 'GET', url: `${GATEWAY_REGION_BASE}/projects/${encodeURIComponent(projectId)}/notes/${nid}/comments` } // occasionally works in some tenants
  ];

  for (const strat of strategies) {
    try {
      const items = await pullAllPagesWithOneRoute(
        strat, bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`
      );
      if (Array.isArray(items) && items.length) { await enrichRawCommentAuthors(items, bearer, userId, orgId, reqId);
      return normalizeComments(items); }
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
    author: (c?.__author && String(c.__author).trim()) || extractAuthor(c),
    body: c?.body || c?.text || c?.content || ''
  }));
}

/* ---------- fetch utils ---------- */

/** Basic retry for idempotent GET/POST to mitigate transient errors. */
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
        dlog(`[${reqId}] fetchWithRetry error`, { url: input, error: err?.message, attempt });
        await sleep(delayMs * attempt);
        retries--;
        continue;
      }
      throw err;
    }
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
  return typeof v;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    dlog(`[${reqId}] ${tag} read body failed`, { message: err?.message });
    return {};
  }
}
