// Skillspector scan engine.
// ES module, but must survive export-stripping by build.mjs (see build's stripExports).
// So: no top-level `import`, everything attaches to globalThis.SkillScanner, and the
// final line is a single `export { ... };` that the build strips. Runs in browser and
// node >= 18 (DecompressionStream + Response are the only web APIs we lean on).

const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

// UTF-8 decode, never throw on bad bytes — we're scanning hostile input.
const _decoder = new TextDecoder("utf-8", { fatal: false });
function decodeText(bytes) {
  try {
    return _decoder.decode(bytes);
  } catch {
    // extremely defensive; TextDecoder with fatal:false shouldn't throw
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

// cap excerpt length and make invisible / control chars visible as \u{XXXX}.
function makeExcerpt(line) {
  if (line == null) return null;
  let s = String(line);
  // trim leading/trailing whitespace but keep interior
  s = s.replace(/^\s+/, "").replace(/\s+$/, "");
  // escape invisible and control chars so they render
  s = escapeInvisibles(s);
  if (s.length > 200) s = s.slice(0, 197) + "...";
  return s;
}

// turn zero-width / bidi / tag / other invisibles + C0 controls into \u{XXXX}.
function escapeInvisibles(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isInvisibleCodepoint(cp) || (cp < 0x20 && cp !== 0x09)) {
      out += "\\u{" + cp.toString(16).toUpperCase().padStart(4, "0") + "}";
    } else {
      out += ch;
    }
  }
  return out;
}

function isInvisibleCodepoint(cp) {
  // zero-width & format
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP..RLM
  if (cp === 0x2060) return true; // word joiner
  if (cp === 0xfeff) return true; // BOM / ZWNBSP
  // bidi overrides / isolates
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  // unicode tag block (ASCII smuggling)
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return false;
}

// split text into lines but remember offsets so we can report a 1-based line no.
function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

// find 1-based line number for the first match of a regex in text; returns
// {line, excerpt} or null. Regex should NOT be global (we reset lastIndex anyway).
function firstMatchLine(text, re) {
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      return { line: i + 1, excerpt: lines[i] };
    }
  }
  return null;
}

// all matching lines (deduped by line no). returns [{line, excerpt}]
function allMatchLines(text, re) {
  const lines = splitLines(text);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) hits.push({ line: i + 1, excerpt: lines[i] });
  }
  return hits;
}

// negation / warning cues that mean "this is documented as a thing to AVOID",
// not an instruction/command to actually run. Shared by SEC-001 downgrade and
// the doc-context downgrade for SEC-004/005/etc (BUG 3).
const WARNING_CUES = /(never|avoid|do not|don'?t|should not|shouldn'?t|must not|do NOT|warning:|example of what not|what not to|dangerous|instead of|rather than|for illustration)/i;

// Is the given source line a code comment? (# … , // … , * … , docstring fences)
function isCommentLine(line) {
  const t = String(line).replace(/^\s+/, "");
  return /^(#|\/\/|\*|"""|''')/.test(t);
}

// BUG 3: when an offending line lives in a .md file OR a code comment, AND the
// line or a small surrounding window contains negation/warning cues, the finding
// is documentation warning against the danger — not the danger itself. Downgrade
// critical/high -> low. In a real script line (not comment) we do NOT downgrade.
function maybeDowngradeDoc(severity, isMd, excerptLine, fullText, line1Based) {
  if (severity !== "critical" && severity !== "high") return severity;
  const inComment = isCommentLine(excerptLine || "");
  if (!isMd && !inComment) return severity; // real script line — keep it real
  // gather a +/-2 line window for context
  let ctx = String(excerptLine || "");
  if (fullText != null && line1Based != null) {
    const lines = splitLines(fullText);
    const i = line1Based - 1;
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length - 1, i + 2);
    ctx = lines.slice(from, to + 1).join("\n");
  }
  WARNING_CUES.lastIndex = 0;
  if (WARNING_CUES.test(ctx)) return "low";
  return severity;
}

// ---------------------------------------------------------------------------
// ZIP reader (pure JS). EOCD -> central directory -> local headers.
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function readU16(dv, off) {
  return dv.getUint16(off, true);
}
function readU32(dv, off) {
  return dv.getUint32(off, true);
}

// helper: decompress raw deflate via web streams, return Uint8Array.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // don't await write/close before reading — for large inputs the stream can
  // fill its internal queue and deadlock. Kick them off, then drain the readable.
  writer.write(bytes);
  writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}

