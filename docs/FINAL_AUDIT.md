# Final repository and submission audit

## Source and scope

The source of truth is the **student-provided** `Autonomous-Software-Agents(3).zip`, whose Git metadata identifies branch `feature/llm-agent` and HEAD `9b9f797` (`update agent`). This release is **documentation, packaging, and reproducibility work only**: `src/` has not been modified. No new game policy, benchmark interpretation, or official API support is introduced.

## Security and packaging

**Important finding:** the original user-uploaded ZIP contained a private `.env`, Git history, a bundled `node_modules`, historical raw JSONL logs, and local game-validation outputs. The final ZIP intentionally excludes **all of these**. The source's historical `docs/` notes and unit tests are retained for traceability. The `.env.example` contains only empty token placeholders.

Some generated course-validation JSON results were **already tracked in the original Git index**. A `.gitignore` rule does not retroactively untrack them. Before publishing the repository, make a backup of the original local output directory, then run from the repo root:

```bash
git rm -r --cached --ignore-unmatch course-validation-results benchmark-results ablation-results course-audit logs
```

This removes the paths **from the Git index only**, while leaving the actual local files untouched. Commit that index change along with the new documentation and `.gitignore`. This does **not** remove anything that might already exist in older Git commits; if any secret was previously committed, review history and rotate it before making the repository public. Never publish the original uploaded ZIP.

## Automated and static checks

| Check | Result | Scope |
| --- | --- | --- |
| Automated Node tests | **267/267 passed** | Existing 263 tests + 4 new release preflight tests |
| Strict JS typechecking | **Passed** | `tsc -p jsconfig.json` using installed TypeScript 5.8.3 in this container |
| Final release evidence reconciliation | **Passed** | C0/C1 samples, score averages, 4 live scenario summaries |
| Local game validation | **4/4 scenarios, 60/60 checks** | Recorded on user's Mac; original results summarized in `evidence/` |
| Comparative ablation | **10/10 valid trials per condition** | Recorded on user's Mac; unpaired, randomized order |
| Clean `npm ci` in sandbox | **NOT VERIFIED** | npm registry DNS unavailable; installation attempt timed out |
| Real Deliveroo.js / Ollama / online PDDL in sandbox | **NOT RUN** | Requires user's game server, local model and network |
| Official instructor Challenge, LLM/MCP contracts | **NOT VERIFIED** | Actual unpublished specs and grader unavailable |

**Testing integrity:** Node tests here used the **dependency files from the uploaded ZIP**, extracted into a temporary working directory. They passed on the frozen source plus release tooling. This is **not** a validated fresh `npm ci` or a new live-game experiment. The shipped ZIP excludes those dependencies so they must be installed normally on the recipient's machine. `npm run typecheck` now requests pinned compiler version **5.8.3** via `npx` for future online reproducibility.

## Documentation and reproducibility changes

- Replaced the cumulative milestone README with current-purpose overview, architecture, installation, manual usage, evaluation, and limitations.
- Updated `.env.example` with nonsecret local defaults for two independent tokens, Qwen/Ollama, JSON tool mode and optional cooperation.
- Added `docs/SETUP.md`, `docs/DEMO.md`, `docs/EVIDENCE.md` and `docs/INDEX.md`.
- Added `npm run release:check` (checks tracked outputs, sanitized evidence, report/slides presence, token placeholders).
- Added curated `evidence/` with original local trial scores and outcome summaries; **raw logs stay private**.
- Included the existing **10-page professor report** (no internal stage references, no bibliography) and a 10-slide presentation. The deck was updated to remove an internal stage label without modifying its factual results.

## Items to complete on student's Mac

1. Apply the patch or use the clean ZIP, run `npm ci`, `npm test`, `npm run typecheck`, `npm run release:check`.
2. Confirm Deliveroo.js and the configured Ollama model start from the final path, then rerun `course:validate` (local nonofficial evidence) if time permits.
3. Check `git status` and untrack any existing generated results, as described above. Ensure `git ls-files .env` prints nothing.
4. Add real author/team names, student IDs and the final commit hash in the report/presentation before submission.
5. Confirm the **official** submission instructions, deadline, instructor's LLM/tool requirements, and evaluator contract with the course staff.
6. Keep private raw logs separately. Do not publish JWTs, private `.env`, or unreviewed third-party tool outputs.

## Submission package contents

`submission/Final_Report_10_Pages.pdf` and `.docx` are the professor-facing report; `submission/Final_Presentation.pptx` and `.pdf` are the 10-slide deck. The remaining release source and documentation show how to run and reproduce the work. The extended beginner guide is for personal study and is deliberately **not** part of the professor's concise submission package.
