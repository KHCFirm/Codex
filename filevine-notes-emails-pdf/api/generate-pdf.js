// generate-pdf.js
// ESM module. Node 18+ (global fetch) and pdfkit required.
// Usage examples:
//   node generate-pdf.js --project 991042371
//   node generate-pdf.js -p 991042371 -o ./out.pdf
//   FILEVINE_PROJECT_ID=991042371 node generate-pdf.js
//
// Env:
//   FILEVINE_ACCESS_TOKEN  (optional; if set, skips token exchange)
//   FILEVINE_CLIENT_ID     (required if no FILEVINE_ACCESS_TOKEN)
//   FILEVINE_CLIENT_SECRET (required if no FILEVINE_ACCESS_TOKEN)
//   FILEVINE_PROJECT_ID    (optional; fallback project id)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";

const IDENTITY_BASE = "https://identity.filevine.com";
const API_BASE = "https://api.filevineapp.com/fv-app/v2";
const UTILS_BASE = API_BASE; // matches your logs

// ----------------------------- arg parsing (robust) -----------------------------
function parseArgs(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // --key=value
    if (/^--[^=]+=.*/.test(a)) {
      const [k, v] = a.split("=", 2);
      map.set(k, v);
      continue;
    }

    // --key value | --flag
    if (a.startsWith("--")) {
      const k = a;
      const v = i + 1 < argv.length && !argv[i + 1].startsWith("-") ? argv[++i] : true;
      map.set(k, v);
      continue;
    }

    // -kvalue | -k value | -k
    if (a.startsWith("-") && a !== "-") {
      if (a.length > 2) {
        // -k123
        const k = a.slice(0, 2);
        const v = a.slice(2);
        map.set(k, v || true);
      } else {
        // -k value | -k
        const k = a;
        const v = i + 1 < argv.length && !argv[i + 1].startsWith("-") ? argv[++i] : true;
        map.set(k, v);
      }
      continue;
    }

    // bare token (treat as flag=true)
    map.set(a, true);
  }
  return map;
}

const args = parseArgs(process.argv.slice(2));
const EXPLICIT_OUT = args.get("--out") || args.get("-o") || null;

// We'll compute PROJECT_ID first (supports env + inference) then OUT_PATH default
function inferProjectIdFromPath(p) {
  if (!p) return null;
  const m = String(p).match(/project-(\d+)/i);
  return m ? m[1] : null;
}
const PROJECT_ID =
  args.get("--project") ||
  args.get("-p") ||
  process.env.FILEVINE_PROJECT_ID ||
  process.env.FV_PROJECT_ID ||
  process.env.PROJECT_ID ||
  inferProjectIdFromPath(EXPLICIT_OUT) ||
  null;

const OUT_PATH =
  EXPLICIT_OUT ||
  `./project-${PROJECT_ID ? String(PROJECT_ID) : "export"}-notes-emails.pdf`;

if (!PROJECT_ID) {
  console.error(
    "Missing required project id.\n" +
      "Provide with --project <id> (or -p <id>), or set FILEVINE_PROJECT_ID.\n" +
      "Examples:\n" +
      "  node generate-pdf.js --project 991042371\n" +
      "  FILEVINE_PROJECT_ID=991042371 node generate-pdf.js"
  );
  process.exit(1);
}

// ----------------------------- utils -----------------------------
function debug(...m) {
  if (args.has("--debug")) console.log(...m);
}

function withAuthHeaders(headers = {}, auth) {
  return {
    ...headers,
    Authorization: `Bearer ${auth.accessToken}`,
    ...(auth.userId ? { "x-fv-userid": String(auth.userId) } : {}),
    ...(auth.orgId ? { "x-fv-orgid": String(auth.orgId) } : {}),
    "content-type": headers["content-type"] || "application/json",
  };
}

async function getJson(url, options = {}, label = "") {
  const res = await fetch(url, options);
  const bodyText = await res.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // leave as null; we'll still report error below if !ok
  }
  debug(`[http] ${label || options.method || "GET"} ${url} -> ${res.status}`);
  if (!res.ok) {
    const err = new Error(`${label || "request"} failed: ${res.status}`);
    err.extra = { status: res.status, bodySnippet: (bodyText || "").slice(0, 500) };
    throw err;
  }
  return json;
}

function safeURL(possiblyRelative, base = API_BASE) {
  try {
    return new URL(possiblyRelative, base).href;
  } catch {
    return null;
  }
}

