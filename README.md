# code-guard — Claude Code plugin (Windows)

Auto syntax check + safety/format review for `.py`, `.js`, `.ts`, `.java`,
`.go` files. Fixing is always done by Claude directly.

## Gemini has exactly one job: read and report on big files

Earlier versions also let Gemini *write* fixes (mirroring Spotify's
shunt `code-writer` mode) with a full backup/revert/verification system
to make that safe. It worked, but on reflection it didn't earn its
place: by the time a line is flagged, Claude already knows the fix
pattern (`eval` → `ast.literal_eval`, `os.system` delete → `os.remove`,
etc.) exactly as well as Gemini would. There's no missing information a
round-trip to Gemini adds — so it was overhead (latency, a live-network
dependency, real bugs like lost indentation and drifted line numbers)
with no actual saving behind it. Removed in 0.9.0.

**What's left, and why it's justified:** checking a 300+ line file
requires reading all of it to know if something's wrong — that's real
work worth offloading to a cheap model. Fixing 1-20 already-known lines
isn't the same kind of work; Claude does that directly, every time.

## Bug fix — the auto/hook door wasn't actually working

Earlier versions of `hooks.json` passed `"$FILE_PATH"` as if Claude Code set
that as an environment variable. **It doesn't.** Claude Code sends the file
path as JSON piped to the hook's stdin instead — there is no `$FILE_PATH`
variable. The hook was firing, but the script always received an empty
argument and did nothing. This is now fixed: `check-code.js` reads the file
path from stdin JSON (`{"tool_input":{"file_path":"..."}}`) when no
command-line argument is given. Manual/skill invocation (`node
hooks/check-code.js somefile.py`) is unaffected — that still works exactly
as before.

## Second bug fix — Claude wasn't actually receiving the block message

Even after the stdin fix, the auto/hook door had one more problem: the
script exited with code 1 for `BLOCKED`/`SYNTAX ERROR`. Per Claude Code's
hook contract, for `PostToolUse` hooks **only exit code 2** gets its
stderr message shown to Claude — exit code 1 is a "non-blocking error"
shown to *you* in the terminal but never passed to Claude's context at
all. So Claude genuinely never saw the line number it had just reported
to you, and had to re-derive the problem from scratch when asked to fix
it. Fixed: the script now exits 2 on every blocked case, so Claude
receives the exact line/description as real feedback and can fix it
directly without re-reading the file.

## How it works — the script only ever detects and reports

**1. Syntax check** — always local (`python -m py_compile`, `tsc`, `node --check`,
`go vet`), regardless of file size. This is a free subprocess call, not AI —
there's no reason to ever route it anywhere else.

**2. Size decides who reviews for safety/formatting:**

| File | Reviewer | What it can say |
|---|---|---|
| Small, or big with no `GEMINI_API_KEY` | Local regex scan | `BLOCKED` + line number, or `OK` |
| Big (>300 lines) + `GEMINI_API_KEY` set | Gemini | `BLOCKED` + line numbers + description, or `OK` + a short summary |

Gemini is only sent the file when it's actually large enough that reading it
would be expensive for the main model. It's given a strict reply format
(`STATUS: ISSUES` / `STATUS: CLEAR`) so the script can parse it reliably — if
Gemini ever replies in some other shape, the script treats the file as
**unverified and blocks it**, rather than silently letting a big file pass.

**3. Fixing is never routed to Gemini, at any size.** When you say "fix it",
the script's `--fix` mode finds the exact unsafe lines with a free local
scan and reports each one's full original text — no network call at all.
Claude edits just those lines directly, in a normal turn, without
re-reading the whole file. That's the actual token saving: the expensive
model only ever sees a short list of exact lines, never a 600-line file.

This mirrors Spotify's shunt plugin on the read side — the cheap model's
job is narrow (bulk reading + reporting) — but diverges on writing:
here, Claude always does the actual edit, since it already has everything
it needs by the time a line is flagged.

## What's inside

```
code-guard/
  .claude-plugin/plugin.json   plugin metadata
  skills/coding-rules/SKILL.md naming/style rules + check/fix triggers
  hooks/hooks.json             auto-trigger config (fires on file edit)
  hooks/check-code.js          the check script (both triggers call this)
```

No `commands/` folder, no fix-mode in the script — both were tried, tested,
and removed because they didn't add real capability over natural-language
triggers plus Claude editing directly.

## The 2 triggers

1. **Auto** — Claude edits/writes a file → `hooks.json` fires automatically.
2. **Natural mention** — you say "check login.py" in chat → the skill
   matches your intent and runs the same script. No command to remember.

Both call `hooks/check-code.js`, so the check itself behaves identically —
only who kicked it off differs.

## Setting GEMINI_API_KEY — order matters

The check script runs as a child process **of Claude Code itself**, not
directly of your terminal. A child process only sees environment variables
that existed *before its parent started*. So:

