import PDFDocument from 'pdfkit';

const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
const GATEWAY_UTILS_BASE  = 'https://api.filevineapp.com/fv-app/v2';
const GATEWAY_REGION_BASE = 'https://api.filevineapp.com/fv-app/v2';
const DEBUG = (process.env.DEBUG ?? 'true').toLowerCase() !== 'false';

const REQ = () => Math.random().toString(36).slice(2, 10);
const dlog = (...args) => { if (DEBUG) console.log('[debug]', ...args); };

/* ===== Static User ID → Name map (generated 2025-08-15T17:41:13.329535Z) ===== */
const USER_ID_TO_NAME = {
  "990003321": "Rebecca Gallicchio",
  "990003322": "Adam Kotlar",
  "990003902": "LeadDocket Integration",
  "990003913": "Filevine Integration",
  "990004437": "Taylor Bentsen",
  "990004538": "Ali Cohen Goren",
  "990004539": "Leslie Johnson",
  "990004540": "Michelle Velykis",
  "990004742": "Justin Cohen",
  "990008308": "Periscopereports",
  "990008411": "Khcfilevine",
  "990008551": "Persicope Integration",
  "990008711": "Client Access",
  "990009268": "Alan Rosenberg",
  "990009269": "Dan Levine",
  "990009270": "Howard Batt",
  "990009272": "Jim Nowak",
  "990009274": "Jesse Proctor",
  "990009276": "Jose Hernandez",
  "990009277": "Mitch Cohen",
  "990009279": "Richard Astorino",
  "990009280": "Scott Lewis",
  "990009281": "Sherry Cohen",
  "990009282": "Tim Search",
  "990009283": "Wendi Spector",
  "990009284": "Heather Quarry",
  "990009287": "Diane Aregood",
  "990009289": "Tony Rodriguez",
  "990009290": "Adrienne Peurifoy",
  "990009291": "Alondra Zavala",
  "990009292": "Amanda Danze",
  "990009294": "Anne Seguin",
  "990009299": "Dee Lipiec",
  "990009301": "Kelsey Seguin",
  "990009302": "Kris Scotten",
  "990009303": "Lucero Novoa",
  "990009304": "Maggie Algea",
  "990009305": "Maria Quinones",
  "990009311": "Rosemarie Chuplis-Wright",
  "990009312": "Shelli Okon",
  "990009370": "Joe Vastano",
  "990009372": "Melanie Gaspar",
  "990009373": "Kelly Orellana",
  "990009972": "Jaynewestergard",
  "990010667": "Cristy Farillon",
  "990010668": "Rey Esogon",
  "990010807": "Intern",
  "990010888": "Mike Berenato",
  "990010932": "Alex Garcia",
  "990011544": "FV Administrator",
  "990011720": "Joehirt",
  "990011773": "Sarah O'Neill",
  "990011924": "Tuvae Nerveza-York",
  "990011925": "Filevine Integration",
  "990011931": "Vanessa Orellana",
  "990012134": "Jack Monari",
  "990012369": "Joelbraegger",
  "990013224": "Eugene Kim",
  "990013254": "Jessica McCann",
  "990013292": "Lucasrezende",
  "990013558": "Susan Burlbaugh",
  "990013635": "Ana Mejia",
  "990013680": "Paulwainright",
  "990014330": "Honeycranston",
  "990014407": "Kristyn Walko",
  "990014497": "Laura Duque",
  "990014521": "Elliottcall",
  "990014532": "Logan",
  "990015247": "Frank Brennan",
  "990015249": "Marlen Robles",
  "990015363": "Andrea Janicki",
  "990015669": "Kenny Mason",
  "990015670": "Alfred Tumolo",
  "990016206": "Laura Juarez",
  "990017035": "Gavin Gray",
  "990017136": "Lexie Robertson",
  "990017137": "Stephanie Rivera",
  "990017372": "Tyler McCann",
  "990017381": "1776",
  "990017389": "Esmeralda Vazquez",
  "990017448": "Travis Hagerman",
  "990017669": "Yriana Quinones",
  "990017670": "Marni Jones",
  "990017693": "Brandon Ponzo",
  "990017710": "Alexa Iuliucci",
  "990017714": "Holly Zeitz",
  "990018063": "Lindsey Burwell",
  "990018066": "KHC Service Account",
  "990018078": "Amanda Blyth-Abrams",
  "990018330": "Charlie Manning",
  "990018442": "Dave Wright",
  "990018443": "Rose Rhinesmith",
  "990018471": "Judy Cariño",
  "990018495": "Krystal Arriaza",
  "990019545": "Client Portal",
  "990019879": "Carrie Kotlar",
  "990020014": "Mario Nurinda",
  "990020232": "Camila Avendaño",
  "990020264": "Michelle Gracias",
  "990020305": "Yamel ObandoSotelo",
  "990020694": "Suzanne HolzMeola",
  "990020695": "Emily Gahagan",
  "990020800": "Jonathan Duran",
  "990020841": "Terri Hiles",
  "990021031": "Christopher Battles",
  "990021076": "Nicole Butler-Teel",
  "990021087": "Beatriz Lima",
  "990021205": "Vinesign Integration",
  "990021332": "Denielle Go",
  "990021409": "Kori Sheridan",
  "990021476": "Clei Narciso",
  "990021479": "Maica",
  "990021480": "Eileen McNally",
  "990021584": "Nikki Fleischhauer",
  "990021773": "Crystal Villa",
  "990021913": "Doobie Okon",
  "990022024": "Dean"
};