function isNonEmptyArray(x) {
  return Array.isArray(x) && x.length > 0;
}

// ----------------------------- auth -----------------------------
async function getAccessToken() {
  const direct = process.env.FILEVINE_ACCESS_TOKEN;
  if (direct) return { accessToken: direct, tokenType: "Bearer" };

  const clientId = process.env.FILEVINE_CLIENT_ID;
  const clientSecret = process.env.FILEVINE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "Set FILEVINE_ACCESS_TOKEN or FILEVINE_CLIENT_ID / FILEVINE_CLIENT_SECRET to authenticate."
    );
    process.exit(1);
  }

  const url = `${IDENTITY_BASE}/connect/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "email filevine.v2.api.* fv.api.gateway.access fv.auth.tenant.read openid tenant",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("Token exchange failed:", json);
    process.exit(1);
  }
  return { accessToken: json.access_token, tokenType: json.token_type || "Bearer" };
}

async function getUserOrg(auth) {
  const url = `${UTILS_BASE}/utils/GetUserOrgsWithToken`;
  const json = await getJson(
    url,
    { method: "POST", headers: withAuthHeaders({}, auth), body: "{}" },
    "POST utils/GetUserOrgsWithToken"
  );

  const userId = json?.user?.id || json?.userId || json?.user?.userId || null;
  const orgId =
    json?.orgs?.find?.((o) => o.isDefault)?.id ||
    json?.orgs?.[0]?.id ||
    json?.orgId ||
    null;

  if (!userId || !orgId) {
    debug("GetUserOrgsWithToken raw:", JSON.stringify(json).slice(0, 500));
    throw new Error("Could not resolve userId/orgId");
  }
  return { userId, orgId };
}

// ----------------------------- pagination helpers -----------------------------
async function getPaged(url, auth, label = "", limit = 50) {
  let offset = 0;
  let hasMore = true;
  const items = [];
  while (hasMore) {
    const u = new URL(url);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("offset", String(offset));
    const json = await getJson(u.href, { headers: withAuthHeaders({}, auth) }, `${label} (offset ${offset})`);
    const chunk = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
    items.push(...chunk);
    hasMore = Boolean(json?.hasMore) && chunk.length > 0;
    offset += limit;
    if (!json || chunk.length === 0) break;
  }
  return items;
}

// ----------------------------- API: core fetches -----------------------------
async function getProjectNotes(projectId, auth) {
  const url = `${API_BASE}/projects/${projectId}/notes`;
  return getPaged(url, auth, `GET notes for project ${projectId}`);
}

async function getProjectEmails(projectId, auth) {
  const url = `${API_BASE}/projects/${projectId}/emails`;
  return getPaged(url, auth, `GET emails for project ${projectId}`);
}

// Best-effort single note detail (some deployments expose extra fields like embedded comments)
async function getNoteDetail(projectId, noteId, auth) {
  const url = `${API_BASE}/projects/${projectId}/notes/${noteId}`;
  try {
    return await getJson(url, { headers: withAuthHeaders({}, auth) }, "GET note detail");
  } catch (e) {
    if (e?.extra?.status !== 404) debug("note detail error:", e.message);
    return null;
  }
}

// ----------------------------- comments retrieval -----------------------------
function looksLikeComment(obj) {
  if (!obj || typeof obj !== "object") return false;
  const hasText = "text" in obj || "body" in obj || "content" in obj;
  const hasAuthish = "createdBy" in obj || "createdById" in obj || "author" in obj || "authorId" in obj;
  return hasText || hasAuthish;
}

function extractCommentsFromObject(noteLike) {
  if (!noteLike || typeof noteLike !== "object") return [];
  // Common direct fields
  const directFields = ["comments", "replies", "thread", "commentThread", "discussion", "children"];
  for (const key of directFields) {
    const v = noteLike[key];
    if (Array.isArray(v) && v.some(looksLikeComment)) return v;
    if (v && typeof v === "object") {
      // nested holder like { items: [...] }
      const items = v.items || v.data || v.children;
      if (Array.isArray(items) && items.some(looksLikeComment)) return items;
    }
  }
  // heuristic deep scan (depth 2)
  const queue = [noteLike];
  let depth = 0;
  while (queue.length && depth < 2) {
    const levelCount = queue.length;
    for (let i = 0; i < levelCount; i++) {
      const cur = queue.shift();
      if (!cur || typeof cur !== "object") continue;
      for (const [k, v] of Object.entries(cur)) {
        if (Array.isArray(v) && v.some(looksLikeComment)) return v;
        if (v && typeof v === "object") queue.push(v);
      }
    }
    depth++;
  }
  return [];
}

async function getNoteComments(note, projectId, auth) {
  // 1) Try API-provided link (often relative like "/notes/:id/comments")
  const link = note?.links?.comments || note?.links?.Comments || null;
  const tryUrls = [];
  if (link) {
    const abs = safeURL(link, API_BASE);
    if (abs) tryUrls.push(abs);
  }

  // 2) Known root-scoped fallback
  if (note?.id) tryUrls.push(`${API_BASE}/notes/${note.id}/comments?limit=50&offset=0`);

  // 3) Generic comments listing by parent
  if (note?.id) tryUrls.push(`${API_BASE}/comments?limit=50&offset=0&parentType=note&parentId=${note.id}`);

  for (const u of tryUrls) {
    try {
      const json = await getJson(u, { headers: withAuthHeaders({}, auth) }, "GET note comments");
      const arr = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
      if (isNonEmptyArray(arr)) return arr;
    } catch (e) {
      if (e?.extra?.status !== 404) debug("comment fetch err:", e.message);
    }
  }

  // 4) As a final fallback, fetch the single-note detail and try to extract embedded comments.
  const detail = await getNoteDetail(projectId, note?.id, auth);
  const embedded = extractCommentsFromObject(detail) || extractCommentsFromObject(note);
  return embedded || [];
}

// ----------------------------- user resolution -----------------------------
const userCache = new Map(); // id -> display name

function pickNameLike(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.fullName ||
    obj.displayName ||
    obj.name ||
    (obj.firstName && obj.lastName ? `${obj.firstName} ${obj.lastName}` : null) ||
    obj.email ||
    null
  );
}

async function resolveUserName(userLike, auth) {
  const fromObj = pickNameLike(userLike);
  if (fromObj) return fromObj;

  const userId =
    (typeof userLike === "number" && userLike) ||
    (typeof userLike === "string" && userLike) ||
    userLike?.id ||
    userLike?.userId ||
    null;

  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);

  try {
    const url = `${API_BASE}/users/${userId}`;
    const json = await getJson(url, { headers: withAuthHeaders({}, auth) }, "GET user");
    const name = pickNameLike(json) || pickNameLike(json?.user) || json?.email || `User ${userId}`;
    userCache.set(userId, name);
    return name;
  } catch {
    return `User ${userId}`;
  }
}

async function authorForNote(note, auth) {
  const direct =
    pickNameLike(note?.createdBy) ||
    pickNameLike(note?.createdByUser) ||
    pickNameLike(note?.user) ||
    null;
  if (direct) return direct;

  const idLike = note?.createdById || note?.userId || note?.authorId || null;
  const name = await resolveUserName(idLike, auth);
  return name || "Unknown";
}

function emailFromTo(email) {
  const from = email?.from || email?.headers?.from || email?.sender || {};
  const to = email?.to || email?.recipients || email?.headers?.to || [];

  function norm(mb) {
    if (!mb) return null;
    if (typeof mb === "string") return mb;
    const name = mb.name || mb.displayName || "";
    const addr = mb.address || mb.email || "";
    if (name && addr) return `${name} <${addr}>`;
    return name || addr || null;
  }

  const fromText = norm(from);
  const toList = Array.isArray(to) ? to.map(norm).filter(Boolean) : [norm(to)].filter(Boolean);
  return { from: fromText || "Unknown", to: toList.join(", ") || "Unknown" };
}

// ----------------------------- PDF helpers -----------------------------
function createDocStream(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(filePath);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 50 });
  doc.pipe(stream);
  return { doc, stream };
}

function addHeader(doc, text) {
  doc.fontSize(16).text(text, { align: "left" });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor("black").stroke();
  doc.moveDown(0.6);
}

function addSectionTitle(doc, text) {
  doc.fontSize(14).text(text, { align: "left" });
  doc.moveDown(0.4);
}

function addMetaLine(doc, label, value) {
  if (!value) return;
  doc.fontSize(9).fillColor("gray").text(`${label}: ${value}`);
  doc.fillColor("black");
}

function addBody(doc, text) {
  if (!text) return;
  doc.fontSize(11).fillColor("black").text(String(text), { align: "left" });
}

function addComment(doc, comment, authorName, createdDate) {
  const when = createdDate ? new Date(createdDate) : null;
  const whenStr = when ? when.toLocaleString() : "";
  doc.fontSize(10).fillColor("gray").text(`— ${authorName || "Unknown"}${whenStr ? ` • ${whenStr}` : ""}`);
  doc.fillColor("black");
  const body = comment?.text ?? comment?.body ?? comment?.content ?? "";
  if (body) {
    doc.fontSize(11).text(String(body), { indent: 14 });
  }
  doc.moveDown(0.3);
}

function ensurePage(doc) {
  if (!doc.page) doc.addPage();
}

// ----------------------------- main -----------------------------
async function main() {
  console.log(`[info] Start { api: ${API_BASE}, projectId: ${PROJECT_ID} }`);

  // Auth
  const token = await getAccessToken();
  console.log("[info] Token acquired");

  // Gateway headers
  const ids = await getUserOrg(token);
  console.log("[info] Using gateway headers", { userId: ids.userId, orgId: ids.orgId });
  const auth = { accessToken: token.accessToken, userId: ids.userId, orgId: ids.orgId };

  // Fetch notes & emails
  const [notes, emails] = await Promise.all([
    getProjectNotes(PROJECT_ID, auth),
    getProjectEmails(PROJECT_ID, auth),
  ]);
  console.log("[info] Fetch complete", { notesCount: notes.length, emailsCount: emails.length });

  // Fetch comments for notes (concurrency limited)
  console.log(`[info] Attaching comments to ${notes.length} notes`);
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < notes.length) {
      const i = cursor++;
      const n = notes[i];
      try {
        n._comments = await getNoteComments(n, PROJECT_ID, auth);
      } catch (e) {
        debug("comments error for note", n?.id, e?.message, e?.extra);
        n._comments = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, notes.length || 1) }, worker));

  // Build PDF
  const { doc, stream } = createDocStream(OUT_PATH);

  // Cover
  doc.addPage();
  addHeader(doc, `Project ${PROJECT_ID} • Notes & Emails`);
  addMetaLine(doc, "Generated", new Date().toLocaleString());
  doc.moveDown(1);

  // Notes
  ensurePage(doc);
  addSectionTitle(doc, `Notes (${notes.length})`);
  for (const note of notes) {
    const created = new Date(
      note?.createdDate || note?.dateCreated || note?.created || note?.date || Date.now()
    );
    const author = await authorForNote(note, auth);

    doc.fontSize(12).fillColor("black").text(`Note • ${created.toLocaleString()} • by ${author}`);
    if (note?.title) addMetaLine(doc, "Title", note.title);
    doc.moveDown(0.2);
    addBody(doc, note?.text || note?.body || note?.content || "");

    // Comments
    const comments = Array.isArray(note?._comments) ? note._comments : [];
    if (comments.length > 0) {
      doc.moveDown(0.2);
      doc.fontSize(11).fillColor("black").text("Comments:", { underline: true });
      doc.moveDown(0.1);
      for (const c of comments) {
        const cAuthor =
          pickNameLike(c?.createdBy) ||
          pickNameLike(c?.author) ||
          (await resolveUserName(c?.createdById || c?.authorId, auth)) ||
          "Unknown";
        const cWhen = c?.createdDate || c?.dateCreated || c?.created || c?.date;
        addComment(doc, c, cAuthor, cWhen);
      }
    }

    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 100) doc.addPage();
  }

  // Emails
  ensurePage(doc);
  addSectionTitle(doc, `Emails (${emails.length})`);
  for (const email of emails) {
    const when = new Date(
      email?.sentDate || email?.dateSent || email?.createdDate || email?.dateCreated || email?.date || Date.now()
    );
    const { from, to } = emailFromTo(email);

    doc.fontSize(12).fillColor("black").text(`Email • ${when.toLocaleString()}`);
    addMetaLine(doc, "From", from);
    addMetaLine(doc, "To", to);
    if (email?.subject) addMetaLine(doc, "Subject", email.subject);
    doc.moveDown(0.2);

    addBody(doc, email?.text || email?.body || email?.content || email?.html || "");
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 100) doc.addPage();
  }

  doc.end();
  await new Promise((res, rej) => {
    stream.on("finish", res);
    stream.on("error", rej);
  });

  console.log("[info] PDF written:", path.resolve(OUT_PATH));
}

main().catch((err) => {
  console.error("[error]", err?.message || err);
  if (err?.extra) console.error("[error-extra]", err.extra);
  process.exit(1);
});
