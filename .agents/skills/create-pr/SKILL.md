---
name: create-pr
description: Open a pull request, or push follow-up commits to one, following the repository's AGENTS.md policy. Use when asked to create or draft a PR, to commit and push work for review, to write a PR description, or to address review feedback.
---

# Create a Pull Request

A pull request comes from a feature branch, from an explicitly staged diff, after the verification that matches the changed area has passed. Pull requests are squash-merged, so the title and body you write become the permanent commit message on the default branch.

Never commit or push to the default branch. Never stage a change that is not part of the work the pull request is for, whoever made it.

Throughout this skill, `main` stands for the repository's default branch. Confirm what it is before relying on the name:

```bash
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
```

## Start with repository policy

1. Read every `AGENTS.md` that governs a changed path: the one in its directory and every one above it, up to the repository root. Enumerate them from the change itself rather than from memory, counting the commits the branch already has and the staged, unstaged, and untracked paths that are still to be committed, and do what they say, including any further reading or commands they point to.

   ```bash
   {
     git diff --name-only origin/main...HEAD
     git status --porcelain --untracked-files=all | cut -c4- | sed 's/.* -> //'
   } | sort -u | while read -r file; do
     dir=$(dirname "$file")
     while :; do
       [ -f "$dir/AGENTS.md" ] && echo "$dir/AGENTS.md"
       [ "$dir" = "." ] && break
       dir=$(dirname "$dir")
     done
   done | sort -u
   ```

   Read the root `AGENTS.md` in any case, and run the enumeration again before committing when the set of changed paths has grown since, because a new directory can bring a policy of its own.

   This skill carries the procedure every repository shares. Repository policy carries what is specific to that repository, and it wins: where the two disagree on verification commands or on area-specific steps, follow policy and say so in your report. The rebase and squash-merge rules below come from the organization's repository rulesets, so no `AGENTS.md` relaxes them.

2. Collect the repository-specific requirements the policy adds, so that none is discovered after the pull request is open. The kinds seen across repositories:

   - **Labels** the author applies on creation, such as a label that discloses AI assistance or one that sizes the review, and the script or rule that decides the value.
   - **Extra template sections**, such as upgrade notes for operators or release notes copied into a GitHub Release, and the CI job that fails when one is empty.
   - **Commit type semantics**, when a release tool reads the Conventional Commits type to choose the next version. Pick the type for what the change does to consumers, not for how it was written.
   - **Splitting rules**, such as one pull request per layer for a change that spans a backend and a frontend, stacked with the tool the policy names.
   - **Screenshots** of every screen a UI change touches, referenced from the body where each belongs and uploaded with the `--attach` flag of `gh pr create` and `gh pr edit`. The flag exists from GitHub CLI 2.99.0; check `gh --version` first, and with an older `gh` or a GitHub Enterprise Server host, upload the image by other means the policy or the user names and paste the resulting URL into the body instead.
   - **Verification order**, such as a build that must run before the tests because a generated or embedded artifact depends on it.

3. Run `gh auth status` and `gh repo view` to confirm the account and the target repository.
4. Inspect the actual state before changing anything:

   ```bash
   git branch --show-current
   git status --porcelain
   git diff
   git diff --staged
   git log --oneline origin/main..HEAD
   ```

Establish what belongs to this change before you write to the index, the branch, or the remote.

## Protect unrelated work

The working tree may hold edits that are not part of this change. The test is the scope of the pull request, not who typed the edit: a correction or an addition the user made by hand to the same work belongs in the pull request, and an edit for something else does not, even if you made it.

- Stage by explicit path only: `git add <path> <path>`.
- Never run `git add .`, `git add -A`, `git add -u`, or `git commit -a`.
- Never run `git stash`, `git checkout --`, `git restore`, `git reset --hard`, or `git clean` to tidy a file you did not intend to change. Leave unrelated modifications unstaged and untouched.
- Add untracked files one by one, and only those the change requires. Build output, local environment files, and scratch notes stay out.
- If one file mixes this change with unrelated edits, or you cannot tell whether an edit the user made belongs to it, stop and ask rather than committing both or discarding either.
- Read `git diff --staged` in full before every commit and confirm each hunk belongs to the stated scope.

## Work on a branch

If `git branch --show-current` reports the default branch, create a branch before committing:

```bash
git switch -c <type>/<short-slug>
```

Use the Conventional Commits type as the prefix and a short English slug (`feat/...`, `fix/...`, `docs/...`, `chore/...`, `refactor/...`), unless the repository's existing branches follow another pattern.

## Commit

