---
name: "zephyr-pr-workflow"
description: "Manages the full PR lifecycle for the Zephyr project: branch creation, commit, push, PR creation, bot review, fixes, merge, and cleanup. Invoke when user wants to submit changes, create a PR, or follow the standard PR process."
---

# Zephyr PR Workflow

This skill defines the standard PR (Pull Request) workflow for the Zephyr project. Follow every step precisely.

## Trigger Conditions

Invoke this skill when:
- User wants to submit code changes as a PR
- User asks to create a PR
- User mentions "PR", "pull request", "merge", or "submit changes"
- User has completed development and wants to follow the standard process

## Style Rules

- **DO NOT use emoji in your messages** — the user dislikes AI overusing emoji
- Use plain text status updates instead (e.g. "PR #xxx created, waiting for bot review")
- The only emoji that matter are the **Bot reactions on GitHub PRs** (see below)

## Bot Review Emoji Signals on GitHub

When a PR is created, bots may react to it with emoji on GitHub. These are critical signals:

| Bot | Reaction | Meaning |
|-----|----------|---------|
| Codex / Gemini | eye reaction | Bot has seen the PR and WILL review it |
| Codex | eye -> thumbs-up | Review passed, no issues found |
| Either bot | Comment with suggestions | Changes requested, need to address |
| Either bot | No reaction at all | Bot may be rate-limited and will NOT review |

**IMPORTANT about the eye reaction:**
- The eye reaction is a confirmation that the bot will actually perform a review
- Codex does NOT always leave an eye — sometimes it hits rate limits and skips entirely
- If a bot leaves no reaction at all, it likely will not review (rate-limited)
- This is why monitoring for eye reactions matters: no eye = no review coming
- If one bot is rate-limited (no eye), proceed with the other bot's review only

**How to check bot reactions:**
```bash
gh api repos/{owner}/{repo}/issues/{pr-number}/reactions
```

**Workflow:**
1. After PR creation, watch for eye reactions from both bots
2. If a bot leaves an eye, it confirms review is coming — wait for it
3. If a bot leaves NO reaction after a reasonable wait, it is likely rate-limited — do not wait indefinitely
4. For Codex: if eye changes to thumbs-up, it means approval with no issues
5. Proceed when all bots that left eye reactions have completed their reviews

## Complete PR Workflow

### Phase 1: Branch Preparation

1. **Ensure you're on main and up-to-date:**
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Create a feature branch** with a descriptive name:
   ```bash
   git checkout -b <feature-branch-name>
   ```
   Branch naming convention: use lowercase-hyphenated English, e.g. `fix-gpu-detection`, `feat-aur-auto-update`

### Phase 2: Development & Commit

3. **Make code changes** as required

4. **Run local checks based on modified files** before committing:
   - Rust files (.rs): `cargo fmt --check` FIRST, then `cargo clippy` — fmt must pass before clippy
   - TypeScript/JavaScript files (.ts/.tsx/.js/.jsx): `pnpm lint`, `pnpm typecheck`
   - Shell scripts (.sh): `shellcheck`
   - Run whatever is relevant to the files you changed — do NOT skip this step
   - Fix any errors before proceeding.
   - **NEVER skip `cargo fmt --check`** — it is the most commonly forgotten check and will fail CI.

   **Settings checklist** — when adding a new setting, verify ALL three places are updated:
   1. `Settings` struct in `lib.rs` (field definition + default value)
   2. `patch_settings` in `lib.rs` (`patch_field!(setting_name)`)
   3. `appStore` initial state in `state.js` (key with default value)
   Missing any one of these causes the setting to silently not work.

5. **Commit changes** with a clear, descriptive message:
   ```bash
   git add <files>
   git commit -m "<type>: <description>"
   ```
   Commit message conventions:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `ci:` for CI/CD changes
   - `chore:` for maintenance tasks
   - `docs:` for documentation

   **CRITICAL: Commit message and PR description must describe changes relative to `main` branch, NOT relative to the previous PR iteration.** When iterating on a PR (amending commits, force-pushing), the commit message and PR body should always reflect the full diff against `main` — what problems exist in `main` that this PR fixes, and what new capabilities it adds. Do NOT describe incremental fixes made during PR review iterations.

6. **Push the branch:**
   ```bash
   git push origin <feature-branch-name>
   ```

### Phase 3: PR Creation

7. **Create PR on GitHub** using `gh` CLI:
   ```bash
   gh pr create --title "<type>: <description>" --body "<PR description>"
   ```

8. **Announce PR creation** (plain text, no emoji):
   > PR #xxx 已创建，等待 Bot 审查。

9. **Check CI status** (quick glance, do NOT wait for full completion):
   ```bash
   gh pr checks <pr-number>
   ```
   - CI will be triggered by the PR — just glance at the results
   - If any checks fail immediately, note them for fixing
   - Do NOT block on waiting for CI to finish