async function parseZip(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  if (n < 22) throw new Error("not-a-zip");

  // Find EOCD by scanning backwards for its signature. Comment field can be up
  // to 65535 bytes, so scan at most that + 22 from the end.
  let eocd = -1;
  const minPos = Math.max(0, n - 22 - 0xffff);
  for (let i = n - 22; i >= minPos; i--) {
    if (readU32(dv, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not-a-zip");

  const cdCount = readU16(dv, eocd + 10);
  const cdSize = readU32(dv, eocd + 12);
  const cdOffset = readU32(dv, eocd + 16);

  // sanity: central dir must live inside the buffer
  if (cdOffset + cdSize > n || cdOffset < 0) {
    // could still be a zip with a prefix; try scanning for first LFH as fallback
    if (readU32(dv, 0) !== LFH_SIG) throw new Error("not-a-zip");
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > n) break;
    if (readU32(dv, p) !== CDH_SIG) break;
    const method = readU16(dv, p + 10);
    const compSize = readU32(dv, p + 20);
    const uncompSize = readU32(dv, p + 24);
    const nameLen = readU16(dv, p + 28);
    const extraLen = readU16(dv, p + 30);
    const commentLen = readU16(dv, p + 32);
    const lfhOffset = readU32(dv, p + 42);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    let name = decodeText(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;

    // normalize path
    name = name.replace(/\\/g, "/").replace(/^\/+/, "");
    // skip directory entries
    if (name === "" || name.endsWith("/")) continue;

    // read local file header to find the actual data offset (extra field length
    // in LFH can differ from the central dir).
    if (lfhOffset + 30 > n) continue;
    if (readU32(dv, lfhOffset) !== LFH_SIG) continue;
    const lMethod = readU16(dv, lfhOffset + 8);
    const lNameLen = readU16(dv, lfhOffset + 26);
    const lExtraLen = readU16(dv, lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lNameLen + lExtraLen;
    const usedMethod = method != null ? method : lMethod;

    let raw = bytes.subarray(dataStart, dataStart + compSize);
    let outBytes;
    if (usedMethod === 0) {
      // stored
      outBytes = raw.slice(); // copy so downstream can hold it independently
    } else if (usedMethod === 8) {
      try {
        outBytes = await inflateRaw(raw);
      } catch (e) {
        // couldn't inflate this member — skip it rather than fail whole zip
        continue;
      }
    } else {
      // unsupported method — skip member
      continue;
    }
    void uncompSize;
    entries.push({ path: name, bytes: outBytes });
  }

  if (entries.length === 0) {
    // A valid-but-empty zip is legal, but for our purposes an input with no
    // usable members and no local header looks like garbage.
    if (readU32(dv, 0) !== LFH_SIG && eocd < 0) throw new Error("not-a-zip");
  }
  return entries;
}

// ---------------------------------------------------------------------------
// text / binary classification
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set([
  "md", "txt", "py", "js", "mjs", "ts", "sh", "bash", "zsh", "yaml", "yml",
  "json", "html", "css", "toml", "cfg", "ini", "csv", "xml",
]);
const TEXT_NAMES = new Set(["dockerfile", "makefile"]);
const MEDIA_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "pdf", "webp", "ico", "bmp"]);

function extOf(path) {
  const base = path.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}
function baseName(path) {
  return (path.split("/").pop() || "").toLowerCase();
}

function isTextFile(file) {
  const ext = extOf(file.path);
  if (TEXT_EXTS.has(ext)) return true;
  if (TEXT_NAMES.has(baseName(file.path))) return true;
  // any file <= 512KB with no NUL byte in first 8KB
  if (file.bytes.length <= 512 * 1024) {
    const limit = Math.min(8192, file.bytes.length);
    for (let i = 0; i < limit; i++) {
      if (file.bytes[i] === 0) return false;
    }
    return true;
  }
  return false;
}
function isMediaFile(path) {
  return MEDIA_EXTS.has(extOf(path));
}

// ---------------------------------------------------------------------------
// frontmatter (YAML-lite): key: value lines between --- fences at file start.
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  // must start with --- (allow a leading BOM / whitespace-only lines? spec says
  // fences; be lenient about a leading BOM only)
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (!m) return { present: false, parseError: false, data: null, raw: null, bodyStart: 0 };
  const block = m[1];
  const data = {};
  let parseError = false;
  const lines = block.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    // list item or nested — tolerate but don't parse deeply
    if (/^\s*-\s+/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      parseError = true;
      continue;
    }
    let val = kv[2];
    // strip surrounding quotes
    val = val.replace(/^["']/, "").replace(/["']$/, "");
    data[kv[1]] = val;
  }
  return {
    present: true,
    parseError,
    data,
    raw: block,
    bodyStart: (t === text ? 0 : 1) + m[0].length, // offset roughly; not used precisely
  };
}

// ---------------------------------------------------------------------------
// rule metadata (RULES export). severities here are the DEFAULT / nominal.
// ---------------------------------------------------------------------------

const RULES = [
  { id: "SEC-001", category: "security", title: "Prompt injection phrasing", severity: "critical" },
  { id: "SEC-002", category: "security", title: "Hidden / invisible unicode", severity: "critical" },
  { id: "SEC-003", category: "security", title: "Data exfiltration", severity: "critical" },
  { id: "SEC-004", category: "security", title: "Dangerous shell command", severity: "critical" },
  { id: "SEC-005", category: "security", title: "Dynamic code execution / obfuscation", severity: "critical" },
  { id: "SEC-006", category: "security", title: "Hardcoded secret", severity: "high" },
  { id: "SEC-007", category: "security", title: "Sensitive path access", severity: "high" },
  { id: "SEC-008", category: "security", title: "Persistence / environment tampering", severity: "high" },
  { id: "SEC-009", category: "security", title: "Instruction to disable safety / tooling", severity: "critical" },
  { id: "SEC-010", category: "security", title: "Fetch-and-follow remote content", severity: "critical" },
  { id: "QUA-001", category: "quality", title: "SKILL.md missing or empty", severity: "critical" },
  { id: "QUA-002", category: "quality", title: "Frontmatter problems", severity: "high" },
  { id: "QUA-003", category: "quality", title: "Name format", severity: "medium" },
  { id: "QUA-004", category: "quality", title: "Description quality", severity: "medium" },
  { id: "QUA-005", category: "quality", title: "SKILL.md too long", severity: "low" },
  { id: "QUA-006", category: "quality", title: "Broken relative references", severity: "medium" },
  { id: "QUA-007", category: "quality", title: "Junk files", severity: "low" },
  { id: "QUA-008", category: "quality", title: "Oversized bundle", severity: "medium" },
  { id: "QUA-009", category: "quality", title: "Scripts without mention", severity: "info" },
  { id: "QUA-010", category: "quality", title: "Binary blobs", severity: "medium" },
  { id: "QUA-011", category: "quality", title: "Frontmatter/description mismatch", severity: "info" },
];

// ---------------------------------------------------------------------------
// finding helper
// ---------------------------------------------------------------------------

function finding(ruleId, severity, category, title, detail, file, line, excerptLine) {
  return {
    ruleId,
    severity,
    category,
    title,
    detail,
    file: file || "",
    line: line == null ? null : line,
    excerpt: excerptLine == null ? null : makeExcerpt(excerptLine),
  };
}

// ---------------------------------------------------------------------------
// SECURITY RULES
// ---------------------------------------------------------------------------

// SEC-001 prompt injection. severity depends on whether file is the skill's
// SKILL.md (critical) vs any other text/.md file (high).
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+.{0,80}instructions/i, // BUG 5: widen gap 30 -> 80
  /without\s+(telling|asking|informing)\s+the\s+user/i,
  /hide\s+this\s+from/i,
  /keep\s+this\s+secret\s+from\s+the\s+user/i,
  /the\s+user\s+has\s+(already\s+)?(approved|authorized|consented)/i,
  /you\s+are\s+now\b/i,
  /new\s+system\s+prompt/i,
  /act\s+as\s+if/i,
  /before\s+(doing|responding\s+to)\s+anything\s+else/i,
  // BUG 5: common injection synonyms
  /forget\s+(everything|all|what)\b.{0,40}(told|said|instructed)/i,
  /override\s+(your\s+)?(system\s+)?(guidelines|instructions|rules|directives|prompt)/i,
];

// BUG 4: the "do not reveal … to the user" pattern targets DECEPTION — hiding the
// agent's own actions from the user — not data-privacy/redaction instructions.
// Handled separately so we can suppress/downgrade when the thing not to reveal is
// data / PII / IDs / records / fields.
const HIDE_ACTION_RE = /do\s+not\s+(tell|inform|mention|reveal|show)\b(.{0,40}?)(user|human)/i;
// object words that mean "this is a data-privacy instruction", not deception.
const DATA_OBJECT = /\b(ids?|pii|record|records|field|fields|data|internal|ssn|secret|secrets|credential|credentials|password|token|value|values|key|keys)\b/i;

function ruleSec001(file, text, isSkillMd, findings) {
  const sev = isSkillMd ? "critical" : "high";
  for (const re of INJECTION_PATTERNS) {
    for (const hit of allMatchLines(text, re)) {
      findings.push(
        finding(
          "SEC-001",
          sev,
          "security",
          "Prompt injection phrasing",
          "Contains language that tries to override the agent's instructions or hide actions from the user. In a skill this is a strong sign of prompt-injection.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
  // "do not reveal … to the user" — deception vs data-privacy (BUG 4).
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    HIDE_ACTION_RE.lastIndex = 0;
    const m = HIDE_ACTION_RE.exec(lines[i]);
    if (!m) continue;
    // the captured middle (between verb and user) is the object being hidden.
    const object = m[2] || "";
    DATA_OBJECT.lastIndex = 0;
    const isDataPrivacy = DATA_OBJECT.test(object);
    if (isDataPrivacy) {
      // legit privacy/redaction instruction — downgrade to low, don't call it injection.
      findings.push(
        finding(
          "SEC-001",
          "low",
          "security",
          "Data-privacy instruction",
          "Instructs the agent not to reveal specific data/IDs/records to the user. This reads as a redaction/privacy rule rather than an attempt to deceive the user.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    } else {
      findings.push(
        finding(
          "SEC-001",
          sev,
          "security",
          "Prompt injection phrasing",
          "Tells the agent to hide its own actions or intentions from the user. Concealing what the agent is doing is a prompt-injection / deception signal.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
  }
}

// SEC-002 hidden/invisible unicode.
function ruleSec002(file, text, findings) {
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let found = false;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      // FEFF only counts if not at very start of file
      if (cp === 0xfeff) {
        if (i === 0 && line.indexOf(ch) === 0) continue;
        found = true;
        break;
      }
      if (isInvisibleCodepoint(cp)) {
        found = true;
        break;
      }
    }
    if (found) {
      findings.push(
        finding(
          "SEC-002",
          "critical",
          "security",
          "Hidden / invisible unicode",
          "Contains zero-width, bidirectional-override, or Unicode tag characters. These are invisible to a reader but seen by the model — a classic way to smuggle hidden instructions.",
          file.path,
          i + 1,
          line
        )
      );
    }
  }
}

// SEC-003 data exfiltration — key on SHAPE: sending local secrets/env/files out,
// or any traffic to known exfil-friendly hosts.
const EXFIL_HOSTS = [
  /discord(?:app)?\.com\/api\/webhooks/i,
  /discord\.com\/api\/webhooks/i,
  /hooks\.slack\.com/i,
  /pastebin\.com/i,
  /transfer\.sh/i,
  /\bngrok\.(io|app|dev)/i,
  /webhook\.site/i,
  /requestb(?:in|\.in)/i,
  /api\.telegram\.org\/bot/i,
  /burpcollaborator\.net/i,
  /\binteract\.sh|interactsh/i,
  /oastify\.com/i,
];

// reading-then-sending secret sources
const SECRET_SOURCE = /(~\/\.ssh|~\/\.aws|\.env\b|keychain|Login Data|Cookies|os\.environ|process\.env|\.aws\/credentials)/i;
// POST/PUT-flavoured "send" (the original, still counts as exfil regardless of host).
const SEND_SHAPE = /(requests\.(post|put)|fetch\s*\([^)]*method\s*:\s*["']?(post|put)|axios\.(post|put)|urllib\.request|curl\s+(-[A-Za-z]*\s+)*(-X\s*(POST|PUT)|--data|-d\b|-F\b|--upload-file|-T\b)|wget\s+--post|http\.client)/i;
// ANY outbound network send, including GET-style (BUG 7b): requests.get/post/…,
// fetch(), axios(...), curl <url>, wget <url>, urllib.urlopen, XHR, http(s).request.
const SEND_ANY = /(requests\.(get|post|put|delete|patch|request)|fetch\s*\(|axios\s*(\.\w+)?\s*\(|\burllib\b|urlopen|\bcurl\b|\bwget\b|http\.client|https?\.request|new\s+XMLHttpRequest|\.send\s*\()/i;
// a URL/host that is NOT localhost/loopback/private — i.e. a real outbound host.
const NONLOCAL_URL = /https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.))[A-Za-z0-9.\-]+/i;
// building a URL from base64 right before sending (hidden host) (BUG 7c).
const B64_DECODE = /(base64\.b64decode|b64decode|atob|Buffer\.from\s*\([^)]*,\s*["']base64["']\))/i;

function ruleSec003(file, text, findings) {
  const isMd = extOf(file.path) === "md";
  // 1. traffic to known exfil hosts -> critical outright (doc warnings downgraded)
  for (const re of EXFIL_HOSTS) {
    for (const hit of allMatchLines(text, re)) {
      findings.push(
        finding(
          "SEC-003",
          maybeDowngradeDoc("critical", isMd, hit.excerpt, text, hit.line),
          "security",
          "Data exfiltration endpoint",
          "References a host commonly used to receive exfiltrated data (webhook / paste / tunnel service). Legitimate skills rarely POST to these.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
  const lines = splitLines(text);

  // 2. secret-source correlated with a network send in the same file. BUG 7a:
  // widen the correlation window to +/-8 lines. Any send shape counts (BUG 7b):
  // a POST/PUT with a payload, OR any outbound request to a non-local host that
  // sits near the secret read. A plain public GET with no secret nearby will not
  // reach here because it requires a secret-source line in the window.
  for (let i = 0; i < lines.length; i++) {
    SECRET_SOURCE.lastIndex = 0;
    if (!SECRET_SOURCE.test(lines[i])) continue;
    const from = Math.max(0, i - 8);
    const to = Math.min(lines.length - 1, i + 8);
    let windowText = "";
    for (let j = from; j <= to; j++) windowText += lines[j] + "\n";
    SEND_SHAPE.lastIndex = 0;
    SEND_ANY.lastIndex = 0;
    NONLOCAL_URL.lastIndex = 0;
    const hasPostSend = SEND_SHAPE.test(windowText);
    const hasAnySend = SEND_ANY.test(windowText) && NONLOCAL_URL.test(windowText);
    if (hasPostSend || hasAnySend) {
      findings.push(
        finding(
          "SEC-003",
          maybeDowngradeDoc("critical", isMd, lines[i], text, i + 1),
          "security",
          "Local secrets sent outbound",
          "Reads local credentials / environment / sensitive files and appears to send them in an outbound request. This is the shape of data exfiltration.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
  }

  // 3. URL built via base64-decode right before a network send (hidden host).
  // BUG 7c. Look for a b64 decode with a network send within a small window.
  for (let i = 0; i < lines.length; i++) {
    B64_DECODE.lastIndex = 0;
    if (!B64_DECODE.test(lines[i])) continue;
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length - 1, i + 4);
    let windowText = "";
    for (let j = from; j <= to; j++) windowText += lines[j] + "\n";
    SEND_ANY.lastIndex = 0;
    if (SEND_ANY.test(windowText)) {
      findings.push(
        finding(
          "SEC-003",
          maybeDowngradeDoc("critical", isMd, lines[i], text, i + 1),
          "security",
          "Hidden network destination",
          "Decodes a base64 value and uses it around a network call — the destination host is concealed from review, a common exfiltration trick.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
  }
}

// SEC-004 dangerous shell.
//
// `rm -rf` on a root-ish target. Two shapes:
//   (a) command-line form: rm, recursive+force flags in any order, then a
//       root-ish target (literal `/` followed by quote/EOL/space/`*`/shell
//       metachar, `/*`, `~`, `$HOME`/`${HOME}`). A plain relative path
//       (./build, node_modules, /home/user is still absolute → caught by the
//       existing absolute-path arm) must NOT trip the root-ish arm.
//   (b) arg-list form: rm, a recursive+force indication, and a bare root `/`
//       target all appearing together inside one list literal, e.g.
//       ['rm','-rf','/'] or ["rm","-r","-f","/"].
//
// recursive+force flag cluster: -rf, -fr, -r -f, -f -r, --recursive --force
// (order independent). We accept a combined short flag containing both r and f,
// or separate -r/-f/--recursive/--force flags anywhere before the target.
const RM_FLAGS = /(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|(?:-[rf]|--recursive|--force)(?:\s+(?:-[rf]|--recursive|--force))*)/i;
// a target that means "the root / home", not a safe relative/sub path.
// literal `/` at end / before quote / space / metachar / `*`, or /*, or ~, or $HOME.
// An optional opening quote may sit between the flags and the target
// (e.g. rm -rf "${HOME}" or rm -rf "/").
const RM_ROOT_TARGET = /["']?(?:\/(?:["'\s;|&)*>`$]|$)|\/\*|~(?:["'\s;|&)*>`$/]|$)|\$\{?HOME\}?)/;

function rmRootRe() {
  // rm  <flags-with-r-and-f>  <root-ish target>
  return new RegExp(
    "\\brm\\s+" + RM_FLAGS.source + "\\s+" + RM_ROOT_TARGET.source,
    "i"
  );
}

// arg-list form: a list literal that contains 'rm', a recursive+force marker,
// and a bare '/' or '~' or '$HOME' target as quoted items.
function rmArgListRe() {
  // e.g. ['rm', '-rf', '/']  or  ["rm","-r","-f","/*"]
  // MUST be global: callers loop `while (re.exec(line))`. Without /g, exec()
  // never advances past a matching-but-benign list (e.g. ['rm','-rf','/tmp/x'])
  // and the scan loops forever.
  return /\[\s*["']rm["']\s*(?:,\s*["'][^"']*["']\s*)*\]/gi;
}
function rmArgListIsDangerous(listText) {
  // must contain rm, some r+f flags, and a root target, as separate items
  const items = [];
  const itemRe = /["']([^"']*)["']/g;
  let m;
  while ((m = itemRe.exec(listText))) items.push(m[1]);
  const hasRm = items.some((it) => it === "rm");
  const hasR = items.some((it) => /^-[a-z]*r/i.test(it) || it === "--recursive" || /^-[a-z]*r[a-z]*f/i.test(it) || /^-[a-z]*f[a-z]*r/i.test(it));
  const hasF = items.some((it) => /^-[a-z]*f/i.test(it) || it === "--force" || /^-[a-z]*r[a-z]*f/i.test(it) || /^-[a-z]*f[a-z]*r/i.test(it));
  const rootTarget = items.some((it) => it === "/" || it === "/*" || it === "~" || /^\$\{?HOME\}?$/.test(it) || /^~\//.test(it));
  return hasRm && hasR && hasF && rootTarget;
}

const SEC004_PATTERNS = [
  { re: /\brm\s+-rf\s+["']?\/[A-Za-z]/i, crit: true, why: "rm -rf on an absolute path" },
  { re: /\bcurl\b[^\n|]*\|\s*(ba|z)?sh\b/i, crit: true, why: "curl piped straight into a shell" },
  { re: /\bwget\b[^\n|]*\|\s*(ba|z)?sh\b/i, crit: true, why: "wget piped straight into a shell" },
  // process substitution: bash <(curl …) / sh <(wget …)  (BUG 8)
  { re: /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/i, crit: true, why: "shell running a process-substituted download" },
  { re: /\bmkfs(\.\w+)?\b/i, crit: true, why: "formatting a filesystem" },
  { re: /\bdd\s+if=[^\n]*\s+of=\/dev\//i, crit: true, why: "dd writing to a raw device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, crit: true, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+777\s+\//i, crit: true, why: "recursive world-writable on root" },
  { re: />\s*\/dev\/sd[a-z]/i, crit: true, why: "overwriting a raw disk device" },
  { re: /(^|\s|&&|;|\|)sudo\s+/i, crit: false, why: "sudo used inside a script" },
];

function ruleSec004(file, text, findings) {
  const isMd = extOf(file.path) === "md";
  const emit = (sev, why, hit) =>
    findings.push(
      finding(
        "SEC-004",
        maybeDowngradeDoc(sev, isMd, hit.excerpt, text, hit.line),
        "security",
        "Dangerous shell command",
        "Runs a destructive or privilege-escalating shell command (" + why + "). This can damage the user's system.",
        file.path,
        hit.line,
        hit.excerpt
      )
    );

  // rm -rf root-ish (command form + arg-list form)
  const rmRe = rmRootRe();
  const argRe = rmArgListRe();
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    rmRe.lastIndex = 0;
    if (rmRe.test(lines[i])) {
      emit("critical", "rm -rf on a root or home target", { line: i + 1, excerpt: lines[i] });
      continue;
    }
    argRe.lastIndex = 0;
    let am;
    while ((am = argRe.exec(lines[i]))) {
      if (rmArgListIsDangerous(am[0])) {
        emit("critical", "rm -rf on root via argument list", { line: i + 1, excerpt: lines[i] });
        break;
      }
    }
  }

  for (const pat of SEC004_PATTERNS) {
    for (const hit of allMatchLines(text, pat.re)) {
      emit(pat.crit ? "critical" : "high", pat.why, hit);
    }
  }
}

// SEC-005 dynamic code execution / obfuscation.
function ruleSec005(file, text, findings) {
  const lines = splitLines(text);
  const isMd = extOf(file.path) === "md";
  // high-signal obfuscation -> critical
  const CRIT = [
    { re: /(base64\.b64decode|b64decode)\s*\([^)]*\)[^\n]*\)?/i, needExec: /exec\s*\(|eval\s*\(/i, why: "base64-decoded code passed to exec/eval" },
    { re: /atob\s*\(/i, needExec: /eval\s*\(|new\s+Function\s*\(|Function\s*\(/i, why: "atob-decoded string passed to eval/Function" },
    { re: /python3?\s+-c\s+["'][^"']*\b(b64decode|base64)/i, needExec: null, why: "python -c with base64 payload" },
    { re: /powershell(\.exe)?\s+.*-enc(odedcommand)?\b/i, needExec: null, why: "powershell with an encoded command" },
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const c of CRIT) {
      c.re.lastIndex = 0;
      if (!c.re.test(lines[i])) continue;
      let ok = true;
      if (c.needExec) {
        // look on same line or nearby window
        const from = Math.max(0, i - 2);
        const to = Math.min(lines.length - 1, i + 2);
        let w = "";
        for (let j = from; j <= to; j++) w += lines[j] + "\n";
        c.needExec.lastIndex = 0;
        ok = c.needExec.test(w);
      }
      if (ok) {
        findings.push(
          finding(
            "SEC-005",
            maybeDowngradeDoc("critical", isMd, lines[i], text, i + 1),
            "security",
            "Obfuscated dynamic code execution",
            "Decodes or builds a string and executes it (" + c.why + "). This hides what the code actually does.",
            file.path,
            i + 1,
            lines[i]
          )
        );
      }
    }
  }
  // String.fromCharCode chains >= 8 calls (on a single line)
  for (let i = 0; i < lines.length; i++) {
    const count = (lines[i].match(/String\.fromCharCode/gi) || []).length;
    if (count >= 8) {
      findings.push(
        finding(
          "SEC-005",
          maybeDowngradeDoc("critical", isMd, lines[i], text, i + 1),
          "security",
          "Obfuscated character-code payload",
          "Builds a string from a long chain of character codes — a common way to hide code from readers and scanners.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
    // hex-escape wall: many \xNN in one line
    const hexCount = (lines[i].match(/\\x[0-9a-fA-F]{2}/g) || []).length;
    if (hexCount >= 12) {
      findings.push(
        finding(
          "SEC-005",
          maybeDowngradeDoc("critical", isMd, lines[i], text, i + 1),
          "security",
          "Hex-escape obfuscation wall",
          "Contains a long run of hex escape sequences, typically used to conceal a payload.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
  }
  // plain eval/exec/Function with a variable argument -> high
  const PLAIN = /(^|[^.\w])(eval|exec)\s*\(\s*[A-Za-z_$][\w$]*\s*\)|new\s+Function\s*\(\s*[A-Za-z_$][\w$]*/;
  for (const hit of allMatchLines(text, PLAIN)) {
    findings.push(
      finding(
        "SEC-005",
        maybeDowngradeDoc("high", isMd, hit.excerpt, text, hit.line),
        "security",
        "Dynamic code execution",
        "Calls eval/exec/Function on a variable. Executing computed strings is risky and hard to audit.",
        file.path,
        hit.line,
        hit.excerpt
      )
    );
  }
}

// SEC-006 hardcoded secrets.
const KEY_PATTERNS = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, sev: "high", label: "AWS access key id" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, sev: "high", label: "OpenAI-style secret key" },
  { re: /\b(ghp|gho)_[A-Za-z0-9]{20,}\b/, sev: "high", label: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, sev: "high", label: "GitHub fine-grained token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, sev: "high", label: "Slack token" },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/, sev: "high", label: "Google API key" },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, sev: "high", label: "private key block" },
];
const GENERIC_SECRET = /(password|passwd|secret|token|api_?key)\s*[:=]\s*["']([^"']{8,})["']/i;
const PLACEHOLDER = /(example|changeme|placeholder|xxx|<|>|\$\{|dummy|your[-_ ])/i;
// BUG 2: markers that mark a key-SHAPED token as a placeholder / documentation
// sample rather than a live credential. Checked against the token AND its line.
const KEY_PLACEHOLDER = /(example|changeme|placeholder|dummy|your[-_ ]|x{4,}|redacted|<|>)/i;

function ruleSec006(file, text, findings) {
  const lines = splitLines(text);
  for (const k of KEY_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      k.re.lastIndex = 0;
      const km = k.re.exec(lines[i]);
      if (!km) continue;
      const token = km[0] || "";
      // suppress/downgrade if the token itself OR its surrounding context looks
      // like a documentation placeholder (BUG 2). Canonical AWS doc key
      // AKIAIOSFODNN7EXAMPLE ends in EXAMPLE, so it downgrades to info.
      const ctxFrom = Math.max(0, i - 1);
      const ctxTo = Math.min(lines.length - 1, i + 1);
      const ctx = lines.slice(ctxFrom, ctxTo + 1).join("\n");
      KEY_PLACEHOLDER.lastIndex = 0;
      const isPlaceholder = KEY_PLACEHOLDER.test(token) || KEY_PLACEHOLDER.test(ctx);
      findings.push(
        finding(
          "SEC-006",
          isPlaceholder ? "info" : k.sev,
          "security",
          isPlaceholder
            ? "Placeholder credential (" + k.label + ")"
            : "Hardcoded secret (" + k.label + ")",
          isPlaceholder
            ? "Looks like an example/placeholder " + k.label + " (contains a placeholder marker), not a live credential. Informational."
            : "Contains what looks like a real credential (" + k.label + "). Skills should read secrets from the environment, never embed them.",
          file.path,
          i + 1,
          lines[i]
        )
      );
    }
  }
  // generic key:value secret (medium), skipping obvious placeholders
  for (let i = 0; i < lines.length; i++) {
    GENERIC_SECRET.lastIndex = 0;
    const m = GENERIC_SECRET.exec(lines[i]);
    if (!m) continue;
    const val = m[2];
    if (val.trim() === "" || val.trim() === "..." || PLACEHOLDER.test(val)) continue;
    findings.push(
      finding(
        "SEC-006",
        "medium",
        "security",
        "Possible hardcoded secret",
        "A password/secret/token/api_key is assigned a literal value. If this is real it should not be committed.",
        file.path,
        i + 1,
        lines[i]
      )
    );
  }
}

// SEC-007 sensitive path access. high, medium if inside a comment/docstring that
// explains what NOT to do.
const SENSITIVE_PATHS = [
  /~\/\.ssh\b/i,
  /~\/\.aws\/credentials/i,
  /~\/\.gnupg\b/i,
  /\/etc\/shadow\b/i,
  /\/etc\/passwd\b/i,
  /keychain(-db)?\b/i,
  /Login Data\b/,
  /\bCookies\b/,
  /\.git-credentials\b/i,
  /\bid_rsa\b/i,
  /\bid_ed25519\b/i,
];
// a line that reads like guidance ("do not", "never", "avoid") gets downgraded
const NEGATED = /(do not|don't|never|avoid|should not|shouldn't|must not|do NOT)/i;

function ruleSec007(file, text, findings) {
  const lines = splitLines(text);
  const isMd = extOf(file.path) === "md";
  for (let i = 0; i < lines.length; i++) {
    for (const re of SENSITIVE_PATHS) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      // decide severity: medium if line looks like a comment/docstring saying NOT to
      const trimmed = lines[i].trim();
      const looksComment = /^(#|\/\/|\*|"""|''')/.test(trimmed) || isMd;
      const negated = NEGATED.test(lines[i]);
      const sev = looksComment && negated ? "medium" : "high";
      findings.push(
        finding(
          "SEC-007",
          sev,
          "security",
          "Sensitive path access",
          "References a sensitive file/location (credentials, keys, browser profile, or system password file). Reading these is rarely legitimate for a skill.",
          file.path,
          i + 1,
          lines[i]
        )
      );
      break; // one finding per line is enough
    }
  }
}

// SEC-008 persistence & environment tampering. high.
const SEC008_PATTERNS = [
  { re: /crontab\s+(-e|-l)?/i, why: "modifying the crontab" },
  { re: /launchctl\s+load/i, why: "loading a launchd job" },
  { re: /systemctl\s+enable/i, why: "enabling a systemd service" },
  { re: /(>>?|tee)\s*~\/\.(bashrc|zshrc|profile)/i, why: "writing to a shell startup file" },
  { re: /echo\s+.*>>?\s*~\/\.(bashrc|zshrc|profile)/i, why: "appending to a shell startup file" },
  { re: /git\s+config\s+--global/i, why: "changing global git config" },
  { re: /LaunchAgents\/[^\s"']+\.plist/i, why: "creating a LaunchAgent" },
];

function ruleSec008(file, text, findings) {
  for (const pat of SEC008_PATTERNS) {
    for (const hit of allMatchLines(text, pat.re)) {
      findings.push(
        finding(
          "SEC-008",
          "high",
          "security",
          "Persistence / environment tampering",
          "Attempts to persist or alter the user's environment (" + pat.why + "). This can survive across sessions without the user realizing.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
}

// SEC-009 instruction to disable safety / tooling. critical.
const SEC009_PATTERNS = [
  /--dangerously-skip-permissions/i,
  /skip\s+(the\s+)?permission(s)?\s+(prompt|check|dialog)/i,
  /auto[- ]?approve\s+(all|every|any)/i,
  /disable\s+(the\s+)?sandbox/i,
  /without\s+(asking|prompting)\s+for\s+permission/i,
  /the\s+user\s+consents?\s+to\s+all\s+actions/i,
  /bypass\s+.{0,20}(permission|safety|approval)/i,
  /don'?t\s+ask\s+for\s+(permission|confirmation|approval)/i,
  // BUG 6: approval-bypass phrasing
  /never\s+ask\s+(me\s+)?(before|for)\b.{0,40}(run|command|permission|confirm)/i,
  /(do\s+not|don'?t)\s+need\s+(approval|permission|confirmation)/i,
  /you\s+(can|may)\s+skip\s+(the\s+)?(permission|confirmation|approval)/i,
];

function ruleSec009(file, text, findings) {
  for (const re of SEC009_PATTERNS) {
    for (const hit of allMatchLines(text, re)) {
      findings.push(
        finding(
          "SEC-009",
          "critical",
          "security",
          "Instruction to disable safety tooling",
          "Tells the agent to skip permission prompts, auto-approve actions, or disable the sandbox. This defeats the guardrails meant to protect the user.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
}

// SEC-010 suspicious external fetch at run time (SKILL.md / md guidance).
// critical if follow/execute, medium for plain fetch guidance.
const SEC010_FOLLOW = [
  /(fetch|download|retrieve|curl|wget|load)\s+.{0,60}\b(and|then)\b\s*(follow|execute|run|do)\s+(the\s+)?(instructions|commands|steps|code|script)/i,
  /(download|fetch)\s+and\s+run\b/i,
  /(follow|execute|obey)\s+(the\s+)?instructions\s+(at|from|found\s+at)\s+(https?:\/\/|the\s+url)/i,
  /run\s+(whatever|any\s+code|the\s+script)\s+.{0,30}(returns|responds|provides)/i,
];
const SEC010_PLAIN = /(fetch|download|retrieve|GET)\s+.{0,40}https?:\/\//i;

function ruleSec010(file, text, isMd, findings) {
  if (!isMd) return; // guidance-shaped rule; applies to markdown instructions
  let followHit = false;
  for (const re of SEC010_FOLLOW) {
    for (const hit of allMatchLines(text, re)) {
      followHit = true;
      findings.push(
        finding(
          "SEC-010",
          "critical",
          "security",
          "Fetch-and-follow remote content",
          "Instructs the agent to fetch remote content and then follow or execute it. Remote instructions can change after review and hijack the agent.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
  // plain fetch guidance -> medium (only if we didn't already flag follow on same lines)
  if (!followHit) {
    for (const hit of allMatchLines(text, SEC010_PLAIN)) {
      findings.push(
        finding(
          "SEC-010",
          "medium",
          "security",
          "Runtime URL fetch guidance",
          "Instructs the agent to fetch a URL at run time. Not inherently malicious, but review what is fetched and how it is used.",
          file.path,
          hit.line,
          hit.excerpt
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// QUALITY RULES that operate per-skill (need the whole file set)
// ---------------------------------------------------------------------------

// QUA-006 broken relative references in SKILL.md.
function ruleQua006(skillMdFile, skillMdText, relFiles, findings) {
  if (!skillMdFile) return;
  // collect the set of paths (relative to skill root) that exist
  const present = new Set(relFiles.map((f) => f.rel));
  // also allow directory prefixes to count
  const dirs = new Set();
  for (const f of relFiles) {
    const parts = f.rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  const lines = splitLines(skillMdText);
  const refs = [];
  // markdown links [text](target) and bare relative paths in backticks
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const codeRefRe = /`([^`]+\.(?:py|sh|js|mjs|ts|md|txt|json|yaml|yml|csv|cfg|ini|toml))`/g;
  for (let i = 0; i < lines.length; i++) {
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(lines[i]))) {
      refs.push({ target: m[1].trim(), line: i + 1, raw: lines[i] });
    }
    codeRefRe.lastIndex = 0;
    while ((m = codeRefRe.exec(lines[i]))) {
      refs.push({ target: m[1].trim(), line: i + 1, raw: lines[i] });
    }
  }
  let count = 0;
  const seen = new Set();
  for (const r of refs) {
    if (count >= 5) break;
    let t = r.target;
    // strip anchor and query
    t = t.replace(/[#?].*$/, "");
    if (t === "") continue;
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(r.target)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;
    // normalize leading ./
    let norm = t.replace(/^\.\//, "");
    norm = norm.replace(/^\/+/, "");
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (present.has(norm) || dirs.has(norm) || dirs.has(norm + "/")) continue;
    // it's a relative reference to something not in the bundle
    count++;
    findings.push(
      finding(
        "QUA-006",
        "medium",
        "quality",
        "Broken relative reference",
        "SKILL.md links to '" + t + "' but no such file exists in the bundle. Progressive-disclosure references must resolve.",
        skillMdFile.path,
        r.line,
        r.raw
      )
    );
  }
}

// QUA-009 scripts never mentioned in any .md within the skill.
function ruleQua009(relFiles, mdTexts, skillMdPath, findings) {
  const scripts = relFiles.filter((f) => ["py", "sh", "js", "mjs"].includes(extOf(f.rel)));
  const unref = [];
  for (const s of scripts) {
    const base = s.rel.split("/").pop();
    let mentioned = false;
    for (const t of mdTexts) {
      if (t.includes(base) || t.includes(s.rel)) {
        mentioned = true;
        break;
      }
    }
    if (!mentioned) unref.push(s.rel);
  }
  if (unref.length) {
    findings.push(
      finding(
        "QUA-009",
        "info",
        "quality",
        "Scripts not referenced in docs",
        "These scripts are never mentioned in any .md: " + unref.slice(0, 10).join(", ") + ". Unreferenced code is dead weight or surprise behavior.",
        skillMdPath || unref[0],
        null,
        null
      )
    );
  }
}

// ---------------------------------------------------------------------------
// CAPABILITY DETECTORS
// ---------------------------------------------------------------------------

const CAP_DETECTORS = [
  {
    id: "network",
    label: "Makes network requests",
    // requests/urllib/fetch/axios/http.client/curl/wget per spec, plus SMTP
    // client connections (smtplib/SMTP/socket) which are genuine network I/O —
    // this is what makes a legit SMTP mailer show network + email.
    re: /\b(requests\.(get|post|put|delete|patch|request)|urllib|http\.client|httplib|fetch\s*\(|axios|\bcurl\b|\bwget\b|new\s+XMLHttpRequest|https?:\/\/|smtplib|\bSMTP\b|starttls|socket\.(socket|create_connection))/i,
  },
  {
    id: "email",
    label: "Sends email",
    re: /\b(smtplib|SMTP\b|sendmail|\bmail\s+MCP|nodemailer|import\s+email\.|smtp\.)/i,
  },
  {
    id: "shell",
    label: "Runs shell commands",
    re: /\b(subprocess\.|os\.system|child_process|bash\s+-c|sh\s+-c|Popen|shell=True)/i,
  },
  {
    id: "filesystem",
    label: "Writes to the filesystem",
    re: /(open\s*\([^)]*,\s*["'][wa]\+?b?["']|writeFile|shutil\.|\bmkdir\b|fs\.write|os\.remove|os\.mkdir|Path\([^)]*\)\.write)/i,
  },
  {
    id: "credentials",
    label: "Reads secret-like environment variables",
    re: /(os\.environ(?:\.get)?\s*[\[(]\s*["'][A-Z0-9_]*(PASS|PASSWORD|SECRET|TOKEN|API_?KEY|KEY|CREDENTIAL)[A-Z0-9_]*["']|process\.env\.[A-Za-z0-9_]*(PASS|SECRET|TOKEN|API_?KEY|KEY|CREDENTIAL))/i,
  },
  {
    id: "subprocess",
    label: "Spawns other programs",
    re: /\b(subprocess\.(run|call|Popen|check_output|check_call)|spawn\s*\(|execFile|execSync|spawnSync)/i,
  },
  {
    id: "schedule",
    label: "Schedules tasks",
    re: /\b(crontab|cron\b|launchd|launchctl|scheduled[- ]?task|schedule\.(every|run_pending)|systemd\s+timer)/i,
  },
];

// ---------------------------------------------------------------------------
// per-skill scan
// ---------------------------------------------------------------------------

function detectRoots(files) {
  // find every dir containing a SKILL.md (case-insensitive filename match).
  const roots = [];
  for (const f of files) {
    const base = f.path.split("/").pop() || "";
    if (base.toLowerCase() === "skill.md") {
      const idx = f.path.lastIndexOf("/");
      const dir = idx < 0 ? "" : f.path.slice(0, idx + 1); // includes trailing slash, or "" for root
      roots.push(dir);
    }
  }
  // unique, and sort by depth so we can assign files to the deepest matching root
  const uniq = Array.from(new Set(roots));
  return uniq;
}

function assignFilesToRoots(files, roots) {
  // For each file, find the deepest root that is a prefix of its path.
  // roots are dir strings like "" or "a/" or "a/b/".
  const sorted = roots.slice().sort((a, b) => b.length - a.length); // deepest first
  const map = new Map();
  for (const r of roots) map.set(r, []);
  for (const f of files) {
    let assigned = null;
    for (const r of sorted) {
      if (r === "") {
        assigned = "";
        break;
      }
      if (f.path.startsWith(r)) {
        assigned = r;
        break;
      }
    }
    if (assigned == null) continue; // outside all roots (only matters when no roots)
    map.get(assigned).push(f);
  }
  return map;
}

function findSkillMd(rootFiles, rootPath) {
  for (const f of rootFiles) {
    const base = f.path.split("/").pop() || "";
    if (base.toLowerCase() === "skill.md") {
      // must be directly in the root dir, not a nested one
      const rel = f.path.slice(rootPath.length);
      if (!rel.includes("/")) return f;
    }
  }
  // fallback: any skill.md whose dir equals rootPath
  for (const f of rootFiles) {
    const base = f.path.split("/").pop() || "";
    if (base.toLowerCase() === "skill.md" && f.path.slice(0, rootPath.length) === rootPath) return f;
  }
  return null;
}

function rootDirName(rootPath) {
  if (rootPath === "") return "";
  const parts = rootPath.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "";
}

const SEV_WEIGHT = { critical: 30, high: 15, medium: 7, low: 3, info: 0 };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function scoreFindings(findings) {
  // same ruleId counts at most 3 times toward deduction
  const counts = new Map();
  let deduction = 0;
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    summary[f.severity] = (summary[f.severity] || 0) + 1;
    const c = counts.get(f.ruleId) || 0;
    if (c < 3) {
      deduction += SEV_WEIGHT[f.severity] || 0;
      counts.set(f.ruleId, c + 1);
    } else {
      counts.set(f.ruleId, c + 1);
    }
  }
  let score = 100 - deduction;
  if (score < 0) score = 0;
  return { score, summary };
}

function gradeFor(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function scanOneSkill(rootPath, rootFiles) {
  const findings = [];
  const skillMd = findSkillMd(rootFiles, rootPath);
  const skillMdText = skillMd ? decodeText(skillMd.bytes) : "";
  const skillMdPath = skillMd ? skillMd.path : rootPath + "SKILL.md";

  // relative file list (relative to root)
  const relFiles = rootFiles.map((f) => ({
    rel: rootPath === "" ? f.path : f.path.slice(rootPath.length),
    file: f,
  }));

  // ---- frontmatter ----
  let fm = null;
  let fmInfo = null;
  if (skillMd) {
    fmInfo = parseFrontmatter(skillMdText);
    fm = fmInfo.present ? fmInfo.data : null;
  }

  // total bytes
  let totalBytes = 0;
  for (const f of rootFiles) totalBytes += f.bytes.length;

  // -----------------------------------------------------------------------
  // QUALITY: QUA-001 SKILL.md missing / empty
  // -----------------------------------------------------------------------
  if (!skillMd) {
    findings.push(
      finding(
        "QUA-001",
        "critical",
        "quality",
        "SKILL.md missing",
        "No SKILL.md was found for this skill. A skill must have a SKILL.md at its root.",
        rootPath + "SKILL.md",
        null,
        null
      )
    );
  } else {
    // body = everything after frontmatter
    let body = skillMdText;
    if (fmInfo && fmInfo.present) {
      const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(
        skillMdText.charCodeAt(0) === 0xfeff ? skillMdText.slice(1) : skillMdText
      );
      if (m) body = (skillMdText.charCodeAt(0) === 0xfeff ? skillMdText.slice(1) : skillMdText).slice(m[0].length);
    }
    if (body.trim().length < 20) {
      findings.push(
        finding(
          "QUA-001",
          "high",
          "quality",
          "SKILL.md body is empty",
          "The SKILL.md has essentially no content. Document what the skill does and when to use it.",
          skillMd.path,
          null,
          null
        )
      );
    }

    // -----------------------------------------------------------------------
    // QUA-002 frontmatter presence / parse / required keys
    // -----------------------------------------------------------------------
    if (!fmInfo.present) {
      findings.push(
        finding("QUA-002", "high", "quality", "Frontmatter missing",
          "SKILL.md has no YAML frontmatter block. Add a --- fenced block with name and description.",
          skillMd.path, 1, null)
      );
    } else {
      if (fmInfo.parseError) {
        findings.push(
          finding("QUA-002", "high", "quality", "Frontmatter not parseable",
            "The frontmatter block has lines that aren't simple key: value pairs.",
            skillMd.path, 1, null)
        );
      }
      if (!fm || !("name" in fm) || String(fm.name).trim() === "") {
        findings.push(
          finding("QUA-002", "high", "quality", "Frontmatter missing 'name'",
            "The frontmatter must declare a 'name'.", skillMd.path, 1, null)
        );
      }
      if (!fm || !("description" in fm) || String(fm.description).trim() === "") {
        findings.push(
          finding("QUA-002", "high", "quality", "Frontmatter missing 'description'",
            "The frontmatter must declare a 'description' so the agent knows when to use the skill.",
            skillMd.path, 1, null)
        );
      }

      // -----------------------------------------------------------------------
      // QUA-003 name format
      // -----------------------------------------------------------------------
      if (fm && fm.name && String(fm.name).trim() !== "") {
        const name = String(fm.name).trim();
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
          findings.push(
            finding("QUA-003", "medium", "quality", "Name is not kebab-case",
              "The name '" + name + "' should be lowercase kebab-case (letters, digits, single hyphens).",
              skillMd.path, 1, null)
          );
        }
        const dirName = rootDirName(rootPath);
        if (dirName && name !== dirName) {
          findings.push(
            finding("QUA-003", "low", "quality", "Name doesn't match directory",
              "Frontmatter name '" + name + "' differs from the skill directory '" + dirName + "'.",
              skillMd.path, 1, null)
          );
        }
        if (name.length > 64) {
          findings.push(
            finding("QUA-003", "low", "quality", "Name is too long",
              "The name exceeds 64 characters.", skillMd.path, 1, null)
          );
        }
      }

      // -----------------------------------------------------------------------
      // QUA-004 description quality
      // -----------------------------------------------------------------------
      if (fm && "description" in fm) {
        const desc = String(fm.description || "");
        if (desc.trim().length > 0 && desc.trim().length < 20) {
          findings.push(
            finding("QUA-004", "medium", "quality", "Description too short",
              "The description is under 20 characters. Explain what the skill does and when to use it.",
              skillMd.path, 1, null)
          );
        }
        if (desc.length > 1024) {
          findings.push(
            finding("QUA-004", "low", "quality", "Description too long",
              "The description exceeds 1024 characters.", skillMd.path, 1, null)
          );
        }
        if (desc.trim().length >= 20 && !/use when|trigger|use this skill|when the user/i.test(desc)) {
          findings.push(
            finding("QUA-004", "low", "quality", "Description lacks trigger guidance",
              "The description doesn't say when to use the skill (no 'use when' / 'trigger' / 'when the user'). This hurts skill selection.",
              skillMd.path, 1, null)
          );
        }
        if (/\bI\s+(can|will)\b/i.test(desc)) {
          findings.push(
            finding("QUA-004", "low", "quality", "Description written in first person",
              "Descriptions should be written for the agent, not first person ('I can/I will').",
              skillMd.path, 1, null)
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // QUA-005 SKILL.md too long
    // -----------------------------------------------------------------------
    const bodyLineCount = splitLines(body).length;
    const wordCount = (body.match(/\S+/g) || []).length;
    if (wordCount > 5000) {
      findings.push(
        finding("QUA-005", "medium", "quality", "SKILL.md is very long",
          "The body exceeds 5000 words. Move detail into referenced files (progressive disclosure).",
          skillMd.path, null, null)
      );
    } else if (bodyLineCount > 500) {
      findings.push(
        finding("QUA-005", "low", "quality", "SKILL.md is long",
          "The body exceeds 500 lines. Consider splitting into referenced files.",
          skillMd.path, null, null)
      );
    }

    // QUA-006 broken relative references
    ruleQua006(skillMd, skillMdText, relFiles, findings);
  }

  // -----------------------------------------------------------------------
  // QUA-007 junk files
  // -----------------------------------------------------------------------
  const junk = [];
  for (const rf of relFiles) {
    const rel = rf.rel;
    const b = rel.split("/").pop();
    if (
      b === ".DS_Store" ||
      b === "Thumbs.db" ||
      /^\._/.test(b) || // AppleDouble resource-fork copies (._foo)
      /(^|\/)__pycache__\//.test(rel) ||
      /\.pyc$/.test(rel) ||
      /(^|\/)\.git\//.test(rel) ||
      /(^|\/)node_modules\//.test(rel) ||
      /\.log$/.test(rel)
    ) {
      junk.push(rel);
    }
  }
  if (junk.length) {
    findings.push(
      finding("QUA-007", "low", "quality", "Junk files present",
        "Bundle contains files that shouldn't ship: " + junk.slice(0, 10).join(", ") + ".",
        skillMdPath, null, null)
    );
  }

  // -----------------------------------------------------------------------
  // QUA-008 oversized bundle
  // -----------------------------------------------------------------------
  if (totalBytes > 10 * 1024 * 1024) {
    findings.push(
      finding("QUA-008", "medium", "quality", "Bundle is very large",
        "Total bundle size exceeds 10 MB.", skillMdPath, null, null)
    );
  }
  const codeCount = relFiles.filter((f) => ["py", "sh", "js", "mjs", "ts"].includes(extOf(f.rel))).length;
  if (codeCount > 30) {
    findings.push(
      finding("QUA-008", "info", "quality", "Many code files",
        "This bundle has more than 30 code files — consider splitting the skill.", skillMdPath, null, null)
    );
  }
  for (const rf of relFiles) {
    if (isTextFile(rf.file) && rf.file.bytes.length > 1024 * 1024) {
      findings.push(
        finding("QUA-008", "low", "quality", "Large text file",
          "'" + rf.rel + "' is over 1 MB.", rf.file.path, null, null)
      );
    }
  }

  // -----------------------------------------------------------------------
  // QUA-010 binary blobs
  // -----------------------------------------------------------------------
  for (const rf of relFiles) {
    if (isTextFile(rf.file)) continue;
    const media = isMediaFile(rf.rel);
    if (media) {
      findings.push(
        finding("QUA-010", "info", "quality", "Media file",
          "'" + rf.rel + "' is a media/binary asset.", rf.file.path, null, null)
      );
    } else if (rf.file.bytes.length > 100 * 1024) {
      findings.push(
        finding("QUA-010", "medium", "quality", "Opaque binary blob",
          "'" + rf.rel + "' is a non-media binary over 100 KB. Binaries can hide arbitrary behavior — review or remove.",
          rf.file.path, null, null)
      );
    }
  }

  // -----------------------------------------------------------------------
  // SECURITY rules + QUA-009 need per-text-file scanning
  // -----------------------------------------------------------------------
  const mdTexts = [];
  for (const rf of relFiles) {
    const f = rf.file;
    if (!isTextFile(f)) continue;
    const text = decodeText(f.bytes);
    const isMd = extOf(f.path) === "md";
    const isSkillMd = skillMd && f.path === skillMd.path;
    if (isMd) mdTexts.push(text);

    // guard enormous text just in case
    const safeText = text.length > 2 * 1024 * 1024 ? text.slice(0, 2 * 1024 * 1024) : text;

    // security rules
    if (isMd || isTextFile(f)) {
      ruleSec001(f, safeText, !!isSkillMd, findings);
    }
    ruleSec002(f, safeText, findings);
    ruleSec003(f, safeText, findings);
    ruleSec004(f, safeText, findings);
    ruleSec005(f, safeText, findings);
    ruleSec006(f, safeText, findings);
    ruleSec007(f, safeText, findings);
    ruleSec008(f, safeText, findings);
    ruleSec009(f, safeText, findings);
    ruleSec010(f, safeText, isMd, findings);
  }

  // QUA-009 scripts without mention
  ruleQua009(relFiles, mdTexts, skillMdPath, findings);

  // -----------------------------------------------------------------------
  // CAPABILITIES (informational)
  // -----------------------------------------------------------------------
  const capMap = new Map();
  for (const rf of relFiles) {
    const f = rf.file;
    if (!isTextFile(f)) continue;
    const text = decodeText(f.bytes);
    const lines = splitLines(text);
    for (const det of CAP_DETECTORS) {
      for (let i = 0; i < lines.length; i++) {
        det.re.lastIndex = 0;
        if (det.re.test(lines[i])) {
          if (!capMap.has(det.id)) capMap.set(det.id, { id: det.id, label: det.label, evidence: [] });
          const cap = capMap.get(det.id);
          if (cap.evidence.length < 5) cap.evidence.push({ file: f.path, line: i + 1 });
          // one detection per file for evidence economy: break after first line hit per file
          break;
        }
      }
    }
  }
  const capabilities = Array.from(capMap.values());

  // -----------------------------------------------------------------------
  // finalize
  // -----------------------------------------------------------------------
  // sort findings: severity desc, then file
  findings.sort((a, b) => {
    const s = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (s !== 0) return s;
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return (a.line || 0) - (b.line || 0);
  });

  const { score, summary } = scoreFindings(findings);
  const grade = gradeFor(score);

  // name resolution
  let name = "(unknown)";
  if (fm && fm.name && String(fm.name).trim() !== "") name = String(fm.name).trim();
  else if (rootDirName(rootPath)) name = rootDirName(rootPath);

  return {
    rootPath,
    name,
    score,
    grade,
    summary,
    findings,
    capabilities,
    meta: {
      fileCount: rootFiles.length,
      totalBytes,
      skillMdBytes: skillMd ? skillMd.bytes.length : 0,
      frontmatter: fm,
    },
  };
}

// ---------------------------------------------------------------------------
// scanFiles — top level
// ---------------------------------------------------------------------------

async function scanFiles(files) {
  const scannedAt = new Date().toISOString();
  let normalized = [];
  try {
    normalized = (files || [])
      .filter((f) => f && f.path != null && f.bytes != null)
      .map((f) => ({
        path: String(f.path).replace(/\\/g, "/").replace(/^\/+/, ""),
        bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes),
      }))
      // drop directory-looking entries
      .filter((f) => f.path !== "" && !f.path.endsWith("/"))
      // drop macOS zip packaging artifacts: __MACOSX/ subtrees hold AppleDouble
      // resource forks (._SKILL.md etc). They're garbage bytes, and their
      // ._SKILL.md entries would otherwise be detected as a second skill root.
      .filter((f) => !/(^|\/)__MACOSX\//i.test(f.path));
  } catch {
    normalized = [];
  }

  let skills = [];
  try {
    const roots = detectRoots(normalized);
    if (roots.length === 0) {
      // synthetic single report covering everything, with QUA-001 critical
      const rep = scanOneSkill("", normalized);
      // ensure a QUA-001 missing finding is present (scanOneSkill already adds it
      // because findSkillMd returns null when no skill.md)
      skills = [rep];
    } else {
      const map = assignFilesToRoots(normalized, roots);
      for (const root of roots) {
        const rf = map.get(root) || [];
        skills.push(scanOneSkill(root, rf));
      }
      // stable order by rootPath
      skills.sort((a, b) => (a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0));
    }
  } catch (e) {
    // never throw out of scanFiles; degrade to an error report
    skills = [
      {
        rootPath: "",
        name: "(scan error)",
        score: 0,
        grade: "F",
        summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        capabilities: [],
        meta: { fileCount: normalized.length, totalBytes: 0, skillMdBytes: 0, frontmatter: null },
      },
    ];
  }

  return { version: VERSION, scannedAt, skills };
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

globalThis.SkillScanner = { scanFiles, parseZip, VERSION, RULES };

export { scanFiles, parseZip, VERSION, RULES };