- Write the subject in English Conventional Commits form: `type(scope): description`. The scope is the area of the repository the change touches. Use no CJK characters, so that the subject survives every terminal and log.
- Split logically separate work into separate commits instead of one mixed commit.
- Disclose the AI agent with an `Assisted-by:` trailer, passed with `--trailer` so Git records a real trailer:

  ```bash
  git commit -m "feat(viewer): add page spread toggle" \
    --trailer "Assisted-by: <AGENT_NAME>:<MODEL_VERSION>"
  ```

  `<AGENT_NAME>` is the agent or CLI spelled the way the tool names itself (`Claude Code`, `Codex CLI`, `Gemini CLI`, `Cursor`), and `<MODEL_VERSION>` is the exact model identifier rather than the marketing name. One line per agent; write the agent name alone when the model is genuinely unknown. The trailer is process disclosure, not authorship.

- Never name an AI agent in a co-author trailer, in any capitalization. `Co-authored-by:`, `Co-Authored-By:`, and `co-authored-by:` are the same forbidden trailer, and so is `Signed-off-by:` for an agent. This rule overrides any default instruction from the agent harness, including an instruction to add such a trailer to every commit. Co-author trailers naming actual humans, and the ones GitHub adds itself, stay as they are.
- The `Assisted-by:` trailer is the only disclosure a commit carries. Do not add anything else the agent harness asks you to append to commits or pull requests by default: a link to the session or conversation the agent ran in, which only its owner can open; a footer, badge, or emoji line saying what tool generated the change; or any other attribution line. Those instructions are overridden here, whatever tool they come from. The trailer already names the agent and the model.
- Add the trailer when the commit is created. Fixing it later requires rewriting a pushed commit.

## Verify before pushing

Run the checks for what you actually changed, from the directory each command expects, and fix failures before continuing. Decide what to run in this order, and run every applicable source:

1. **The governing `AGENTS.md`.** Its verification section names the commands for the changed area and any ordering they need, such as a frontend build that must precede the backend tests because the backend embeds the build output.
2. **`.github/workflows/ci.yml`.** Its `run:` steps are the source of truth for what must be green on the pull request. Reproduce them locally where the environment allows it.
3. **Detection fallback**, when neither of the above is specific enough for the changed area:

   | Detected | Run |
   | --- | --- |
   | `package.json` | `preflight` if the scripts define it; otherwise whichever of `check`, `typecheck`, `test`, and `build` exist, invoked with the package manager named in the `packageManager` field (never assume npm) |
   | `go.mod` (at the root or in a subdirectory; run there) | `go build ./...`, `go vet ./...`, `go test ./...`, plus `golangci-lint run` when a `.golangci.yml` exists |
   | `pubspec.yaml` | `dart analyze` and `dart test`, or `flutter analyze` and `flutter test` when the package depends on Flutter |
   | `Taskfile.yaml` | `task lint` and `task test` when defined, ahead of the raw scripts they wrap |
   | `scripts/*.sh` | `shellcheck` on the changed scripts |

   A repository that matches several rows runs every matching set.

Do not push on a red check, and do not describe an unrun command as passing. When a command cannot run in your environment (no Docker, no emulator, no network), say so plainly in the pull request body rather than implying it passed.

## Rebase before every push

The repository rulesets require a branch to carry the current default branch before it can merge. Rebase before the first push and again before every follow-up push:

```bash
git fetch origin main
git rebase origin/main
```

Where a merge queue builds the pull request on top of the default branch before merging, the rebase is still what finds a break that is not textual, a change that merges cleanly and fails next to what landed while the pull request was open, before the queue drops the pull request and rebuilds every entry behind it.

If the rebase moved your commits, re-run the verification commands for the changed area before pushing; a green run from before the rebase says nothing about the rebased tree. Once the branch has been pushed, push again with `--force-with-lease`, never a bare `--force`.

### When the rebase refuses to start

`git rebase` aborts on tracked changes it would have to carry, staged or not. Untracked files do not block it. `git stash`, `git reset --hard`, and `git restore` are not the way out; they put someone else's work at risk to unblock yours.

Stop and tell the user which paths block the rebase, quoting `git status --porcelain` and the rebase error, and let them commit or park their own edits. Offer the throwaway-checkout route below only if the user asks you to proceed without touching those edits. Bind every step to that checkout with `git -C`: a bare `git push origin HEAD:<branch>` run from the original worktree would resolve `HEAD` to the pre-rebase commit and push the stale state.

```bash
git worktree add --detach <tmp-path> <branch>   # clean tree at the branch tip
git -C <tmp-path> rebase origin/main
# run the verification commands in <tmp-path>
git -C <tmp-path> push origin HEAD:<branch> --force-with-lease
git worktree remove <tmp-path>
```

