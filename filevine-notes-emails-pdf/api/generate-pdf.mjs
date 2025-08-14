#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Filevine Notes & Emails → PDF (with comments), robust link fallback, de-dup, and author resolution.
 * Node 18+ (global fetch). Output: ./project-{id}-notes-emails-{YYYY-MM-DD}.pdf
 *
 * Key improvements (based on your log & sample PDF):
 *  - Fix: treat 200 with 0 comment items as success, not "failed".
 *  - Fallback: /notes/{id}/comments -> /fv-app/v2/notes/{id}/comments.
 *  - Resolve createdById.native to user full name via /fv-app/v2/users/{id}, with cache.
 *  - De-dup emails/notes that mirror each other in Filevine (subject/body/date/recipients).
 *  - Safer PDF link detection + wrapping (no mid-URL split).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import PDFDocument from 'pdfkit';

/* ----------------------------- Config & Helpers ---------------------------- */

const CONFIG = {
  identityBase: process.env.FILEVINE_IDENTITY_BASE || 'https://identity.filevine.com',
  apiBase: process.env.FILEVINE_API_BASE || 'https://api.filevineapp.com',
  v2Base: '/fv-app/v2',
  clientId: process.env.FILEVINE_CLIENT_ID,
  clientSecret: process.env.FILEVINE_CLIENT_SECRET,
  scope:
    process.env.FILEVINE_SCOPE ||
    'email filevine.v2.api.* fv.api.gateway.access fv.auth.tenant.read openid tenant',
  accessToken: process.env.FILEVINE_ACCESS_TOKEN, // if set, skip token exchange
  outputDir: process.cwd(),
  pageSize: 'LETTER',
  margin: 50,
  pdfFontSize: 11,
  titleFontSize: 16,
  h2FontSize: 12,
  /* If set > 0, very long bodies/comments will be truncated to this length (adds " …[truncated]"). */
  softLimitBodyChars: 0, // set e.g. 20000 if you need to cap massive disclaimers
};

const traceId = randomId();

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function log(level, msg, ctx = {}) {
  const iso = new Date().toISOString();
  const ns = `[${traceId}]`;
  const payload = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
  console.log(`${iso} [info] [${level}] ${ns} ${msg}${payload}`);
}
function jsonPreview(obj, inlineKeys = []) {
  const clone = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (v == null) clone[k] = v;
    else if (typeof v === 'string') clone[k] = v.length > 60 ? `${v.slice(0, 57)}…` : v;
    else if (Array.isArray(v)) clone[k] = `[array len=${v.length}]`;
    else if (typeof v === 'object') clone[k] = `{object keys=${Object.keys(v).length}}`;
    else clone[k] = v;
  }
  for (const k of inlineKeys) if (obj?.[k] != null) clone[k] = obj[k];
  return clone;
}
function toDate(d) {
  // accept epoch ms, ISO string, or Filevine style strings
  if (!d) return null;
  try {
    const n = +d;
    if (!Number.isNaN(n) && n > 0) return new Date(n);
  } catch {}
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
}
function fmtDate(d) {
  if (!d) return '';
  // Use server-local TZ unless overridden by TZ env var
  const f = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return f.format(d);
}
function normText(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000|\u0001|\u0002/g, '') // strip stray control chars
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function hashFingerprint(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}
function stable(val) {
  return val == null ? '' : String(val).trim().toLowerCase();
}
function byChronAsc(a, b) {
  return (a.when?.getTime?.() ?? 0) - (b.when?.getTime?.() ?? 0);
}
function ensureArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

/* ------------------------------ HTTP Wrapper ------------------------------ */

async function http(method, url, { headers = {}, json, form, rawBody, expect = 200 } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json != null) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form != null) {
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  } else if (rawBody != null) {
    opts.body = rawBody;
  }
  const res = await fetch(url, opts);
  if (expect != null && res.status !== expect) {
    const snippet = await res.text().catch(() => '');
    throw Object.assign(new Error(`${method} ${url} => ${res.status}`), {
      status: res.status,
      snippet: snippet?.slice(0, 200),
    });
  }
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) return res.json();
  return res.text();
}

/* ---------------------------- Auth & Org Lookup --------------------------- */