### Phase 4: Bot Review + CI — Actively Monitor

9. **Actively poll for bot review completion AND CI status simultaneously.** Do NOT wait for bot reviews without also checking CI.
   The potential reviewers are:
   - `gemini-code-assist[bot]`
   - `chatgpt-codex-connector[bot]`

   **Rules:**
   - Only wait for bots that confirmed they will review (left an eye reaction)
   - If a bot left NO reaction after a reasonable wait, it is rate-limited — skip it
   - Do NOT merge until all bots that left eye reactions have completed their reviews
   - If neither bot reacts, inform the user and ask how to proceed

10. **Poll for review status AND CI status every 30-60 seconds** using these commands:
    ```bash
    # Check reviews + CI status together
    echo "=== REACTIONS ===" && gh api repos/{owner}/{repo}/issues/<pr-number>/reactions --jq '.[] | "\(.user.login): \(.content)"' && echo "=== REVIEWS ===" && gh pr view <pr-number> --json reviews --jq '.reviews[] | "\(.author.login): \(.state)"' && echo "=== CI ===" && gh pr checks <pr-number> 2>&1 | head -5
    ```

    **How to determine review completion:**
    - **Codex**: eye reaction changed to thumbs-up = approved, no issues
    - **Codex**: left a review comment = has feedback, read it
    - **Gemini**: left a review (COMMENTED/APPROVED/CHANGES_REQUESTED) = done
    - If both bots that left eye reactions have completed their reviews, proceed to Phase 5

    **How to check CI status:**
    - Check `gh pr checks <pr-number>` alongside each review poll
    - If any checks fail (marked with X), investigate immediately — do NOT ignore CI failures
    - A failing lint/typecheck/build in CI must be fixed and resubmitted before merging
    - CI failures are NOT just informational — they must pass for the PR to be mergeable

    **Do NOT just wait passively** — actively check the status and act as soon as reviews are in.

11. **While waiting, inform the user:**
    > 等待 Bot 审查 + CI 中... gemini-code-assist[bot] 和 chatgpt-codex-connector[bot] 需要回复后才能合并。

### Phase 5: Handle Review Feedback

12. **Wait for ALL active bot reviews to complete BEFORE taking any action.**
    - Do NOT start fixing or pushing changes after only one bot has reviewed
    - Collect all feedback from all bots that left eye reactions first
    - Then evaluate all comments together before deciding what to change
    - If one bot is still reviewing, wait — it may have different or conflicting suggestions

13. **After all reviews are in, evaluate each comment:**
    - **Gemini Bot** may provide over-defensive suggestions — evaluate for necessity before implementing
    - **Codex Bot** suggestions are generally more practical
    - Use your judgment: implement valuable suggestions, explain why unnecessary ones are skipped
    - Present a summary of all bot feedback, then directly proceed to fix the ones worth adopting. Do NOT ask the user for permission — implement fixes immediately after presenting the summary.

    **CRITICAL: Check BOTH review body AND inline comments for each bot.**
    - Bots often leave detailed suggestions as inline comments on specific lines, NOT in the review body
    - The review body may say "no issues" or be empty, while inline comments contain actionable feedback
    - Always fetch inline comments separately:
    ```bash
    gh api repos/{owner}/{repo}/pulls/<pr-number>/comments --jq '.[] | "[\(.path):\(.line)] \(.body | split("\n")[0:3] | join("\n"))"'
    ```
    - Do NOT assume a bot has no feedback just because its review body is empty or informational

14. **ALL fixes use force-push + PR recreation**, regardless of size:
    ```bash
    # 1. Run local checks based on modified files first!
    # Rust: cargo clippy, cargo fmt --check
    # TS/JS: pnpm lint, pnpm typecheck
    # Shell: shellcheck
    # Fix any errors before proceeding

    # 2. Amend the commit (keep single commit per PR)
    git add <files>
    git commit --amend --no-edit

    # 3. Close the existing PR
    gh pr close <pr-number>

    # 4. Force-push the fixed branch
    git push origin <feature-branch-name> --force

    # 5. Recreate the PR (this triggers new bot reviews)
    gh pr create --title "<type>: <description>" --body "<PR description>"
    ```
    > 已关闭旧 PR #xxx，重新创建 PR #yyy 以触发 Bot 重新审查。

    **Why always force-push + recreate?**
    - Force-pushing does NOT trigger new bot reviews
    - Closing and creating a new PR is the only way to get fresh reviews
    - Amending keeps the commit history clean (single commit per PR)
    - Consistency: no need to decide between paths, always do the same thing

### Phase 6: Merge

