import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";

const IDENTITY_BASE = "https://identity.filevine.com";
const API_BASE = "https://api.filevineapp.com/fv-app/v2";
const UTILS_BASE = `${API_BASE}`; // same base per your logs

// ----------------------------- CLI args -----------------------------
const args = new Map(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) return [[`--${m[1]}`, m[2]]];
    return [[a, true]];
  })
);
const PROJECT_ID = args.get("--project") || args.get("-p");
const OUT_PATH = args.get("--out") || args.get("-o") || `./project-${PROJECT_ID || "export"}-notes-emails.pdf`;
if (!PROJECT_ID) {
  console.error("Missing required --project <id> argument.");
  process.exit(1);
}

// ----------------------------- HTTP helpers -----------------------------
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
  const txt = await res.text();
  let json;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = null;
  }
  debug(`[http] ${label || options.method || "GET"} ${url} -> ${res.status}`);
  if (!res.ok) {
    const snippet = txt?.slice(0, 500) || "";
    const err = new Error(`${label || "request"} failed: ${res.status}`);
    err.extra = { status: res.status, bodySnippet: snippet };
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

// ----------------------------- Auth -----------------------------
async function getAccessToken() {
  const directToken = process.env.FILEVINE_ACCESS_TOKEN;
  if (directToken) {
    return { accessToken: directToken, tokenType: "Bearer" };
  }

  const clientId = process.env.FILEVINE_CLIENT_ID;
  const clientSecret = process.env.FILEVINE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set FILEVINE_ACCESS_TOKEN or FILEVINE_CLIENT_ID / FILEVINE_CLIENT_SECRET.");
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

  // Try to find a default org or just take the first
  const userId = json?.user?.id || json?.userId || json?.user?.userId || null;
  let orgId =
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

// ----------------------------- API: pagination -----------------------------
async function getPaged(url, auth, label = "", limit = 50) {
  let offset = 0;
  let hasMore = true;
  const items = [];
  while (hasMore) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", String(limit));
    pageUrl.searchParams.set("offset", String(offset));
    const json = await getJson(
      pageUrl.href,
      { headers: withAuthHeaders({}, auth) },
      `${label} (offset ${offset})`
    );
    const chunk = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
    items.push(...chunk);
    hasMore = Boolean(json?.hasMore) && chunk.length > 0;
    offset += limit;
    if (!json || chunk.length === 0) break;
  }
  return items;
}

// ----------------------------- API: project data -----------------------------
async function getProjectNotes(projectId, auth) {
  const url = `${API_BASE}/projects/${projectId}/notes`;
  return getPaged(url, auth, `GET notes for project ${projectId}`);
}

async function getProjectEmails(projectId, auth) {
  const url = `${API_BASE}/projects/${projectId}/emails`;
  return getPaged(url, auth, `GET emails for project ${projectId}`);
}

// ----------------------------- API: comments for a note -----------------------------
async function getNoteComments(note, auth) {
  // 1) Prefer the API-provided link
  const linkFromNote = note?.links?.comments || note?.links?.Comments || null;
  const resolved = linkFromNote ? safeURL(linkFromNote, API_BASE) : null;

  // a) First attempt: use link as-is (absolute or resolved)
  const tryUrls = [];
  if (resolved) tryUrls.push(resolved);

  // b) Known-good root-scoped fallback
  if (note?.id) tryUrls.push(`${API_BASE}/notes/${note.id}/comments?limit=50&offset=0`);

  // c) Generic comments listing by parent
  if (note?.id) tryUrls.push(`${API_BASE}/comments?limit=50&offset=0&parentType=note&parentId=${note.id}`);

  for (const u of tryUrls) {
    try {
      const json = await getJson(u, { headers: withAuthHeaders({}, auth) }, "GET note comments");
      const arr = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
      return arr;
    } catch (err) {
      if (err?.extra?.status !== 404) {
        debug("Comment fetch non-404 error:", err?.message, err?.extra);
      }
      // on 404, try next
    }
  }
  return []; // no comments or all strategies failed
}

// ----------------------------- API: user lookup & cache -----------------------------
const userCache = new Map(); // id -> displayName

function pickNameLike(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.fullName ||
    obj.displayName ||
    obj.name ||
    (obj.firstName && obj.lastName ? `${obj.firstName} ${obj.lastName}` : null) ||
    null
  );
}