async function getAccessToken() {
  if (CONFIG.accessToken) {
    log('debug', 'Using provided bearer token (skip exchange)', {
      tokenLen: CONFIG.accessToken.length,
    });
    return CONFIG.accessToken;
  }
  const url = `${CONFIG.identityBase}/connect/token`;
  log('debug', 'POST ' + url + ' (token exchange)');
  const body = await http('POST', url, {
    form: {
      grant_type: 'client_credentials',
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      scope: CONFIG.scope,
    },
  });
  log('debug', 'Identity response', { status: 200 });
  log('debug', 'identity JSON preview', jsonPreview(body));
  const token = body?.access_token;
  if (!token) throw new Error('No access_token in token exchange response');
  log('debug', 'Token acquired (length)', { accessTokenLength: token.length });
  return token;
}

async function getUserOrg(token) {
  const url = `${CONFIG.apiBase}${CONFIG.v2Base}/utils/GetUserOrgsWithToken`;
  log('debug', 'POST ' + url + ' (utils)');
  const body = await http('POST', url, {
    headers: { authorization: `Bearer ${token}` },
  });
  log('debug', 'GetUserOrgsWithToken response', { status: 200 });
  log('debug', 'getUserOrgsWithToken JSON preview', {
    user: '{object keys=' + Object.keys(body?.user || {}).length + '}',
    orgs: '[array len=' + (body?.orgs?.length || 0) + ']',
  });
  const userId = body?.user?.userId?.native ?? body?.user?.id;
  const orgId = body?.orgs?.[0]?.orgId?.native ?? body?.orgs?.[0]?.id;
  if (!userId || !orgId) throw new Error('Unable to resolve userId/orgId');
  log('debug', 'Resolved IDs', { userId, orgId, keys: Object.keys(body) });
  return { userId, orgId };
}

/* ------------------------------ API Functions ----------------------------- */

async function getPaged(token, userId, orgId, url, label) {
  let offset = 0;
  const limit = 50;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid': String(orgId),
  };
  const items = [];
  let hasMore = true;
  while (hasMore) {
    const pageUrl = `${url}?limit=${limit}&offset=${offset}`;
    log('debug', `GET ${pageUrl} (${label})`, { offset, limit, strategy: `GET ${label}` });
    const page = await http('GET', pageUrl, { headers });
    log('debug', `${label} page response`, { status: 200, offset, strategy: `GET ${label}` });
    log('debug', `${label}-page(GET ${label}) JSON preview`, jsonPreview(page));
    const pageItems = page?.items || [];
    items.push(...pageItems);
    hasMore = Boolean(page?.hasMore) || pageItems.length === limit;
    log('debug', `${label} page parsed`, {
      itemsReceived: pageItems.length,
      totalAccumulated: items.length,
      hasMore,
      strategy: `GET ${label}`,
    });
    if (hasMore) offset += limit;
  }
  log('debug', `${label} using strategy`, { strategy: `GET ${label}`, total: items.length });
  return items;
}

async function getProjectNotesAndEmails(token, userId, orgId, projectId) {
  const base = `${CONFIG.apiBase}${CONFIG.v2Base}`;
  const [notes, emails] = await Promise.all([
    getPaged(token, userId, orgId, `${base}/projects/${projectId}/notes`, 'notes'),
    getPaged(token, userId, orgId, `${base}/projects/${projectId}/emails`, 'emails'),
  ]);
  log('debug', 'Fetch complete', {
    notesCount: notes.length,
    emailsCount: emails.length,
  });
  return { notes, emails };
}

