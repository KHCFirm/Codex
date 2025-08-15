import PDFDocument from 'pdfkit';

/**
 * Env vars
 *  - FILEVINE_CLIENT_ID
 *  - FILEVINE_CLIENT_SECRET
 *  - FILEVINE_PAT_TOKEN
 *  - DEBUG (optional: "true" | "false"; default "true")
 *
 * API gateway (global): https://api.filevineapp.com/fv-app/v2
 * Notes/comments are not project-scoped in v2; use /notes/{noteId}/comments.
 */

const IDENTITY_URL = 'https://identity.filevine.com/connect/token';
const GATEWAY_UTILS_BASE  = 'https://api.filevineapp.com/fv-app/v2';
const GATEWAY_REGION_BASE = 'https://api.filevineapp.com/fv-app/v2';
const DEBUG = (process.env.DEBUG ?? 'true').toLowerCase() !== 'false';

const REQ = () => Math.random().toString(36).slice(2, 10);
const dlog = (...args) => { if (DEBUG) console.log('[debug]', ...args); };

/* ===========================
   STATIC USER ID → NAME MAP
   (derived from your sheet)
   =========================== */
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
  "990009272": "Dan Paris",
  "990009274": "Elizabeth Hernandez",
  "990009275": "Stephanie Grassia",
  "990009276": "Angela Santiago",
  "990009277": "Michael Jagolinzer",
  "990009278": "Tracy Grodnitzky",
  "990009279": "Aja Showell",
  "990009280": "Briana Toth",
  "990009281": "Kyle Biller",
  "990009282": "Jill Nuss",
  "990009283": "David Segal",
  "990009284": "Alexandra Sollee",
  "990009285": "Wesley Hunter",
  "990009286": "Lori Szeliga",
  "990009287": "Samantha Kobylarz",
  "990009288": "Lynda Thomas",
  "990009289": "Giovanna Marchese",
  "990009290": "Ariana Gonzales",
  "990009291": "Devin McNally",
  "990009292": "Marisa Shelkoff",
  "990009293": "Nicole Friedman",
  "990009294": "Matthew McDonald",
  "990009295": "Robert Miller",
  "990009296": "Alexandra Batte",
  "990009297": "Jasmine Serrano",
  "990009298": "Crystal Jones",
  "990009299": "John Peculic",
  "990009300": "Kathi Michalczyk",
  "990009301": "Jessica Dodd",
  "990009302": "Kris Scotten",
  "990009303": "Lucero Novoa",
  "990009304": "Maggie Algea",
  "990009305": "Michael D'Amelio",
  "990009306": "Nahir Vega",
  "990009307": "Neysi Ortiz",
  "990009308": "Rhianna Bavaro",
  "990009309": "Sabrina Padilla",
  "990009310": "Shawn Harris",
  "990009311": "Sierra Jones",
  "990009312": "Stephanie Belli",
  "990009313": "Vanessa Jimenez",
  "990009314": "Victoria Barreira",
  "990009315": "Yareli De La Cruz",
  "990009316": "Zoe Campos",
  "990009317": "Aline Perez",
  "990009318": "Gianna Piscopo",
  "990009319": "Madison Dwyer",
  "990009320": "Vicente Sarmiento",
  "990009321": "Brittney-Ann Jones",
  "990009322": "Eesha Moti",
  "990009323": "Federica Orsi",
  "990009324": "Hannah McGrath",
  "990009325": "Isabella Gonzalez",
  "990009326": "Janae Presley",
  "990009327": "Leidy Dominguez",
  "990009328": "Lindsay Valian",
  "990009329": "Luz-Estela Villa",
  "990009330": "Makaela Ascencio",
  "990009331": "Maria-Camila Cuervo",
  "990009332": "Mikayla King",
  "990009333": "Miranda Faller",
  "990009334": "Samantha Lucero",
  "990009335": "Seema Yadav",
  "990009336": "Stephanie Katz",
  "990009337": "Talia Karolak",
  "990009338": "Taylor McGrath",
  "990009339": "Teresa Pena",
  "990009340": "Victoria Correa",
  "990009341": "Yolanda Terry",
  "990009342": "Anthony Pegeron",
  "990009343": "Hannah Schwartz",
  "990009344": "Hannah Shuman",
  "990009345": "Jay Rehan",
  "990009346": "Kayla Mitchell",
  "990009347": "Megan Johnson",
  "990009348": "Nicole Foti",
  "990009349": "Ryan Matyas",
  "990009350": "Samantha Coleman",
  "990009351": "Austin Miller",
  "990009352": "Brianna Miller",
  "990009353": "Charles Bader",
  "990009354": "Christopher Toth",
  "990009355": "Colin Toth",
  "990009356": "Corrina McDonough",
  "990009357": "Daniel Cohen",
  "990009358": "Jake Rahn",
  "990009359": "Jason Rozenberg",
  "990009360": "Joshua Toth",
  "990009361": "Justin Scott",
  "990009362": "Kaitlyn Lutz",
  "990009363": "Katherine Marchese",
  "990009364": "Madeline Kolen",
  "990009365": "Michelle Paredes",
  "990009366": "Neethu Ittycheria",
  "990009367": "Nicholas Nudo",
  "990009368": "Shivani Malhotra",
  "990009369": "Simone Jones",
  "990009370": "Sofia Ochoa",
  "990009371": "Sophie Perez",
  "990009372": "Tara Grasso",
  "990009373": "Taylor Campo",
  "990009374": "Taylor Paglione",
  "990009375": "Zachary Goldman",
  "990009376": "Alexis Banet",
  "990009377": "Brianna Powers",
  "990009378": "Jenna Rosenthal",
  "990009379": "Katherine Decker",
  "990009380": "Michaela Gubin",
  "990009381": "Natasha Kadam",
  "990009382": "Noah Warhaftig",
  "990009383": "Paola Marin",
  "990009384": "Rachel Smith",
  "990009385": "Sara Chillemi",
  "990009386": "Shanel Wilson",
  "990009387": "Steven Liske",
  "990009388": "Yamileth Diaz",
  "990009389": "Yedidya Zecharia",
  "990009390": "Yoselin Castillo",
  "990009391": "Zoe Krinsky",
  "990009392": "Adam Vogel",
  "990009393": "Anthony Dell'Osa",
  "990009394": "Benjamin Gaines",
  "990009395": "Danna Beren",
  "990009396": "Derek Foti",
  "990009397": "Fabiana Silva",
  "990009398": "Gauri Madan",
  "990009399": "Jake Eustice",
  "990009400": "Lauren Ruggiero",
  "990009401": "Madison Pincus",
  "990009402": "Nishanth Khandavalli",
  "990009403": "Rachel Oelsner",
  "990009404": "Sasha Kirillova",
  "990009405": "Shubh Ratre",
  "990009406": "Sumit Sharma",
  "990009407": "Tara Shah",
  "990009408": "Yash Popat",
  "990009409": "Yash Shah",
  "990009410": "Ameira Rahimtoola",
  "990009411": "Gaurav Agrawal",
  "990009412": "Krishna Patel",
  "990009413": "Natalie Khrom",
  "990009414": "Nishkarsh Dewangan",
  "990009415": "Samiksha Thakare",
  "990009416": "Shrey Shah",
  "990009417": "Shreyash Agrawal",
  "990009418": "Ariella Hermann",
  "990009419": "Brynn Lancellotti",
  "990009420": "Carolina SR",
  "990009421": "Danielle Lanzilotta",
  "990009422": "Gabrielle Lovari",
  "990009423": "George Kosmos",
  "990009424": "Gianna Juras",
  "990009425": "Giovanna Herreros",
  "990009426": "Jenna McPartland",
  "990009427": "Jessica Dini",
  "990009428": "Jodi Miller",
  "990009429": "Kayla Ruggiero",
  "990009430": "Kirianna Alevras",
  "990009431": "Kyra Scheid",
  "990009432": "Lindsay D'Onofrio",
  "990009433": "Madeline Williamson",
  "990009434": "Madison Geller",
  "990009435": "Marissa Kelly",
  "990009436": "Maya Verma",
  "990009437": "Nicole R",
  "990009438": "Olivia Iton",
  "990009439": "Rabiya Khan",
  "990009440": "Rebecca Menkes",
  "990009441": "Samantha Carifio",
  "990009442": "Sanjana Desai",
  "990009443": "Sheva Cherekaev",
  "990009444": "Shreeya Gupta",
  "990009445": "Sneha Mandal",
  "990009446": "Toni-Ann D'Arrigo",
  "990009447": "Victoria M",
  "990009448": "Vimala M",
  "990009449": "Yasmeen Alam",
  "990009450": "Yasmin Shirazi",
  "990009451": "Zoe Dorfan",
  "990011544": "FV Administrator",
  "990012173": "Neki Users",
  "990012315": "Neki Users 2",
  "990012582": "Anand Sharma",
  "990012633": "Shruti Mishra",
  "990012635": "Jaskaran",
  "990013009": "Priyanka",
  "990013031": "Dilip Kumar",
  "990013079": "Shivam",
  "990013221": "Pratik",
  "990013261": "Puja",
  "990013292": "Lucasrezende",
  "990013558": "Susan Burleson",
  "990013624": "Jordan Crisp",
  "990014054": "Holly",
  "990014083": "Sandra",
  "990014108": "Daniela Ramirez",
  "990014169": "Kaitlyn L",
  "990014316": "Amber Duncan",
  "990014394": "Alexandra Tsa",
  "990014504": "Joni",
  "990014507": "Niaz Fatima",
  "990014640": "NZO",
  "990014734": "Courtney Cerce",
  "990014957": "Jagyeot",
  "990015151": "Mary Hanna",
  "990015199": "Shaik",
  "990015200": "Evan Albrecht",
  "990015252": "Adam Dheas",
  "990015360": "Jessica Targino",
  "990015553": "Brock",
  "990015683": "Test",
  "990015684": "User",
  "990015760": "Michael Kunk",
  "990016057": "Prasad",
  "990016077": "Ravi",
  "990016451": "Shradha",
  "990016720": "Pratik Khedekar",
  "990016784": "Rachel",
  "990016796": "Aarthi",
  "990016842": "Amar",
  "990017118": "Genezen AI",
  "990017194": "Chris Sutton",
  "990017204": "Sukriti",
  "990017219": "Konica",
  "990017381": "1776",
  "990017601": "Lakshmi",
  "990017729": "Rishi",
  "990017731": "Vikash",
  "990018037": "Defne Başak",
  "990018315": "Anushree",
  "990018351": "Dheeraj",
  "990018683": "nikita",
  "990019131": "Monika",
  "990019286": "Userrr",
  "990019571": "Ashok",
  "990019622": "Subashree",
  "990019666": "fatima",
  "990019680": "Munish",
  "990019825": "Sofia",
  "990019914": "Sajid",
  "990020223": "Jaskirat",
  "990020252": "Rachana",
  "990020349": "Abhijeet",
  "990020431": "Anita",
  "990020483": "Shoaib",
  "990020614": "User",
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

