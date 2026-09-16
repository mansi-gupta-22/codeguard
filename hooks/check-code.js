// hooks/check-code.js  (v0.9.1 — PreToolUse rewrite)
//
// Gemini is used for ONE job only: reading and reporting on big files.
// It never writes fixes. Fixing is always Claude's job.
//
// v0.9.1 change from v0.9.0: this now runs as a PreToolUse hook instead of
// PostToolUse, so it checks the PROPOSED content before it's written —
// blocking actually prevents the write, instead of just reacting after
// the fact (PostToolUse can't undo a write that already happened).
// This means:
//   - Write tool:  tool_input.content IS the full proposed file.
//   - Edit tool:   tool_input gives old_string/new_string against whatever
//                  is CURRENTLY on disk. We simulate the replacement
//                  ourselves to get the proposed result.
//   - If old_string doesn't match the current file at all, the edit isn't
//     safely simulate-able — Claude's view of the file is stale. We block
//     on that directly and tell Claude to re-read the file, rather than
//     guessing at the danger of an orphaned new_string snippet.
//   - Syntax checking now runs against the PROPOSED content too (written
//     to a temp file), not the old on-disk file — otherwise it would be
//     checking the wrong version of the file.

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// ---- 0. Resolve proposed path + content -----------------------------------

function resolveProposed() {
  // Manual/skill invocation: node check-code.js <file> [--fix]
  if (process.argv[2] && process.argv[2] !== '--fix') {
    const p = process.argv[2];
    return { filePath: p, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' };
  }

  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (e) {
    return null;
  }
  if (!raw.trim()) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  const toolName = data?.tool_name;
  const input = data?.tool_input;
  if (!input?.file_path) return null;
  const filePath = input.file_path;

  if (toolName === 'Write') {
    return { filePath, content: input.content ?? '' };
  }

  if (toolName === 'Edit') {
    let current;
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return null; // file doesn't exist — nothing to simulate against
    }
    const oldStr = input.old_string ?? '';
    const newStr = input.new_string ?? '';

    if (oldStr && !current.includes(oldStr)) {
      console.error(`BLOCKED: old_string does not match the current content of ${filePath} — this edit is based on stale or incorrect file context. Re-read the file before retrying the edit.`);
      process.exit(2);
    }
    const proposed = oldStr ? current.replace(oldStr, newStr) : current;
    return { filePath, content: proposed };
  }

  return null;
}

const resolved = resolveProposed();
const fixMode = process.argv[3] === '--fix' || process.argv[2] === '--fix';
if (!resolved) {
  process.exit(0);
}
const filePath = resolved.filePath;
const content = resolved.content;