async function getNoteComments(token, userId, orgId, noteId) {
  const headers = {
    authorization: `Bearer ${token}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid': String(orgId),
  };
  const link1 = `${CONFIG.apiBase}/notes/${noteId}/comments?limit=50&offset=0`; // legacy
  const link2 = `${CONFIG.apiBase}${CONFIG.v2Base}/notes/${noteId}/comments?limit=50&offset=0`; // v2
  // 1) Try legacy link (may 404 for some tenants/routes)
  try {
    log('debug', `GET ${link1} (comments[note:${noteId}])`, {
      offset: 0,
      limit: 50,
      strategy: 'GET link:comments',
      headers: { 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId) },
    });
    const page = await http('GET', link1, { headers, expect: 200 });
    log('debug', `comments[note:${noteId}] page response`, {
      status: 200,
      offset: 0,
      strategy: 'GET link:comments',
    });
    log('debug', `comments[note:${noteId}]-page(GET link:comments) JSON preview`, jsonPreview(page));
    const out = page?.items || [];
    log('debug', `comments[note:${noteId}] page parsed`, {
      itemsReceived: out.length,
      totalAccumulated: out.length,
      hasMore: false,
      strategy: 'GET link:comments',
    });
    return out;
  } catch (e) {
    log('debug', `comments[note:${noteId}] page response`, {
      status: e?.status || 'ERR',
      offset: 0,
      strategy: 'GET link:comments',
    });
    log('debug', `comments[note:${noteId}]-page(GET link:comments) error body`, {
      snippet: e?.snippet || '',
    });
    log('debug', 'comments explicit link failed', {
      url: `/notes/${noteId}/comments`,
      abs: link1,
      error: `/notes/${noteId}/comments GET error: ${e?.status || 'ERR'}`,
    });
  }
  // 2) Fallback to v2 route
  log('debug', `GET ${link2} (comments[note:${noteId}])`, {
    offset: 0,
    limit: 50,
    strategy: 'GET /notes/{id}/comments',
    headers: { 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId) },
  });
  const page2 = await http('GET', link2, { headers, expect: 200 });
  log('debug', `comments[note:${noteId}] page response`, {
    status: 200,
    offset: 0,
    strategy: 'GET /notes/{id}/comments',
  });
  log('debug', `comments[note:${noteId}]-page(GET /notes/{id}/comments) JSON preview`, jsonPreview(page2));
  const out2 = page2?.items || [];
  log('debug', `comments[note:${noteId}] page parsed`, {
    itemsReceived: out2.length,
    totalAccumulated: out2.length,
    hasMore: false,
    strategy: 'GET /notes/{id}/comments',
  });
  // IMPORTANT: Do NOT mark as failure if 0 items; that means "no comments".
  return out2;
}

function createLimiter(concurrency = 6) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => resolve(v))
      .catch((e) => reject(e))
      .finally(() => {
        active--;
        next();
      });
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

const userCache = new Map();
async function resolveUser(token, userId, orgId, id) {
  if (!id) return null;
  const key = String(id);
  if (userCache.has(key)) return userCache.get(key);
  const url = `${CONFIG.apiBase}${CONFIG.v2Base}/users/${id}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-fv-userid': String(userId),
    'x-fv-orgid': String(orgId),
  };
  try {
    const body = await http('GET', url, { headers, expect: 200 });
    const name =
      body?.displayName ||
      [body?.firstName, body?.lastName].filter(Boolean).join(' ') ||
      body?.username ||
      String(id);
    userCache.set(key, name);
    return name;
  } catch {
    userCache.set(key, String(id));
    return String(id);
  }
}

/* -------------------------- Transformation / Merge ------------------------ */

function extractNoteCore(n) {
  const text =
    n?.text?.text ??
    n?.text ??
    n?.body?.text ??
    n?.body ??
    n?.content?.text ??
    n?.content ??
    '';
  // Timestamps: prefer createdDate, fallback updated/posted
  const when =
    toDate(n?.createdDate) ||
    toDate(n?.createDate) ||
    toDate(n?.postDate) ||
    toDate(n?.dateCreated) ||
    toDate(n?.date);
  const createdById = n?.createdById?.native ?? n?.createdById ?? n?.createdBy?.id?.native;
  return {
    id: String(n?.id?.native ?? n?.id ?? ''),
    kind: 'Note',
    text: normText(text),
    when,
    createdById,
  };
}
function extractEmailCore(e) {
  const subject = e?.subject ?? '';
  const body =
    e?.body?.html ||
    e?.body?.text ||
    e?.body ||
    e?.message?.body?.text ||
    e?.message?.body ||
    '';
  const when =
    toDate(e?.sentDate) ||
    toDate(e?.date) ||
    toDate(e?.createdDate) ||
    toDate(e?.receivedDate);
  const from =
    e?.from?.displayName ||
    e?.from?.name ||
    e?.from?.email ||
    e?.sender?.email ||
    e?.sender ||
    '';
  const to = ensureArray(e?.to)
    .map((x) => x?.email || x?.displayName || x?.name || x)
    .filter(Boolean);
  const cc = ensureArray(e?.cc)
    .map((x) => x?.email || x?.displayName || x?.name || x)
    .filter(Boolean);
  return {
    id: String(e?.id?.native ?? e?.id ?? ''),
    kind: 'Email',
    subject: normText(subject),
    body: normText(body),
    when,
    from: normText(from),
    to: to.map(normText),
    cc: cc.map(normText),
  };
}