14. **When all reviewers have approved**, merge the PR:
    ```bash
    gh pr merge <pr-number> --squash
    ```
    > PR #xxx 已合并。

### Phase 7: Post-Merge Cleanup

15. **Switch to main and sync:**
    ```bash
    git checkout main
    git pull origin main
    ```

16. **Delete the feature branch locally and remotely:**
    ```bash
    git branch -d <feature-branch-name>
    git push origin --delete <feature-branch-name>
    ```
    > 分支已清理完毕。

## Important Rules

1. **Only merge after all active bot reviews complete** -- wait for bots that left eye reactions; skip rate-limited bots (no reaction)
2. **Collect ALL bot feedback before taking action** -- do NOT push fixes after only one bot has reviewed
3. **Check BOTH review body AND inline comments** -- bots often leave actionable feedback only in inline comments; an empty review body does NOT mean no feedback
4. **NEVER skip local checks** -- always run clippy/eslint/fmt etc. based on modified files before committing
5. **NEVER commit unless user explicitly asks** -- only commit when told
6. **NEVER use emoji in your messages** -- user dislikes AI overusing emoji
7. **Evaluate Gemini Bot suggestions critically** -- they tend to be over-defensive
8. **Gemini Bot cannot review YAML files** -- this is a known limitation
9. **ALL fixes use force-push + PR recreation** -- no exceptions, regardless of fix size
10. **Always clean up branches after merge** -- don't leave stale branches
11. **Use squash merge** -- keeps main history clean
12. **CI failures MUST be fixed** -- check CI alongside every bot review poll; failing lint/typecheck/build is not acceptable for merge
13. **NEVER ask user for permission to continue** -- autonomously decide what to optimize and continue the workflow; only end the conversation when there are no more optimizations to submit
14. **Do NOT interrupt the workflow** -- keep polling, fixing, and resubmitting until the PR is merged or there are genuinely no more improvements needed
15. **Critically evaluate ALL bot suggestions** -- do NOT automatically implement fixes based on priority badges (high/medium/P2); high priority may be false positives or over-optimization; use your own judgment to decide whether each suggestion is genuinely valuable
16. **Consider trade-offs before implementing** -- weigh code complexity, performance impact, and actual user benefit; skip suggestions that add complexity without clear benefits
17. **You MAY fix code while waiting for bot reviews** -- if you or the user identify real issues, fix them locally; but do NOT push/submit until all bot reviews are complete
18. **NEVER close a PR or push changes while bot reviews are still pending** -- wait for ALL bots with eye reactions to complete their reviews first, then fix and resubmit
19. **ALWAYS check CI status before and after pushing** -- CI failures must be resolved before merge; do not ignore CI failures

## CRITICAL: State Machine (MUST follow in order)

The PR workflow is a strict state machine. After context compression or conversation resume, ALWAYS re-establish which state you are in before taking any action. NEVER skip states or go backwards.

```
STATE 1: DEVELOPMENT
  -> Make code changes, run local checks, commit
  -> Next: STATE 2

STATE 2: PR CREATED
  -> Push branch, create PR via gh pr create
  -> Next: STATE 3

STATE 3: WAITING FOR REVIEWS
  -> Poll for bot eye reactions and review completion
  -> You MAY fix code locally during this state (if you or user identify real issues)
  -> But do NOT commit, do NOT push, do NOT close the PR
  -> Only action allowed: polling for review status + local code fixes
  -> When ALL bots with eye reactions have completed reviews: Next: STATE 4

STATE 4: PROCESSING FEEDBACK
  -> Read ALL review comments (both review body AND inline comments)
  -> Evaluate which suggestions to implement
  -> Make code changes locally
  -> Run local checks (lint, clippy, etc.)
  -> Next: STATE 5

STATE 5: RESUBMITTING
  -> git commit --amend --no-edit
  -> gh pr close <old-pr-number>
  -> git push origin <branch> --force
  -> gh pr create (new PR)
  -> Next: STATE 3 (go back to waiting for reviews on new PR)

STATE 6: MERGING (only when reviews approve and CI passes)
  -> gh pr merge <pr-number> --squash
  -> git checkout main && git pull origin main
  -> git branch -d <branch> && git push origin --delete <branch>
  -> DONE
```

**The most common mistake is jumping from STATE 3 directly to STATE 5 without waiting for reviews to complete. This is FORBIDDEN. You MUST stay in STATE 3 until all active bot reviews are done.**

**After context compression: The FIRST thing you must do is determine which state you are in by checking the PR status and review state. Do NOT assume you know the state.**

## Special Cases

- **YAML-only changes**: Gemini Bot won't review these. Only wait for Codex Bot.
- **Urgent hotfixes**: Still follow the process, but inform user it may take time for bot reviews.
- **Draft PRs**: If user wants to create a draft first, use `gh pr create --draft`.
