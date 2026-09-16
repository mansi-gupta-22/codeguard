---
name: coding-rules
description: Naming and style rules to follow when writing or editing code. Also trigger this skill whenever the user names or gives a code file and asks to check, scan, verify, or review it — even without a slash command. Also trigger when the user says "fix it" or "fix this file" after a check has reported a problem.
---

# Coding Rules

## When user just gives a file to check
If the user mentions a file (.py, .js, .ts, .java, .go) and asks anything like
"check this", "is this safe", "scan it", "look at this file" — run:
node "${CLAUDE_PLUGIN_ROOT}/hooks/check-code.js" <file>

The script decides routing itself based on file size:
- Small file, or big file with no GEMINI_API_KEY: checked locally (syntax + a
  plain safety-pattern scan). Report BLOCKED/OK with exact line numbers.
- Big file with GEMINI_API_KEY: Gemini reviews the content for safety and
  formatting issues and reports back either a line-numbered issue list or a
  short summary. Report exactly what it says — do not re-read the file
  yourself to double check; that defeats the point of routing big files
  to Gemini in the first place.

Every verified BLOCKED line includes the full, exact original line content
(e.g. [verified: full original line 238 = "    new_price = eval(formula)"]),
not a truncated preview — that's what makes it safe to edit directly
without re-opening the file first.

This script only ever reports. It never modifies the file.

## When user says "fix it" / "fix this file"
Run: node "${CLAUDE_PLUGIN_ROOT}/hooks/check-code.js" <file> --fix

This finds the exact unsafe lines locally (free, no Gemini call at all —
fixing is always your job, regardless of file size). It reports each
line's number and full original text. Edit only those lines directly
yourself using that exact text as the match — do not re-read the whole
file first, and do not send anything to Gemini for this. Exception: if
that exact line text is not unique in the file (the same line appears
more than once), open the file to disambiguate before editing, since a
non-unique match could target the wrong occurrence.

- Python: snake_case for functions/variables, PascalCase for classes.
- JavaScript/TypeScript: camelCase for functions/variables, PascalCase for classes.
- Never use eval(), exec(), or os.system() with unsanitized input.
- Always add a docstring/comment for functions over 5 lines.
- Prefer explicit imports over wildcard imports.