// Build a cross-type fingerprint to collapse Note<->Email duplicates present in Filevine.
function buildFingerprint(item) {
  if (item.kind === 'Email') {
    const dt = Math.floor((item.when?.getTime?.() ?? 0) / (60 * 1000)); // minute
    const norm = [
      'email',
      stable(item.subject),
      stable(item.from),
      stable(item.to?.join(',')),
      stable(item.cc?.join(',')),
      stable(item.body).slice(0, 4000),
      dt,
    ].join('|');
    return hashFingerprint(norm);
  }
  // Note — try to detect emails saved as notes (subject line + email body)
  const firstLine = stable(item.text.split('\n')[0] || '');
  const bodyFrag = stable(item.text).slice(0, 4000);
  const dt = Math.floor((item.when?.getTime?.() ?? 0) / (60 * 1000));
  const norm = ['note', firstLine, bodyFrag, dt].join('|');
  return hashFingerprint(norm);
}

function dedupe(items) {
  const out = [];
  const seen = new Map();
  for (const it of items) {
    const fp = buildFingerprint(it);
    // If a duplicate exists, prefer Email over Note (emails typically have more header context).
    if (seen.has(fp)) {
      const idx = seen.get(fp);
      const existing = out[idx];
      if (existing && existing.kind === 'Note' && it.kind === 'Email') {
        out[idx] = it;
      }
      continue;
    }
    seen.set(fp, out.length);
    out.push(it);
  }
  return out;
}

/* ---------------------------------- PDF ----------------------------------- */