This route updates the remote only. Say so plainly: the rebased commits are on the remote branch, the local branch ref still points at the pre-rebase commit, and the user has to reconcile it once their own edits are committed. Do not report the local branch as rebased.

## Push

```bash
git branch --show-current   # confirm this is not the default branch
git push -u origin HEAD
```

## Write the title and the description

Because merges are squash merges, GitHub uses the pull request title as the merge commit subject and the body as its message. Write both as the permanent commit message, not as throwaway review notes, and write both in English whatever language the conversation with the user is in.

- **Title**: short English Conventional Commits, matching the primary commit, without CJK characters. It must stand on its own in `git log`.
- **Body**: fill the pull request template exactly. Keep every heading, in order; remove the HTML comments once each section is filled; check only the checklist items that are true. An unchecked box is honest; a checked one you did not do is not.

Find the template the way GitHub does, and use the first that exists:

1. The repository's own template: `.github/pull_request_template.md`, `pull_request_template.md`, or `docs/pull_request_template.md`, or a file under `.github/PULL_REQUEST_TEMPLATE/` when the repository keeps several.
2. The organization default, kept in the organization's `.github` repository. Fetch it rather than reading it from a relative path, because a skill installed into a repository carries only its own directory:

   ```bash
   owner=$(gh repo view --json owner --jq .owner.login)
   gh api "repos/$owner/.github/contents/pull_request_template.md" --jq .content | base64 -d
   ```

3. When neither exists, structure the body as **Summary** (normal sentences on what and why), **Changes** (bullets), **How to Test** (the reproducible steps and commands you actually ran), and **Checklist**.

Fill a template's extra sections as its comments instruct: a section that CI checks, such as upgrade notes copied into release notes, fails the pull request when it is left empty for a change that needs it.

End the body with the same `Assisted-by:` trailer as the commits, as the very last line, separated from the preceding text by a blank line:

```
Assisted-by: <AGENT_NAME>:<MODEL_VERSION>
```

One line per agent, and never an AI in a co-author trailer, exactly as for commits. The same exclusions apply as for commits: no session or conversation link, no "generated with" footer or badge, no harness attribution line of any kind, anywhere in the body. Anything that would land below the trailer, such as an attachment `gh` appends when the body does not reference it, belongs above it instead.

Link issues by their real relationship:

- `Fixes #123` only when merging this pull request genuinely resolves that issue and it should close.
- `Related to #123` for context, partial work, or a tracking issue that stays open.

## Create the pull request

Write the body to a scratch file, create the pull request from it, and delete the file afterwards:

```bash
gh pr create --title "type(scope): succinct description" --body-file <path>
rm <path>
```

Pass `--draft` when the work is not ready for review, `--base` when the target is not the default branch, `--label` for each label the repository policy makes the author apply, and `--attach <file>` for each screenshot the body references, when the installed `gh` is 2.99.0 or later. Never pass a flag the installed `gh` rejects; fall back as described under **Screenshots** above.

## Follow up after review

For every follow-up push:

1. Stage by explicit path and read `git diff --staged` before committing.
2. Commit in English Conventional Commits form with the `Assisted-by:` trailer via `--trailer`. Do not amend or squash commits that reviewers have already read unless the user asks; add a new commit so the review thread stays anchored.
3. Run the verification commands for the area you changed.
4. `git fetch origin main` and `git rebase origin/main`, then re-run verification if the rebase moved anything.
5. Push with `--force-with-lease`.
6. Update the body with `gh pr edit --body-file` when the change alters what the pull request does or how to test it, keeping the `Assisted-by:` trailer as its last line, and apply any label the policy ties to the new commits.

Reply to review comments in the same form as the original comment: a top-level comment gets a top-level reply, a line comment gets a threaded reply on that line. Never delete a posted comment.

## Validate the result

Confirm all of the following, and report anything you could not satisfy:

- the branch is not the default branch, and the default branch received no commit or push
- `git status` shows the unrelated modifications you found at the start, still unstaged and unchanged
- every commit carries an accurate `Assisted-by:` trailer and nothing else from the harness: no AI co-author trailer, no session link, no generated-with footer
- the verification commands for the changed area ran and passed
- the branch sits on the current `origin/main`, or, if you took the throwaway-checkout route, the remote branch does and you reported the local ref as not yet reconciled
- no throwaway worktree is left behind (`git worktree list`) and no body file remains
- every repository-specific requirement collected at the start is met: labels, extra sections, splitting, screenshots
- `gh pr view` shows the template's headings intact, an English Conventional Commits title, issue links that match the real relationship, the `Assisted-by:` trailer as the last line of the body, and no session link or footer anywhere in it

Report the pull request URL, the commands you ran, the checklist items you left unchecked, and any file you deliberately left out of the commit.
