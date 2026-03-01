# TTS Reader - Ralph Agent Instructions

You are an autonomous coding agent building a TTS Reader web application.

## Project Context

Minimalist epub reader with sentence-level text-to-speech. React + Vite frontend, Fastify backend, SQLite database, pnpm monorepo. See `docs/plans/2026-03-01-tts-reader-design.md` for full design.

## Your Task

1. Read the PRD at `docs/ai/prd.json`
2. Read the progress log at `docs/ai/progress.txt` (check Codebase Patterns section first)
3. Ensure you're on the branch specified in PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story
6. Verify: `npx tsc --noEmit` passes across all packages
7. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`
8. Update docs/ai/prd.json to set `passes: true` for the completed story
9. Append your progress to `docs/ai/progress.txt`

## Quality Requirements

- ALL commits must pass TypeScript typecheck
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns
- Use the shared/ package for types shared between client and server
- Use SCSS modules for component styles
- Use Radix UI primitives for interactive components

## Progress Report Format

APPEND to docs/ai/progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
  - Useful context
---
```

## Consolidate Patterns

If you discover a **reusable pattern**, add it to the `## Codebase Patterns` section at the TOP of docs/ai/progress.txt (create if it doesn't exist). Only add patterns that are general and reusable, not story-specific.

## Stop Condition

After completing a user story, check if ALL stories have `passes: true`.

If ALL complete: reply with `<promise>COMPLETE</promise>`

If stories remain with `passes: false`: end your response normally (next iteration picks up).

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep typecheck passing
- Read Codebase Patterns in docs/ai/progress.txt before starting