function renderTextWithLinks(doc, text, opts = {}) {
  // Detect http(s):// or mailto: sequences, link them, but keep wrapping sane.
  const parts = String(text).split(
    /((?:https?:\/\/|mailto:)[^\s<>()\[\]{}"]+[^\s<>()\[\]{}"'.;,!?])/gi
  );
  parts.forEach((part, i) => {
    if (!part) return;
    const isLink = i % 2 === 1;
    if (isLink) {
      doc.fillColor('black').text(part, { link: part, underline: false, ...opts });
    } else {
      doc.fillColor('black').text(part, { continued: false, ...opts });
    }
  });
}

function writeHeadingLine(doc, type, when, rightText = '') {
  doc.moveDown(0.5);
  doc
    .fontSize(CONFIG.h2FontSize)
    .font('Helvetica-Bold')
    .fillColor('black')
    .text(`${type} • ${fmtDate(when)}` + (rightText ? `   ${rightText}` : ''));
  doc.moveDown(0.25);
}

function writeKeyVal(doc, key, val) {
  if (!val) return;
  doc.font('Helvetica-Bold').text(`${key}: `, { continued: true });
  doc.font('Helvetica').text(val);
}

function maybeTruncate(s) {
  if (!CONFIG.softLimitBodyChars || !s) return s;
  if (s.length <= CONFIG.softLimitBodyChars) return s;
  return s.slice(0, CONFIG.softLimitBodyChars) + ' …[truncated]';
}

async function renderPdf(projectId, items, outPath, generatedAt) {
  const doc = new PDFDocument({
    size: CONFIG.pageSize,
    margins: { top: CONFIG.margin, left: CONFIG.margin, right: CONFIG.margin, bottom: CONFIG.margin },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Project ${projectId} — Notes & Emails`,
      Author: 'Filevine Export',
    },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Title
  doc.font('Helvetica-Bold').fontSize(CONFIG.titleFontSize).text(`Project ${projectId} — Notes & Emails`);
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(CONFIG.pdfFontSize).text(`Generated: ${fmtDate(generatedAt)}`);
  doc.moveDown(0.75);

  // Body
  for (const it of items) {
    if (it.kind === 'Email') {
      writeHeadingLine(doc, 'Email', it.when, it.subject ? `\n` : '');
      if (it.subject) {
        doc.font('Helvetica-Bold').text(it.subject);
      }
      if (it.from || (it.to?.length || 0) || (it.cc?.length || 0)) {
        writeKeyVal(doc, 'From', it.from);
        writeKeyVal(doc, 'To', it.to?.join(', '));
        writeKeyVal(doc, 'Cc', it.cc?.join(', '));
      }
      doc.moveDown(0.25);
      const body = maybeTruncate(it.body);
      if (body) renderTextWithLinks(doc, body);
    } else {
      // Note
      writeHeadingLine(doc, 'Note', it.when, it.createdByName ? `\n` : '');
      if (it.createdByName) writeKeyVal(doc, 'Author', it.createdByName);
      const body = maybeTruncate(it.text);
      if (body) renderTextWithLinks(doc, body);
      if ((it.comments?.length || 0) > 0) {
        doc.moveDown(0.15);
        doc.font('Helvetica-Bold').text(`Comments (${it.comments.length}):`);
        doc.moveDown(0.15);
        for (const c of it.comments) {
          const line = `${fmtDate(toDate(c?.createdDate || c?.date || c?.timestamp))}\n${normText(
            c?.text?.text || c?.text || c?.body?.text || c?.body || ''
          )}`;
          renderTextWithLinks(doc, maybeTruncate(line));
          doc.moveDown(0.15);
        }
      }
    }
    doc.moveDown(0.6);
    // Add a soft rule
    const x = doc.x;
    const y = doc.y;
    doc
      .moveTo(x, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .strokeColor('#bbbbbb')
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.4);
  }

  doc.end();
  await new Promise((res, rej) => {
    stream.on('finish', res);
    stream.on('error', rej);
  });
}

/* --------------------------------- Main ----------------------------------- */

async function main() {
  const projectId = process.env.FILEVINE_PROJECT_ID || process.argv[2];
  if (!projectId) {
    console.error('Usage: node generate-notes-emails-pdf.mjs <projectId>');
    process.exit(1);
  }

  log('debug', 'Start', {
    utilsBase: `${CONFIG.apiBase}${CONFIG.v2Base}`,
    regionBase: `${CONFIG.apiBase}${CONFIG.v2Base}`,
    projectId: String(projectId),
  });

  const token = await getAccessToken();
  const { userId, orgId } = await getUserOrg(token);

  const headers = { 'x-fv-userid': String(userId), 'x-fv-orgid': String(orgId) };
  log('debug', 'Using gateway headers', headers);

  const { notes, emails } = await getProjectNotesAndEmails(token, userId, orgId, projectId);

  // Attach comments (with concurrency limit)
  log('debug', `Attaching comments to ${notes.length} notes`);
  const limit = createLimiter(10);
  const noteComments = await Promise.all(
    notes.map((n) =>
      limit(async () => {
        const id = String(n?.id?.native ?? n?.id ?? '');
        try {
          const comments = await getNoteComments(token, userId, orgId, id);
          return { id, comments, ok: true };
        } catch (e) {
          // Only log as failed if both strategies errored. Here, the catch should be rare.
          log('debug', `All comment strategies failed for note`, { noteId: id, error: String(e?.message || e) });
          return { id, comments: [], ok: false };
        }
      })
    )
  );
  const commentMap = new Map(noteComments.map((r) => [r.id, r.comments || []]));

  // Transform items
  const transformedNotes = await Promise.all(
    notes.map(async (n) => {
      const base = extractNoteCore(n);
      const createdByName = await resolveUser(token, userId, orgId, base.createdById);
      return {
        ...base,
        createdByName,
        comments: commentMap.get(base.id) || [],
      };
    })
  );

  const transformedEmails = emails.map(extractEmailCore);

  // Merge + de-dup + sort
  const allItems = dedupe([...transformedNotes, ...transformedEmails]).sort(byChronAsc);

  // Render PDF
  const datePart = new Date().toISOString().slice(0, 10);
  const outName = `project-${projectId}-notes-emails-${datePart}.pdf`;
  const outPath = path.join(CONFIG.outputDir, outName);
  await renderPdf(projectId, allItems, outPath, new Date());

  log('debug', 'Export complete', { outPath });
  console.log(`\n✅ Wrote: ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