const ext = path.extname(filePath).toLowerCase();
const SUPPORTED = ['.py', '.js', '.ts', '.java', '.go'];
const DANGEROUS_PATTERNS = [
  { re: /\beval\(/, label: 'eval(' },
  { re: /\bos\.system\(/, label: 'os.system(' },
  { re: /\bexec\(/, label: 'exec(' },
];

const PY_CMD = process.env.CODEGUARD_PY_CMD || 'python';
const TS_CMD = process.env.CODEGUARD_TS_CMD || 'npx tsc';
const GO_CMD = process.env.CODEGUARD_GO_CMD || 'go vet';
const MAX_LINES = parseInt(process.env.CODEGUARD_MAX_LINES || '300', 10);
const apiKey = process.env.GEMINI_API_KEY;

// ---- 1. Extension filter --------------------------------------------------

if (!SUPPORTED.includes(ext)) {
  process.exit(0);
}

// ---- 2. Syntax check — against the PROPOSED content, via a temp file -----
// (Checking filePath directly would check the OLD on-disk version, since
// this hook runs before the write actually happens.)

function syntaxCheckProposed(ext, content) {
  const tmp = path.join(os.tmpdir(), `codeguard-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    if (ext === '.py') execSync(`${PY_CMD} -m py_compile "${tmp}"`, { stdio: 'pipe' });
    if (ext === '.ts') execSync(`${TS_CMD} --noEmit "${tmp}"`, { stdio: 'pipe' });
    if (ext === '.js') execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
    if (ext === '.go') execSync(`${GO_CMD} "${tmp}"`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

if (!fixMode) {
  try {
    syntaxCheckProposed(ext, content);
  } catch (err) {
    const out = (err.stdout || err.stderr || err.message || '').toString();
    console.error(`SYNTAX ERROR (proposed change to ${filePath}):\n${out}`);
    process.exit(2);
  }
}

const lines = content.split(/\r?\n/);
const isBig = lines.length > MAX_LINES;

// ---- 3. Mode split ----------------------------------------------------

if (fixMode) {
  runFixMode(filePath, content, lines);
} else if (isBig && apiKey) {
  checkWithGemini(filePath, content, lines.length, apiKey);
} else {
  checkLocally(filePath, lines, isBig);
}

// ---- Shared: find every dangerous line ------------------------------------

function findAllDangerousLines(lines) {
  const found = [];
  lines.forEach((line, idx) => {
    for (const p of DANGEROUS_PATTERNS) {
      if (p.re.test(line)) found.push({ idx, label: p.label });
    }
  });
  return found;
}

// ---- Local path (small files, or big files with no Gemini key) -----------

function checkLocally(filePath, lines, isBig, fallbackReason) {
  const found = findAllDangerousLines(lines);

  if (found.length > 0) {
    for (const f of found) {
      console.error(`BLOCKED: dangerous pattern "${f.label}" found in proposed change to ${filePath} at line ${f.idx + 1} [verified: exact regex match; full original line = ${JSON.stringify(lines[f.idx])}]`);
    }
    if (isBig) {
      const reason = fallbackReason || 'no GEMINI_API_KEY set';
      console.error(`(Checked locally instead of Gemini — ${reason}.)`);
    }
    process.exit(2);
  }
  console.log(`OK: ${filePath} passed syntax + safety check (${lines.length} lines${isBig ? ', local fallback' : ''})`);
  process.exit(0);
}

// ---- Fix mode: report known-unsafe lines for Claude to fix directly ------

function runFixMode(filePath, content, lines) {
  const found = findAllDangerousLines(lines);

  if (found.length === 0) {
    console.log(`Nothing to fix in ${filePath} — no known-unsafe patterns found by the local scan.`);
    process.exit(0);
  }

  console.log(
    `Claude should fix these lines directly:\n` +
    found.map((f) => `- line ${f.idx + 1}: "${f.label}" — ${JSON.stringify(lines[f.idx])}`).join('\n')
  );
  process.exit(0);
}

// ---- Gemini path (big files only) -----------------------------------------

const CHECK_SYSTEM_INSTRUCTION =
  'You review one source file for exactly two things: (1) unsafe patterns - eval(, ' +
  'os.system(, exec( and (2) clear formatting problems (inconsistent indentation, no ' +
  'blank line between functions, lines over 120 characters). Do not comment on syntax; ' +
  'that is checked separately, before this ever reaches you.\n\n' +
  'The file is shown to you with each line pre-numbered, like "12: os.system(cmd)". ' +
  'When you report a problem, copy the number that is already printed next to that line - ' +
  'do not count lines yourself, and do not renumber anything. This number will be used to ' +
  'jump directly to that exact line and edit it, so it must match the printed number exactly.\n\n' +
  'Reply in EXACTLY this format, nothing else, no greetings, no extra prose:\n' +
  'If you find problems:\n' +
  'STATUS: ISSUES\n' +
  'ISSUE: line <n> - <short description>\n' +
  '(one ISSUE line per problem, using the printed line number for <n>)\n\n' +
  'If there are none:\n' +
  'STATUS: CLEAR\n' +
  'SUMMARY:\n' +
  '- up to 5 bullets describing what the file does';

function buildCheckMessage(content) {
  const numbered = content
    .split(/\r?\n/)
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
  return `File content, one line number per line:\n${numbered.slice(0, 30000)}`;
}

function checkWithGemini(filePath, content, lineCount, apiKey) {
  const message = buildCheckMessage(content);
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: CHECK_SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: message }] }],
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`;

  const respond = (err, reply) => {
    if (err) {
      console.log(`Gemini check failed (${err.message}). Falling back to local check.`);
      checkLocally(filePath, content.split(/\r?\n/), true, err.message);
      return;
    }
    parseAndReport(filePath, lineCount, reply, content.split(/\r?\n/));
  };

  if (process.env.CODEGUARD_MOCK_GEMINI === '1') {
    respond(null, process.env.CODEGUARD_MOCK_RESPONSE || 'STATUS: CLEAR\nSUMMARY:\n- mocked');
    return;
  }

  const req = https.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.error) {
          return respond(new Error(json.error.message || 'unknown Gemini API error'));
        }
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return respond(new Error('Gemini returned no text'));
        respond(null, text);
      } catch (e) {
        respond(e);
      }
    });
  });
  req.on('error', respond);
  req.write(body);
  req.end();
}