**Do this (works):**
```powershell
$env:GEMINI_API_KEY = "your-key"
claude --plugin-dir "C:\path\to\code-guard"
```

**Not this (key won't be seen):**
```powershell
claude --plugin-dir "C:\path\to\code-guard"
$env:GEMINI_API_KEY = "your-key"
```

`$env:` only lasts for that one PowerShell window — set it again next time
you open a new one. If you'd rather set it once permanently, use
`setx GEMINI_API_KEY "your-key"` instead and reopen your terminal — but
either way, set it **before** launching Claude Code.

## Model note

Uses `gemini-3.6-flash` — the current stable Flash model as of this writing
— with the API key sent as an `x-goog-api-key` header rather than a `?key=`
URL parameter (query params are more likely to end up logged somewhere).

**Request shape:** instructions go in `system_instruction` (the model's
role), the file content goes in `contents` (the message) — kept as two
separate fields rather than one long concatenated string. The response is
also checked for an explicit `error` field before assuming success, and
for an empty text response.

**Line numbers are verified, not trusted blindly.** Two deliberate design
choices, both aimed at the same goal — that a line number Gemini reports
is reliable enough for Claude to jump straight to it without re-reading
the file:

1. The file content sent to Gemini has every line **pre-numbered**
   (`12: os.system(cmd)`). LLMs are unreliable at silently counting
   hundreds of lines in raw text — asking Gemini to copy a number it can
   already see is far more reliable than asking it to count.
2. Every line number Gemini reports back is checked against the real file
   before Claude ever sees it: is it in range, and is that line actually
   non-blank? If either check fails, the result is tagged `UNVERIFIED`
   instead of being presented as fact. Local-scan results (small files,
   or no API key) get a matching `[verified: exact regex match]` tag,
   since those come from a real regex match and are always trustworthy.

This means "fix it" can safely skip re-reading the file **only** when a
line is tagged verified — if you ever see `UNVERIFIED` in a block message,
that's the script telling you not to trust that number.

If Google ships a newer Flash model later, update the model name in the
`checkWithGemini` function in `hooks/check-code.js`.

## Requirements

- **Node.js** — required. https://nodejs.org — check with `node --version`
- **Python** — only for `.py` files. Check with `python --version`
  (if your install uses `python3`, see Settings below)
- **TypeScript** (`npx tsc`) — only for `.ts` files
- **Go** (`go vet`) — only for `.go` files
- **Gemini API key** — optional. Only used for files over 300 lines.

## Install (Windows)

1. Unzip somewhere permanent, e.g. `C:\Users\<you>\claude-plugins\code-guard`

2. (Optional) Set your Gemini key:
   ```
   setx GEMINI_API_KEY "your-key-here"
   ```
   Close and reopen your terminal after this.

3. Start Claude Code with the plugin loaded:
   ```
   claude --plugin-dir "C:\Users\<you>\claude-plugins\code-guard"
   ```

4. Test it — ask Claude to write a small file with `eval()` in it, or say
   "check <filename>" about any existing file.

## Settings (optional)

All overridable via environment variables (`setx NAME "value"` on Windows):

| Variable | Default | Purpose |
|---|---|---|
| `CODEGUARD_PY_CMD` | `python` | Change if your system uses `python3` |
| `CODEGUARD_TS_CMD` | `npx tsc` | Change if you have a global `tsc` install |
| `CODEGUARD_GO_CMD` | `go vet` | Rarely needs changing |
| `CODEGUARD_MAX_LINES` | `300` | Threshold for routing to Gemini instead of local scan |
| `GEMINI_API_KEY` | (none) | Enables Gemini review for big files. Without it, big files are checked locally instead — same detection, just no summary |
| `CODEGUARD_MOCK_GEMINI` | (unset) | Set to `1` to bypass the real API call for testing (returns `CODEGUARD_MOCK_RESPONSE` or a placeholder) |

## Editing what Gemini looks for

The exact instructions sent to Gemini live in `hooks/check-code.js` as the
`CHECK_SYSTEM_INSTRUCTION` constant near the top of the file. Edit that
string directly to change what it checks for or how it should format its
reply — just keep the `STATUS: ISSUES` / `STATUS: CLEAR` contract intact,
since the script's parser depends on it.

## Known limits

- Restart Claude Code after editing `hooks/hooks.json` — hooks don't hot-reload.
- Natural-language trigger depends on Claude recognizing your intent. If it
  ever misses an unusual phrasing, be more direct: "run a check on file.py".
- Checks are syntax + a small set of unsafe patterns (`eval(`, `os.system(`,
  `exec(`) + basic formatting — not a full security audit.
- Gemini's formatting/safety review on big files is a judgment call by an
  LLM, not a deterministic tool — treat its findings as a first pass, not
  a guarantee.