/* ======= helpers to use the map ======= */
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

    // 3c) Apply static ID→Name map to notes and comments (no extra API queries)
    applyNameMapToNotesAndComments(notesWithComments, reqId);
    applyNameMapToEmails(emails, reqId);

    // 4) Normalize + merge chronologically
    const merged = [
      ...notesWithComments.map((n, index) => {
        if (index === 0) debugDateFields([n], 'Note', reqId);
        // Prefer the mapped author; if not found, fall back to any inline author info
        const mappedAuthor = nameFromMap(authorIdFromNote(n));
        const inlineAuthor = extractNoteAuthor(n);
        return {
          type: 'Note',
          id: normalizeId(n?.id ?? n?.noteId),
          created: extractDate(n, 'note'),
          author: mappedAuthor || inlineAuthor || '',
          title: n?.title || n?.subject || '',
          body: n?.body || n?.text || n?.content || '',
          comments: Array.isArray(n?.comments) ? n.comments : []
        };
      }),
      ...emails.map((e, index) => {
        if (index === 0) debugDateFields([e], 'Email', reqId);
        const mappedAuthor = nameFromMap(
          e?.createdById ?? e?.createdByUserId ?? e?.userId ?? e?.authorId ?? e?.fromId
        );
        return {
          type: 'Email',
          id: normalizeId(e?.id ?? e?.emailId),
          created: extractDate(e, 'email'),
          author: mappedAuthor || extractAuthor(e),
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

/** Generic author extractor used for emails/comments (kept as fallback). */
function extractAuthor(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const nested = [obj.createdBy, obj.author, obj.user, obj.from, obj.sender];
  for (const cand of nested) {
    const name = pickName(cand);
    if (name) return name;
  }
  if (obj.createdBy?.name) return String(obj.createdBy.name);
  if (obj.author?.name)   return String(obj.author.name);
  if (obj.user?.name)     return String(obj.user.name);
  if (obj.from?.name)     return String(obj.from.name);
  if (obj.sender?.name)   return String(obj.sender.name);
  return '';
}

/** NOTE-SPECIFIC author extractor (fallback when map misses). */
function extractNoteAuthor(note) {
  const halCreatedBy =
    (note?._links?.createdBy && typeof note._links.createdBy === 'object' && note._links.createdBy.title) ||
    (note?.links?.createdBy && typeof note.links.createdBy === 'object' && note.links.createdBy.title);
  if (halCreatedBy && typeof halCreatedBy === 'string') return halCreatedBy;

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
  if (typeof v === 'object') {
    return v.native ?? v.id ?? v.userId ?? null;
  }
  return v;
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
  return data.access_token;
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
 * Pull "notes" or "emails" with multiple plausible routes.
 * Stops on first 2xx and paginates with that route.
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
    const id = authorIdFromComment(c);
    const mapped = nameFromMap(id);
    const authorName = mapped || extractAuthor(c);
    return ({
      id: normalizeId(c?.id ?? c?.commentId),
      created: extractDate(c, 'comment'),
      author: authorName,
      body: c?.body || c?.text || c?.content || '',
      __authorId: id ?? null
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

  // 1) Try explicit link first (often "/notes/{id}/comments")
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

  // 2) Fallback: global notes resource → /notes/{noteId}/comments
  const strat = { label: 'GET /notes/{id}/comments', method: 'GET', url: `${GATEWAY_REGION_BASE}/notes/${nid}/comments` };
  try {
    const items = await pullAllPagesWithOneRoute(
      strat, bearer, userId, orgId, limit, reqId, `comments[note:${noteId}]`
    );
    if (Array.isArray(items)) return normalizeComments(items);
  } catch (e) {
    dlog(`[${reqId}] comments failed strategy`, { noteId, strategy: strat.label, error: e?.message });
  }

  dlog(`[${reqId}] All comment strategies failed for note`, { noteId });
  return [];
}

function normalizeComments(items) {
  return items.map(c => {
    const id = authorIdFromComment(c);
    const mapped = nameFromMap(id);
    const authorName = mapped || extractAuthor(c);
    return ({
      id: normalizeId(c?.id ?? c?.commentId),
      created: extractDate(c, 'comment'),
      author: authorName,
      body: c?.body || c?.text || c?.content || '',
      __authorId: id ?? null
    });
  });
}

/* ---------- map application ---------- */

function applyNameMapToNotesAndComments(notes, reqId) {
  if (!Array.isArray(notes)) return;
  let noteCount = 0, commentCount = 0;

  for (const n of notes) {
    const nid = authorIdFromNote(n);
    const nm = nameFromMap(nid);
    if (nm) { n.__author = nm; noteCount++; }

    if (Array.isArray(n.comments)) {
      for (const c of n.comments) {
        const cid = authorIdFromComment(c);
        const cnm = nameFromMap(cid);
        if (cnm) { c.author = cnm; commentCount++; }
      }
    }
  }
  dlog(`[applyNameMap] mapped authors`, { notes: noteCount, comments: commentCount });
}

function applyNameMapToEmails(emails, reqId) {
  if (!Array.isArray(emails)) return;
  let updated = 0;
  for (const e of emails) {
    const id = e?.createdById ?? e?.createdByUserId ?? e?.userId ?? e?.authorId ?? e?.fromId ?? null;
    const nm = nameFromMap(id);
    if (nm) { e.__author = nm; updated++; }
  }
  dlog(`[applyNameMap] mapped email authors`, { emails: updated });
}