function parseAndReport(filePath, lineCount, reply, fileLines) {
  if (process.env.CODEGUARD_DEBUG_REPLY === '1') {
    console.error('DEBUG - raw Gemini reply:\n' + reply + '\n--- end raw reply ---');
  }
  const isClear = /^\s*STATUS:\s*CLEAR/im.test(reply);
  const isIssues = /^\s*STATUS:\s*ISSUES/im.test(reply);

  if (isIssues) {
    const rawIssueLines = reply.split(/\r?\n/).filter((l) => /^\s*ISSUE:/i.test(l));

    if (rawIssueLines.length === 0) {
      console.error(`BLOCKED: Gemini flagged issues in ${filePath} but didn't list specifics. Review manually.`);
      process.exit(2);
    }

    let anyValid = false;
    for (const raw of rawIssueLines) {
      const text = raw.replace(/^\s*ISSUE:\s*/i, '');
      const match = text.match(/^line\s+(\d+)\s*-\s*(.*)$/i);

      if (!match) {
        console.error(`BLOCKED: ${text} (${filePath}) [line number not confirmed - format didn't match]`);
        continue;
      }

      const lineNo = parseInt(match[1], 10);
      const description = match[2];
      const inRange = lineNo >= 1 && lineNo <= lineCount;
      const lineContent = inRange ? (fileLines[lineNo - 1] || '') : '';
      const isBlank = inRange && lineContent.trim() === '';

      if (!inRange) {
        console.error(`BLOCKED: ${description} (${filePath}) [Gemini said line ${lineNo}, but file only has ${lineCount} lines - UNVERIFIED, do not jump to this line without checking]`);
        continue;
      }

      if (isBlank) {
        console.error(`BLOCKED: ${description} (${filePath}) [Gemini said line ${lineNo}, but that line is blank - UNVERIFIED, likely miscounted]`);
        continue;
      }

      anyValid = true;
      console.error(`BLOCKED: line ${lineNo} - ${description} (${filePath}) [verified: full original line ${lineNo} = ${JSON.stringify(lineContent)}]`);
    }

    if (!anyValid) {
      console.error(`(None of Gemini's reported line numbers could be verified against the actual file - do not trust them, re-check manually.)`);
    }
    process.exit(2);
  }

  if (isClear) {
    const summaryMatch = reply.match(/SUMMARY:\s*([\s\S]*)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : '(no summary text returned)';
    console.log(`OK: ${filePath} (${lineCount} lines) — checked by Gemini, no issues.\nSummary:\n${summary}`);
    process.exit(0);
  }

  console.error(`BLOCKED: Gemini's reply for ${filePath} didn't match the expected format. Treating as unverified — review manually.`);
  process.exit(2);
}