/* ===== Small helpers that use the map ===== */
const nameFromMap = (id) => {
  if (id == null) return '';
  const key = typeof id === 'object'
    ? (id.native ?? id.id ?? id.userId ?? id.value ?? null)
    : id;
  if (key == null) return '';
  return USER_ID_TO_NAME[String(key)] || '';
};

const authorIdFromNote = (n) => {
  const c = n || {};
  const probe = (v) => (v && typeof v === 'object') ? (v.native ?? v.id ?? v.userId ?? null) : v;
  return (
    probe(c.createdById) ??
    probe(c.createdByUserId) ??
    probe(c.userId) ??
    probe(c.authorId) ??
    probe(c.createdBy?.id) ??
    probe(c.createdBy?.native) ??
    null
  );
};

const authorIdFromComment = (c) => {
  const probe = (v) => (v && typeof v === 'object') ? (v.native ?? v.id ?? v.userId ?? null) : v;
  return (
    probe(c?.__authorId) ??
    probe(c?.createdById) ??
    probe(c?.createdByUserId) ??
    probe(c?.userId) ??
    probe(c?.authorId) ??
    null
  );
};

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

    const token = await getBearerToken(reqId);
    const { userId, orgId } = await getUserAndOrgIds(token, reqId);
    dlog(`[${reqId}] Using gateway headers`, { 'x-fv-userid': userId, 'x-fv-orgid': orgId });

    const [notesRaw, emails] = await Promise.all([
      pullWithStrategies('notes', projectId, token, userId, orgId, reqId),
      pullWithStrategies('emails', projectId, token, userId, orgId, reqId)
    ]);
    dlog(`[${reqId}] Fetch complete`, { notesCount: notesRaw.length, emailsCount: emails.length });

    const notesWithComments = await attachCommentsToNotes({
      notes: notesRaw,
      projectId,
      token,
      userId,
      orgId,
      reqId
    });

    applyNameMapToNotesAndComments(notesWithComments, reqId);
    applyNameMapToEmails(emails, reqId);

    const merged = [
      ...notesWithComments.map(n => ({
        type: 'Note',
        id: normalizeId(n?.id ?? n?.noteId),
        created: extractDate(n, 'note'),
        author: nameFromMap(authorIdFromNote(n)) || extractNoteAuthor(n) || '',
        title: n?.title || n?.subject || '',
        body: n?.body || n?.text || n?.content || '',
        comments: Array.isArray(n?.comments) ? n.comments : []
      })),
      ...emails.map(e => ({
        type: 'Email',
        id: normalizeId(e?.id ?? e?.emailId),
        created: extractDate(e, 'email'),
        author: nameFromMap(e?.createdById ?? e?.createdByUserId ?? e?.userId ?? e?.authorId ?? e?.fromId) || extractAuthor(e),
        title: e?.subject || e?.title || '',
        body: e?.body || e?.content || e?.text || ''
      }))
    ].sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));

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
        doc.fontSize(12).fillColor('#000').text(`${item.type} • ${fmt(item.created)}${item.author ? ` • ${item.author}` : ''}`);
        if (item.title) { doc.font('Helvetica-Bold').text(item.title); doc.font('Helvetica'); }
        if (item.body) { doc.fontSize(11).fillColor('#111').text(stripHtml(item.body), { align: 'left' }); }

        if (item.type === 'Note' && Array.isArray(item.comments) && item.comments.length) {
          doc.moveDown(0.25);
          doc.fontSize(11).fillColor('#000').text(`Comments (${item.comments.length}):`);
          for (const c of item.comments) {
            const header = `— ${fmt(c.created)}${c.author ? ` • ${c.author}` : ''}`;
            doc.fontSize(10).fillColor('#333').text(header, { indent: 16 });
            if (c.body) doc.fontSize(10).fillColor('#111').text(stripHtml(c.body), { indent: 32 });
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

function extractAuthor(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const nested = [obj.createdBy, obj.author, obj.user, obj.from, obj.sender];
  for (const cand of nested) { const name = pickName(cand); if (name) return name; }
  if (obj.createdBy?.name) return String(obj.createdBy.name);
  if (obj.author?.name)   return String(obj.author.name);
  if (obj.user?.name)     return String(obj.user.name);
  if (obj.from?.name)     return String(obj.from.name);
  if (obj.sender?.name)   return String(obj.sender.name);
  return '';
}

function extractNoteAuthor(note) {
  const halCreatedBy =
    (note?._links?.createdBy && typeof note._links.createdBy === 'object' && note._links.createdBy.title) ||
    (note?.links?.createdBy && typeof note.links.createdBy === 'object' && note.links.createdBy.title);
  if (halCreatedBy && typeof halCreatedBy === 'string') return halCreatedBy;

  const candidates = [
    note?.createdBy, note?.createdByUser, note?.author, note?.user, note?.owner, note?.sender, note?.from,
    note?._embedded?.createdBy, note?._embedded?.createdByUser, note?._embedded?.author, note?._embedded?.user, note?._embedded?.owner,
    note?.createdByName, note?.createdByDisplayName, note?.authorName, note?.userFullName, note?.userName, note?.displayName, note?.fullName
  ];
  for (const c of candidates) { const name = pickName(c); if (name) return name; }

  const idCandidates = collectAuthorIdCandidates(note);
  const users = note?._embedded?.users || note?.embedded?.users;
  if (Array.isArray(users) && idCandidates.length) {
    for (const u of users) {
      const uid = String(u?.id ?? u?.userId ?? u?.native ?? '');
      if (uid && idCandidates.includes(uid)) { const nm = pickName(u); if (nm) return nm; }
    }
  }
  return extractAuthor(note);
}

function pickName(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    const name = x.name || x.fullName || x.displayName || x.userFullName ||
      ((x.firstName || x.lastName) ? `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() : '');
    if (name) return String(name);
    if (x.title && typeof x.title === 'string') return x.title;
  }
  return '';
}

function collectAuthorIdCandidates(note) {
  const ids = [];
  const push = (v) => { if (v != null) ids.push(String(v)); };
  push(normalizeIdMaybe(note?.createdById));
  push(normalizeIdMaybe(note?.createdByUserId));
  push(normalizeIdMaybe(note?.userId));
  push(normalizeIdMaybe(note?.authorId));
  if (note?.createdBy && typeof note.createdBy === 'object') {
    push(normalizeIdMaybe(note.createdBy.id));
    push(normalizeIdMaybe(note.createdBy.userId));
    push(normalizeIdMaybe(note.createdBy.native));
  }
  return ids.filter(Boolean);
}

function normalizeIdMaybe(v) {
  if (v == null) return null;
  if (typeof v === 'object') { return v.native ?? v.id ?? v.userId ?? null; }
  return v;
}

function extractDate(item, type) {
  const dateFields =
    type === 'note'
      ? ['createdDate','created','date','dateCreated','createDate','timestamp','createdAt','dateTime','noteDate','updatedDate']
      : type === 'email'
      ? ['dateReceived','dateSent','createdDate','created','date','dateCreated','createDate','timestamp','createdAt','dateTime','receivedDate','sentDate','emailDate','updatedDate']
      : ['createdDate','created','date','dateCreated','createDate','timestamp','createdAt','dateTime','commentDate','updatedDate'];

  for (const field of dateFields) {
    const value = item?.[field];
    if (value) { const parsed = new Date(value); if (!isNaN(parsed.getTime())) return value; }
  }
  return new Date().toISOString();
}

function fmt(d) {
  if (!d) return 'No Date';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return 'Invalid Date';
    return date.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return 'Date Error'; }
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
  try { return new URL(pathOrUrl, GATEWAY_REGION_BASE).toString(); }
  catch { return String(pathOrUrl || ''); }
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
  const resp = await fetch(IDENTITY_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body });
  dlog(`[${reqId}] Identity response`, { status: resp.status });
  if (!resp.ok) throw new Error(`Identity token error: ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  if (!data.access_token) throw new Error('No access_token in identity response');
  return data.access_token;
}

async function getUserAndOrgIds(bearer, reqId) {
  const url = `${GATEWAY_UTILS_BASE}/utils/GetUserOrgsWithToken`;
  dlog(`[${reqId}] POST ${url} (utils)`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${bearer}`, 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`GetUserOrgsWithToken error: ${resp.status}`);
  const data = await resp.json().catch(() => ({}));

  const userId =
    data?.userId ?? data?.user?.id ?? data?.user?.userId ?? data?.user?.native ?? null;
  const orgId =
    data?.orgId ?? data?.org?.id ?? data?.orgs?.[0]?.orgId ?? data?.orgs?.[0]?.id ?? null;

  if (!userId || !orgId) throw new Error('Could not resolve userId/orgId from gateway response');
  return { userId: String(userId), orgId: String(orgId) };
}

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
      if (items) return items;
    } catch (e) {
      dlog(`[${reqId}] ${kind} failed strategy`, { strategy: strat.label, error: e?.message });
      continue;
    }
  }
  throw new Error(`No ${kind} route matched`);
}

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
    const resp = await fetch(urlStr, init);
    if (!resp.ok) throw new Error(`${urlObj.pathname} ${strat.method} error: ${resp.status}`);
    const data = await resp.json().catch(() => ({}));
    const items = extractItems(data);
    out.push(...items);

    const hasMore = inferHasMore(data, items, limit, offset);
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

function extractEmbeddedComments(note) {
  const arrays = [note?.comments, note?.replies, note?.commentItems, note?.noteComments, note?.thread?.comments, note?.page?.items];
  const found = arrays.find(a => Array.isArray(a)) || [];
  return found.map(c => ({
    id: normalizeId(c?.id ?? c?.commentId),
    created: extractDate(c, 'comment'),
    author: nameFromMap(authorIdFromComment(c)) || extractAuthor(c),
    body: c?.body || c?.text || c?.content || '',
    __authorId: authorIdFromComment(c) ?? null
  }));
}

function commentsLinkFromNote(note) {
  const candidate =
    note?._links?.comments?.href || note?._links?.comments ||
    note?.links?.comments?.href || note?.links?.comments || null;
  return candidate ? String(candidate) : null;
}

async function attachCommentsToNotes({ notes, projectId, token, userId, orgId, reqId }) {
  if (!Array.isArray(notes) || !notes.length) return [];

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
              results.push({ ...note, comments: [] });
            } else {
              const link = commentsLinkFromNote(note);
              const comments = await getNoteComments({
                projectId, noteId, explicitUrl: link, bearer: token, userId, orgId, reqId
              });
              results.push({ ...note, comments });
            }
          } catch (err) {
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

async function getNoteComments({ noteId, explicitUrl, bearer, userId, orgId, reqId }) {
  const limit = 50;
  const nid  = encodeURIComponent(String(noteId));

  if (explicitUrl) {
    const abs = toAbsoluteUrl(explicitUrl);
    try {
      const items = await pullAllPagesWithOneRoute(
        { label: 'GET link:comments', method: 'GET', url: abs },
        bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`
      );
      if (Array.isArray(items) && items.length) return normalizeComments(items);
    } catch (_) { /* ignore */ }
  }

  const strat = { label: 'GET /notes/{id}/comments', method: 'GET', url: `${GATEWAY_REGION_BASE}/notes/${nid}/comments` };
  try {
    const items = await pullAllPagesWithOneRoute(strat, bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`);
    if (Array.isArray(items)) return normalizeComments(items);
  } catch (_) { /* ignore */ }

  return [];
}

function normalizeComments(items) {
  return items.map(c => ({
    id: normalizeId(c?.id ?? c?.commentId),
    created: extractDate(c, 'comment'),
    author: nameFromMap(authorIdFromComment(c)) || extractAuthor(c),
    body: c?.body || c?.text || c?.content || '',
    __authorId: authorIdFromComment(c) ?? null
  }));
}

function applyNameMapToNotesAndComments(notes, reqId) {
  if (!Array.isArray(notes)) return;
  for (const n of notes) {
    const nid = authorIdFromNote(n);
    const nm = nameFromMap(nid);
    if (nm) n.__author = nm;
    if (Array.isArray(n.comments)) {
      for (const c of n.comments) {
        const cid = authorIdFromComment(c);
        const cnm = nameFromMap(cid);
        if (cnm) c.author = cnm;
      }
    }
  }
}

function applyNameMapToEmails(emails, reqId) {
  if (!Array.isArray(emails)) return;
  for (const e of emails) {
    const id = e?.createdById ?? e?.createdByUserId ?? e?.userId ?? e?.authorId ?? e?.fromId ?? null;
    const nm = nameFromMap(id);
    if (nm) e.__author = nm;
  }
}