async function resolveUserName(userLike, auth) {
  // if object with name fields
  const fromObj = pickNameLike(userLike);
  if (fromObj) return fromObj;

  // if direct ID
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
  // Try common shapes
  const direct =
    pickNameLike(note?.createdBy) ||
    pickNameLike(note?.createdByUser) ||
    pickNameLike(note?.user) ||
    null;
  if (direct) return direct;

  // Try IDs
  const idLike = note?.createdById || note?.userId || note?.authorId || null;
  const name = await resolveUserName(idLike, auth);
  return name || "Unknown";
}

function emailFromTo(email) {
  // Try best-effort extraction from typical Filevine email shapes
  const from = email?.from || email?.headers?.from || email?.sender || {};
  const to = email?.to || email?.recipients || email?.headers?.to || [];

  function normalizeMailbox(mb) {
    if (!mb) return null;
    if (typeof mb === "string") return mb;
    const name = mb.name || mb.displayName || "";
    const addr = mb.address || mb.email || "";
    if (name && addr) return `${name} <${addr}>`;
    return name || addr || null;
  }

  const fromText = normalizeMailbox(from);
  const toList = Array.isArray(to) ? to.map(normalizeMailbox).filter(Boolean) : [normalizeMailbox(to)].filter(Boolean);
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
  doc.fontSize(11).text(String(text), { align: "left" });
}

function addComment(doc, comment, authorName, createdDate) {
  const when = createdDate ? new Date(createdDate) : null;
  const whenStr = when ? when.toLocaleString() : "";
  doc.fontSize(10).fillColor("gray").text(`— ${authorName || "Unknown"}${whenStr ? ` • ${whenStr}` : ""}`);
  doc.fillColor("black");
  if (comment?.text || comment?.body) {
    doc.fontSize(11).text(comment.text || comment.body, { indent: 14 });
  }
  doc.moveDown(0.3);
}

function ensurePage(doc) {
  if (doc.page == null) doc.addPage();
}

// ----------------------------- Main -----------------------------
async function main() {
  console.log(`[info] Start { API: ${API_BASE}, projectId: ${PROJECT_ID} }`);

  // Auth
  const token = await getAccessToken();
  console.log("[info] Token acquired");

  // Get gateway headers (user/org IDs)
  const ids = await getUserOrg(token);
  console.log("[info] Using gateway headers", { userId: ids.userId, orgId: ids.orgId });

  const auth = { accessToken: token.accessToken, userId: ids.userId, orgId: ids.orgId };

  // Fetch notes + emails
  const [notes, emails] = await Promise.all([getProjectNotes(PROJECT_ID, auth), getProjectEmails(PROJECT_ID, auth)]);
  console.log("[info] Fetch complete", { notesCount: notes.length, emailsCount: emails.length });

  // Fetch comments for each note (in parallel but throttled)
  console.log(`[info] Attaching comments to ${notes.length} notes`);
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < notes.length) {
      const i = idx++;
      const note = notes[i];
      try {
        const comments = await getNoteComments(note, auth);
        note._comments = comments;
      } catch (e) {
        debug("Comments fetch failed for note", note?.id, e?.message);
        note._comments = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, notes.length || 1) }, worker));

  // Generate PDF
  const { doc, stream } = createDocStream(OUT_PATH);

  // Cover
  doc.addPage();
  addHeader(doc, `Project ${PROJECT_ID} • Notes & Emails`);
  addMetaLine(doc, "Generated", new Date().toLocaleString());
  doc.moveDown(1);

  // Notes section
  ensurePage(doc);
  addSectionTitle(doc, `Notes (${notes.length})`);
  for (const note of notes) {
    const created = new Date(note?.createdDate || note?.dateCreated || note?.created || note?.date || Date.now());
    const author = await authorForNote(note, auth);

    doc.fontSize(12).text(`Note • ${created.toLocaleString()} • by ${author}`);
    if (note?.title) addMetaLine(doc, "Title", note.title);
    doc.moveDown(0.2);
    addBody(doc, note?.text || note?.body || note?.content || "");

    // Comments (if any)
    const comments = Array.isArray(note?._comments) ? note._comments : [];
    if (comments.length > 0) {
      doc.moveDown(0.2);
      doc.fontSize(11).text("Comments:", { underline: true });
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
    // Page break helper
    if (doc.y > doc.page.height - 100) doc.addPage();
  }

  // Emails section
  ensurePage(doc);
  addSectionTitle(doc, `Emails (${emails.length})`);
  for (const email of emails) {
    const when = new Date(
      email?.sentDate || email?.dateSent || email?.createdDate || email?.dateCreated || email?.date || Date.now()
    );
    const { from, to } = emailFromTo(email);

    doc.fontSize(12).text(`Email • ${when.toLocaleString()}`);
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
