#!/usr/bin/env python3
"""Keep the open-PR backlog honest: one comment per PR, rewritten in place.

WHY THIS EXISTS
---------------
The bottleneck was never opening pull requests. It was that 23 sat open at once
and nothing said, per PR, whether it was *waiting on a decision* or merely
*parked*. Opening each one to find out is the tax that let the pile grow, so
this pays that tax once a day and writes the answer down.

Four facts per PR, and nothing else:

  1. mergeable or conflicting   - can it land at all
  2. CI state                   - where "no checks configured" is a THIRD state,
                                  distinct from pass and from fail. This repo has
                                  no workflows on `main`, so today every PR is in
                                  that third state. Reporting it as "passing" is
                                  exactly the lie this tool exists to prevent.
  3. days open / days idle      - idle is the one that matters; a PR touched
                                  yesterday is not stale at 30 days old
  4. reviewed, and BY WHOM      - see below

ONE COMMENT, REWRITTEN
----------------------
A daily comment per PR is how automation becomes wallpaper nobody reads. This
finds its own previous comment by the HTML marker below and PATCHes it. A PR
gets exactly one of these, ever, and the comment's edit history is the trail.

THE REVIEWER-FAMILY RULE
------------------------
Ivan's standing constraint: the reviewer must not share base weights with
whatever authored the change. A model reviewing its own family's output agrees
with itself, and agreement produced that way is worth nothing.

So this records both sides. Author family comes from commit trailers - evidence
written at commit time (`Co-Authored-By: Claude ... @anthropic.com`), not a
guess from the PR author login, which is always Ivan no matter which model wrote
the diff. Reviewer family comes from FAMILY_BY_LOGIN below, which is a DECLARED
mapping and not something any API reports. If a vendor swaps the base model
behind a reviewer bot, this file is wrong until a human edits it. That is a
known limit, written down here rather than hidden.

Same family on both sides is not something the tool can fix, so it does not try:
it prints a loud block on the PR, lists the PR in the run summary, and exits
non-zero. A human decides.

ZERO FINDINGS IS A RED FLAG, NOT A GREEN ONE
--------------------------------------------
"0% disagreement means the review is broken, not that the code is perfect."

Counting findings has one trap worth spelling out, because the obvious
implementation walks straight into it. On this repo every Codex review body is
byte-identical boilerplate - 621 characters of "Here are some automated review
suggestions" - and the actual findings are posted as INLINE comments on the
diff. A tool that measured the review body would score every review at zero
findings and report a perfectly healthy reviewer as dead. So findings are
counted from `pulls/{n}/comments`, the inline thread, per reviewer login.

STALE DRAFTS
------------
Two stages, never one. Stage 1 labels the PR and says so in the comment, with
the date recorded inside the comment body (`<!-- flagged: ... -->`) rather than
read back off the label, because labels carry no timestamp. Stage 2 closes it,
and only if the flag has been visible for --close-after-flag-days with nothing
touching the PR since. Real activity - a push, a human comment, Ivan saying "not
this one" - clears the flag and restarts the clock.

"Real activity" is NOT the PR's `updatedAt`; see last_activity_at(). Posting the
comment below bumps that field, so an earlier version of this tool reset its own
staleness clock on every run and could never have flagged anything.

Only DRAFTS are ever closed. A finished PR that went quiet gets flagged and
stays flagged; closing completed work because nobody looked at it is the
opposite of helpful.

Closing is reversible - the branch survives and the PR reopens - but it is still
an action on Ivan's repo without him in the loop, so --dry-run prints the
verdict and changes nothing. The first live run necessarily closes nothing:
nothing can have carried a flag for a week yet.

THIS TOOL NEVER MERGES. Merge authority is Ivan's and is not delegated here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

MARKER = "<!-- pr-backlog-report:v1 -->"
AUDIT_MARKER = "<!-- pr-merge-gate:v1 -->"
# gh --limit cuts silently; collect() refuses rather than under-report.
LIST_LIMIT = 200
FLAG_PREFIX = "<!-- flagged: "
STALE_LABEL = "stale-flagged"

# WHAT A COPILOT REVIEW COSTS: NOT A FIXED NUMBER, AND NOT KNOWN HERE.
#
# Since 2026-06-01 every Copilot plan is on usage-based billing in GitHub AI
# Credits (1 credit = $0.01). Code review is billed by TOKEN CONSUMPTION at the
# model's API rates - input, output and cached - so its cost scales with the
# size of the diff. A 2,300-token PR and a 31,000-token PR do not cost the same.
# https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
#
#   Copilot Pro   $10/mo  ->  1,000 base + 500 flex  = 1,500 credits ($15)
#   Copilot Pro+  $39/mo  ->  3,900 base + 3,100 flex = 7,000 credits ($70)
#
# Credits do NOT roll over; the allowance resets to full at 00:00:00 UTC on the
# 1st of each month.
#
# The flat "13 premium requests per review" multiplier is LEGACY ONLY. It
# applies to Pro/Pro+ subscribers on an existing ANNUAL plan who stayed on
# request-based billing after 2026-06-01. Assuming it here would be the same
# class of error as the one this constant replaced: a confident number in the
# wrong unit. It is kept named, unused, so nobody reintroduces it by accident.
CREDITS_PER_REVIEW_LEGACY_ANNUAL_ONLY = 13

# Real cost per review on the CURRENT model, if it has been measured. Leave
# unset: an unmeasured cost and a cost of zero are different claims, and the
# report must not print a percentage it cannot actually compute.
#
# To measure it: note the credits used on https://github.com/settings/billing,
# run a sweep of known size, and read the delta. Then set
# COPILOT_CREDITS_PER_REVIEW to credits-per-review and the budget line becomes
# arithmetic instead of a guess.
#
# A cost of zero is not a measurement, it is a broken config: no review is
# free. Accepting it would divide by zero in render_summary AFTER the reviews
# have already been requested, turning a typo into a crash that loses the run's
# output. Non-numeric and non-positive values are refused and reported, and the
# report falls back to saying the cost is unmeasured - which is true.
def _parse_credits_per_review(raw: str):
    raw = (raw or "").strip()
    if not raw:
        return None, None
    try:
        value = float(raw)
    except ValueError:
        return None, f"not a number: {raw!r}"
    if value <= 0:
        return None, f"must be greater than zero, got {value:g}"
    return value, None


CREDITS_PER_REVIEW, CREDITS_PER_REVIEW_ERROR = _parse_credits_per_review(
    os.environ.get("COPILOT_CREDITS_PER_REVIEW", ""))
if CREDITS_PER_REVIEW_ERROR:
    print(f"warning: ignoring COPILOT_CREDITS_PER_REVIEW - "
          f"{CREDITS_PER_REVIEW_ERROR}", file=sys.stderr)

# DECLARED, not detected. No GitHub API reports which base model sits behind a
# reviewer bot; this is a human assertion about vendor lineage, and it is the
# one place where the family rule can go quietly wrong. Edit it when a vendor
# changes what it runs underneath.
FAMILY_BY_LOGIN = {
    # OpenAI lineage
    # ⚠ `ivan-codex-reviewer` is THE estate's approving reviewer -- the only identity
    # that has ever submitted an APPROVED review on this repo -- and it was missing
    # from this table until 2026-09-04. Every consumer that asks "what family is this
    # reviewer?" got None for it, so the family half of the merge gate's independence
    # check silently did nothing for the one login it most needed to classify. Found
    # by `test_merge_gate_independence.py`, which is why that test replays real review
    # records rather than mocks: a mock would have used a login that was in the table.
    # A vendor list rots; anything added here must be added to the test's cases too.
    "ivan-codex-reviewer": "openai",
    "copilot-pull-request-reviewer": "openai",
    "copilot": "openai",
    "copilot-swe-agent": "openai",
    "chatgpt-codex-connector": "openai",
    "ivan-codex-reviewer": "openai",
    "codex": "openai",
    # Anthropic lineage
    "claude": "anthropic",
    "claude-code": "anthropic",
    "claude-bot": "anthropic",
    # Google lineage
    "google-labs-jules": "google",
    "gemini-code-assist": "google",
}

# Substrings matched against commit trailers to work out who actually wrote the
# diff. The PR author login is useless for that - it is always the human who
# pushed, whichever model produced the change.
FAMILY_BY_TRAILER = (
    ("@anthropic.com", "anthropic"),
    ("claude code", "anthropic"),
    ("claude opus", "anthropic"),
    ("claude sonnet", "anthropic"),
    ("claude haiku", "anthropic"),
    ("co-authored-by: claude", "anthropic"),
    ("@openai.com", "openai"),
    ("openai codex", "openai"),
    ("co-authored-by: codex", "openai"),
    ("github copilot", "openai"),
    ("copilot-swe-agent", "openai"),
    ("@google.com", "google"),
    ("google-labs-jules", "google"),
)


# ---------------------------------------------------------------------------
# Pure logic. Everything above the I/O banner is testable without GitHub.
# ---------------------------------------------------------------------------


# GitHub returns the SAME actor under different logins depending on the API, and
# getting this wrong is not cosmetic. The review on PR #229 is attributed to
# `copilot-pull-request-reviewer`, while the four inline findings that review
# posted are attributed to `Copilot` - so a tool that treats those as two logins
# credits the review with ZERO findings and prints "the reviewer never read the
# diff" about a reviewer that did. Measured on the live repo, 2026-08-22.
#
# `copilot-swe-agent` is deliberately NOT aliased here: that is the coding agent
# that writes PRs, a different actor with the opposite role.
LOGIN_ALIASES = {
    "copilot": "copilot-pull-request-reviewer",
    "github-copilot": "copilot-pull-request-reviewer",
    "codex": "chatgpt-codex-connector",
}


def normalise_login(login: str) -> str:
    """One canonical key per actor, across every spelling GitHub uses."""
    key = (login or "").strip().lower()
    if key.endswith("[bot]"):
        key = key[: -len("[bot]")]
    return LOGIN_ALIASES.get(key, key)


def classify_reviewer(login: str, is_bot: bool) -> str:
    """Family of a reviewer, or 'human'.

    An unrecognised BOT is the dangerous case: it is not a human, so it must not
    be scored as an independent human reviewer. It gets 'unknown-bot', which
    never satisfies the independence test.
    """
    key = normalise_login(login)
    if key in FAMILY_BY_LOGIN:
        return FAMILY_BY_LOGIN[key]
    return "unknown-bot" if is_bot else "human"


TRAILER_LINE = re.compile(r"^\s*[A-Za-z][A-Za-z-]*:\s")


def _trailer_lines(commit_messages: list[str]) -> list[str]:
    """Only the lines that are actually trailers, plus the tool's sign-off line.

    Scanning the whole message is wrong, and Copilot caught it on this very PR:
    a commit whose BODY discusses `@openai.com` or `openai codex` - which every
    commit in this feature does, because the feature is about them - would add a
    false author family. That would turn a legitimate cross-family review into a
    fabricated conflict and take the daily run red for no reason.
    """
    out = []
    for message in commit_messages:
        for line in (message or "").splitlines():
            low = line.lower()
            if TRAILER_LINE.match(line) or "generated with" in low:
                out.append(low)
    return out



def author_families(commit_messages: list[str]) -> set[str]:
    """Families that co-authored the diff, read off commit trailers.

    An empty set means "no trailer says anything" - a human wrote it, or a tool
    that leaves no trace did. Empty is reported as empty, not silently turned
    into 'human'; those are different claims.
    """
    blob = "\n".join(_trailer_lines(commit_messages))
    return {family for needle, family in FAMILY_BY_TRAILER if needle in blob}


def family_conflict(authors: set[str], reviewers: set[str]) -> set[str]:
    """Families that both wrote and reviewed. Non-empty means the review is void."""
    return {f for f in authors & reviewers if f not in {"human", "unknown-bot"}}


def ci_state(rollup: list[dict] | None) -> str:
    """pass / fail / pending / none / unknown.

    'none' is not 'pass'. A repo with no workflows produces an empty rollup, and
    collapsing that into success is how a backlog report starts lying.
    """
    if rollup is None:
        return "unknown"
    if not rollup:
        return "none"
    outcomes = [(c.get("conclusion") or c.get("state") or "").upper() for c in rollup]
    if any(o in {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"} for o in outcomes):
        return "fail"
    if any(o in {"", "PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"} for o in outcomes):
        return "pending"
    return "pass"


def last_activity_at(created_at: datetime, commit_times: list[datetime],
                     human_comment_times: list[datetime],
                     human_review_times: list[datetime]) -> datetime:
    """When someone last actually did something to this PR.

    NOT the PR's `updatedAt`, and that distinction is load-bearing. Copilot
    caught it reviewing this very tool, and it was then measured on the live
    repo: posting the backlog comment set #229's `updated_at` to
    2026-08-22T13:45:29Z - byte-identical to the comment's own `created_at`.

    So the reporter's own daily write reset `days_idle` to 0 every single run.
    Nothing could ever reach the stale threshold, nothing could ever be flagged,
    and the flag-then-close mechanism would have sat there looking healthy while
    being structurally incapable of firing. A monitor that cannot fail visibly
    is worse than no monitor.

    Machine reviews are excluded for the same reason: a bot reading a PR is not
    someone working on it, and letting Copilot's own review make a PR look fresh
    would hide the exact staleness the weekly sweep exists to find.
    """
    return max([created_at, *commit_times, *human_comment_times, *human_review_times])


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def days_between(later: datetime, earlier: datetime) -> int:
    return max(0, (later - earlier).days)


@dataclass
class ReviewerRecord:
    login: str
    family: str
    findings: int
    states: list[str] = field(default_factory=list)
    last_reviewed_at: datetime | None = None


@dataclass
class PrRecord:
    number: int
    title: str
    url: str
    is_draft: bool
    mergeable: str
    created_at: datetime
    updated_at: datetime
    changed_files: int
    additions: int
    deletions: int
    base_ref: str
    ci: str
    author_families: set[str]
    reviewers: list[ReviewerRecord]
    labels: list[str]
    # The raw GitHub value, kept only so a human can see how far it diverges from
    # real activity. NOTHING should branch on it - see last_activity_at().
    github_updated_at: datetime | None = None
    copilot_requested: bool = False
    flagged_on: str | None = None
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def days_open(self) -> int:
        return days_between(self.now, self.created_at)

    @property
    def days_idle(self) -> int:
        return days_between(self.now, self.updated_at)

    @property
    def reviewer_families(self) -> set[str]:
        return {r.family for r in self.reviewers}

    @property
    def total_findings(self) -> int:
        return sum(r.findings for r in self.reviewers)

    @property
    def conflict(self) -> set[str]:
        return family_conflict(self.author_families, self.reviewer_families)

    @property
    def has_independent_review(self) -> bool:
        """A review counts only if some reviewer is not of an authoring family."""
        return any(
            r.family not in self.author_families and r.family != "unknown-bot"
            for r in self.reviewers
        )


COPILOT_LOGIN = "copilot-pull-request-reviewer"


def copilot_need(pr: PrRecord, stuck_days: int) -> tuple[int, str] | None:
    """Why this PR is worth a Copilot review, or None to leave it alone.

    Reviews are billed by token consumption against a monthly credit allowance
    that does not roll over, so the quota goes where a review changes
    something: work that is STUCK, not work a session is actively pushing to.
    Lower number = reviewed first.

    This repo takes ~8.8 PRs/day against 1,500 credits/month on Copilot Pro
    ($10/mo: 1,000 base + 500 flex). Whether that fits is an open question and
    deliberately not answered here - it depends on credits-per-review, which is
    a function of diff size and has not been measured. See CREDITS_PER_REVIEW.
    """
    if pr.is_draft:
        return None  # durability pushes are not asking a question yet
    if pr.days_idle < 1:
        return None  # someone is working on it right now; a review would race them
    if pr.copilot_requested:
        return None  # already queued; re-requesting cancels and restarts it

    last = next((r.last_reviewed_at for r in pr.reviewers
                 if normalise_login(r.login) == COPILOT_LOGIN), None)
    if last is not None and pr.updated_at <= last:
        return None  # already reviewed at this state; re-requesting buys nothing

    if not any(r.family not in pr.author_families and r.family != "unknown-bot"
               for r in pr.reviewers):
        return (0, "no independent review at all")
    if last is not None:
        return (1, f"pushed since Copilot last read it ({last:%Y-%m-%d})")
    if pr.days_idle >= stuck_days:
        return (2, f"stuck - {pr.days_idle} days idle")
    if pr.mergeable == "CONFLICTING":
        return (3, "conflicting")
    return None


def copilot_candidates(prs: list[PrRecord], stuck_days: int, budget: int,
                       explicit: bool = False) -> list[tuple[PrRecord, str]]:
    """The <=budget PRs this week's quota should be spent on, worst first.

    `explicit` is set when the caller named the PRs with --only. Naming a PR IS
    the intent, so the staleness heuristics are skipped - they exist to choose
    on nobody's behalf, not to argue with someone who already chose. The two
    hard guards stay: a draft is not asking a question, and re-requesting a
    queued review cancels and restarts it.
    """
    if explicit:
        return [(pr, "named explicitly with --only") for pr in prs
                if not pr.is_draft and not pr.copilot_requested][:max(0, budget)]
    scored = []
    for pr in prs:
        need = copilot_need(pr, stuck_days)
        if need:
            scored.append((need[0], -pr.days_idle, pr, need[1]))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [(pr, why) for _, _, pr, why in scored[:max(0, budget)]]


def bucket_of(pr: PrRecord, stale_idle_days: int) -> str:
    """ready | draft | stale | blocked.

    Stale takes precedence: a draft nobody has touched in three weeks is a stale
    draft, and the draft flag must not hide that.
    """
    if pr.days_idle >= stale_idle_days:
        return "stale"
    if pr.is_draft:
        return "draft"
    if pr.mergeable == "MERGEABLE" and pr.has_independent_review and pr.ci in {"pass", "none"}:
        return "ready"
    return "blocked"


def stale_action(pr: PrRecord, stale_idle_days: int, close_after_flag_days: int) -> str:
    """none | flag | close - what today's run should do about staleness."""
    if pr.days_idle < stale_idle_days:
        return "none"
    if pr.flagged_on is None:
        return "flag"
    if not pr.is_draft:
        return "none"  # flagged for a human decision, never auto-closed
    flagged = parse_ts(pr.flagged_on + "T00:00:00+00:00")
    if days_between(pr.now, flagged) >= close_after_flag_days:
        return "close"
    return "none"


def flag_was_superseded(pr: PrRecord) -> bool:
    """True when the PR moved after we flagged it, so the clock must restart.

    The flag date has no time component, so activity is only counted as newer
    when it lands a full day past the flag - otherwise our own labelling run
    would look like activity and clear its own flag.
    """
    if pr.flagged_on is None:
        return False
    flagged = parse_ts(pr.flagged_on + "T00:00:00+00:00")
    return pr.updated_at > flagged + timedelta(days=1)


def parse_flag_date(comment_body: str) -> str | None:
    for line in (comment_body or "").splitlines():
        line = line.strip()
        if line.startswith(FLAG_PREFIX):
            return line[len(FLAG_PREFIX):].split()[0]
    return None


def render_comment(pr: PrRecord, stale_idle_days: int, close_after_flag_days: int,
                   action: str) -> str:
    merge = "mergeable" if pr.mergeable == "MERGEABLE" else pr.mergeable.lower()
    # "unknown" IS ONE OF THE VALUES ci_state RETURNS. This PR introduced it -- a
    # partial GraphQL response yields a None rollup, which ci_state maps to "unknown"
    # -- and left the render table with four keys, so the very PRs the change exists
    # to handle crashed the report with a KeyError instead of appearing in it. A fix
    # for a partial-data path must not make partial data fatal.
    # Reviewer-caught (codex, round 2 on #288).
    ci_text = {
        "pass": "passing",
        "fail": "**FAILING**",
        "pending": "running",
        "none": "no checks configured on this repo",
        "unknown": "**could not be established** -- GitHub returned partial data for "
                   "this PR, so this is not a statement that CI passed",
    }.get(pr.ci)
    if ci_text is None:
        # An unmapped state must say which one, not KeyError with a bare value. This
        # renders into a report a person reads; "'flaky'" tells them nothing about
        # where it came from.
        raise ValueError(
            "ci_state returned %r, which render_comment has no wording for. Add it to "
            "the table above rather than letting the report omit a PR." % (pr.ci,))

    if pr.reviewers:
        who = ", ".join(
            f"`{r.login}` ({r.family}, {r.findings} finding{'' if r.findings == 1 else 's'})"
            for r in sorted(pr.reviewers, key=lambda r: r.login)
        )
        review_line = f"reviewed by {who}"
    else:
        review_line = "**no review**"

    authors = (", ".join(sorted(pr.author_families))
               if pr.author_families else "no model trailer (human, or untraced)")

    lines = [
        MARKER,
        "### Backlog state",
        "",
        "| | |",
        "|---|---|",
        f"| merge | {merge} |",
        f"| CI | {ci_text} |",
        f"| age | {pr.days_open}d open, {pr.days_idle}d idle |",
        f"| size | {pr.changed_files} files, +{pr.additions}/-{pr.deletions} |",
        f"| review | {review_line} |",
        f"| authored by | {authors} |",
        "",
    ]

    conflict = pr.conflict
    if conflict:
        lines += [
            "> [!CAUTION]",
            f"> **The reviewer shares base weights with the author "
            f"({', '.join(sorted(conflict))}).**",
            "> This review does not count. A model agreeing with its own family is not",
            "> evidence of anything. Get a reviewer from a different vendor before merging.",
            "",
        ]
    elif pr.reviewers and pr.total_findings == 0:
        lines += [
            "> [!WARNING]",
            f"> **A review ran and raised zero findings** on a +{pr.additions}/-{pr.deletions}",
            "> change. That is more likely to mean the reviewer never read the diff than",
            "> that the diff is perfect. Confirm it actually inspected the files.",
            "",
        ]

    if action == "close":
        lines += [
            "> [!IMPORTANT]",
            f"> **Closed as a stale draft** - flagged {pr.flagged_on}, untouched since.",
            "> Nothing was deleted: the branch is intact and reopening this PR picks the",
            "> work back up exactly where it stopped.",
            "",
        ]
    elif pr.flagged_on:
        lines += [
            "> [!WARNING]",
            f"> **Flagged stale** on {pr.flagged_on} - {pr.days_idle} days without activity.",
        ]
        if pr.is_draft:
            lines += [
                f"> If it is still a draft and still untouched {close_after_flag_days} days after that",
                "> flag, it will be closed automatically. Any push or comment clears the flag.",
            ]
        else:
            lines += [
                "> This is not a draft, so it will **not** be auto-closed. It is flagged for a",
                "> decision only.",
            ]
        lines.append("")

    lines += [
        f"<sub>Rewritten in place daily by `tools/pr_backlog_report.py`. Stale threshold "
        f"{stale_idle_days}d idle. This bot never merges - that stays Ivan's call.</sub>",
    ]
    if pr.flagged_on:
        lines.append(f"{FLAG_PREFIX}{pr.flagged_on} -->")

    return "\n".join(lines)


def render_summary(roll: dict) -> str:
    titles = {
        "ready": "Ready to merge - review attached, mergeable",
        "blocked": "Blocked - conflicting, failing, or unreviewed",
        "draft": "Draft / durability only - no decision needed",
        "stale": "Stale - flagged, or closing",
    }
    by_number = {row["number"]: row for row in roll["prs"]}
    out = [f"## Open PR backlog - {roll['open_prs']} open", ""]
    for key in ("ready", "blocked", "draft", "stale"):
        numbers = roll["buckets"][key]
        out.append(f"### {titles[key]} ({len(numbers)})")
        if not numbers:
            out.append("_none_")
        for n in sorted(numbers, key=lambda n: -by_number[n]["days_idle"]):
            row = by_number[n]
            rv = ", ".join(f"{r['login']}/{r['family']}:{r['findings']}"
                           for r in row["reviewers"]) or "no review"
            out.append(f"- #{n} {row['title']} - {row['days_idle']}d idle, "
                       f"{row['mergeable'].lower()}, {rv}")
        out.append("")
    if roll["same_family_conflicts"]:
        out.append("> **Reviewer and author share base weights on:** "
                   + ", ".join("#" + str(n) for n in roll["same_family_conflicts"])
                   + " - those reviews do not count.")
    if roll.get("copilot_reviews_requested"):
        out.append("")
        out.append(f"### Copilot reviews requested "
                   f"({len(roll['copilot_reviews_requested'])} of {roll['copilot_budget']} budgeted)")
        for r in roll["copilot_reviews_requested"]:
            out.append(f"- #{r['number']} - {r['why']} ({r['outcome']})")
        out.append("")
    elif roll.get("copilot_budget"):
        out.append("")
        out.append(f"### Copilot reviews requested (0 of {roll['copilot_budget']} budgeted)")
        out.append("_Nothing was stuck enough to be worth the quota._")
        out.append("")
    if roll.get("copilot_budget") and roll.get("copilot_monthly_allowance"):
        monthly = roll["copilot_budget"] * 52 // 12
        allowance = roll["copilot_monthly_allowance"]
        # A REVIEW IS NOT A CREDIT. Until 2026-08-25 this line divided reviews
        # by the allowance and printed "28/week ... 8%" - reviews over credits,
        # two different units, a number that made any budget look affordable.
        #
        # The fix is NOT a different multiplier. Copilot code review is billed
        # by token consumption, so cost per review depends on diff size and is
        # not knowable from a review count alone. Printing an unmeasured
        # percentage would repeat the original mistake with better arithmetic.
        if CREDITS_PER_REVIEW is None:
            # A rejected setting must not read the same as one never set: the
            # first means somebody tried to configure this and it did not take.
            rejected = (f" **COPILOT_CREDITS_PER_REVIEW was REJECTED** "
                        f"({CREDITS_PER_REVIEW_ERROR}), so it is not in effect."
                        if CREDITS_PER_REVIEW_ERROR else "")
            out.append(f"Budget: {roll['copilot_budget']}/week is about {monthly} reviews/month "
                       f"against an allowance of {allowance} AI credits. **Cost per review is "
                       f"UNMEASURED**, so this cannot be expressed as a percentage: since "
                       f"2026-06-01 code review is billed by token consumption, not per use, and "
                       f"scales with diff size.{rejected} Set COPILOT_CREDITS_PER_REVIEW once "
                       f"measured. Credits do not roll over and reset at 00:00:00 UTC on the 1st. "
                       f"Real consumption: https://github.com/settings/billing")
        else:
            credits = monthly * CREDITS_PER_REVIEW
            pct = 100 * credits / max(allowance, 1)
            ceiling = int(allowance // CREDITS_PER_REVIEW)
            out.append(f"Budget: {roll['copilot_budget']}/week is about {monthly} reviews/month = "
                       f"{credits:.0f} credits at {CREDITS_PER_REVIEW:g}/review (measured), "
                       f"against an allowance of {allowance} — {pct:.0f}%. The ceiling is "
                       f"{ceiling} reviews/month ({ceiling / 30:.1f}/day). Credits do not roll "
                       f"over and reset at 00:00:00 UTC on the 1st. "
                       f"Real consumption: https://github.com/settings/billing")
        out.append("")
    if roll["reviewed"]:
        out.append(f"Reviews raising zero findings: {roll['reviews_with_zero_findings']}"
                   f"/{roll['reviewed']} across {roll['reviewed_prs']} PRs. A high ratio "
                   f"means the reviewer is broken, not that the code is clean.")
        if roll.get("silent_reviewers"):
            out.append(f"Raised nothing at all: {', '.join(roll['silent_reviewers'])}.")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# GitHub I/O
# ---------------------------------------------------------------------------


def _gh_exe() -> str:
    exe = shutil.which("gh")
    if not exe:
        sys.exit("gh CLI not found on PATH - this tool drives GitHub through it.")
    return exe


def gh(args: list[str], stdin: str | None = None) -> str:
    # encoding is explicit: text=True alone decodes with the locale codec, which
    # on this Windows box is cp1252, and any PR touching "Chloe" with an accent
    # or a review body with an emoji dies with UnicodeDecodeError. GitHub speaks
    # UTF-8; decode it as UTF-8 everywhere.
    proc = subprocess.run([_gh_exe()] + args, input=stdin, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


#: Sentinel: "stdout did not parse", kept distinct from the legitimate value None so
#: a `null` payload and unparseable bytes cannot be confused for one another.
_UNPARSEABLE = object()

#: What a GraphQL PARTIAL result says -- each of these is a per-node complaint that
#: accompanies data for the nodes that DID resolve. "graphql" was in this list and had
#: to come out: it is not a diagnosis, it is the name of the API, so "GraphQL:
#: repository not found" -- a total failure -- passed as a partial result.
_GRAPHQL_PARTIAL_MARKERS = ("some data was not returned",
                            "could not resolve to",
                            "was submitted with errors",
                            "not accessible by integration")

#: GitHub's ERROR envelope. A response whose keys are only these is the failure
#: serialised as JSON, not partial data, however non-empty it is.
_ERROR_ENVELOPE_KEYS = {"message", "documentation_url", "status", "errors"}


def _carries_partial_data(data) -> bool:
    """Is this payload actual data, or the error wearing a JSON hat?

    "Non-empty JSON" was the test, and `{"message": "nope"}` is non-empty JSON. A
    GitHub error envelope has to be recognised as one, or every failure that
    serialises itself passes the check that exists to catch failures.
    """
    if data in (None, [], {}, ""):
        return False
    if isinstance(data, dict):
        if not (set(data) - _ERROR_ENVELOPE_KEYS):
            return False          # nothing here but the error
        # The GraphQL envelope itself: data alongside errors is exactly the partial
        # case, but only when `data` is populated.
        if "data" in data and "errors" in data:
            return bool(data.get("data"))
    return True


def _invokes_graphql(args) -> bool:
    """Only a GraphQL-backed call can produce a GraphQL partial result.

    Without this the tolerance applied to every gh subcommand, including ones that
    cannot return partial data at all.
    """
    return "graphql" in args or "--json" in args


def _is_graphql_partial(stderr: str) -> bool:
    """Does this stderr describe a GraphQL query that returned data AND errors?

    Fails closed: an unrecognised message is a failure, not a partial success. The
    cost of being wrong that way is a raised exception on a run that might have been
    salvageable; the cost the other way is a backlog report that quietly omits
    whatever gh could not fetch.
    """
    low = (stderr or "").lower()
    if not low:
        return False
    # An authentication or permission problem is never a partial result, even when it
    # mentions GraphQL -- gh says "graphql" in plenty of error text.
    if any(w in low for w in ("authentication", "not logged", "bad credentials",
                              "http 401", "http 403", "rate limit", "no such host",
                              "connection refused", "timeout")):
        return False
    return any(m in low for m in _GRAPHQL_PARTIAL_MARKERS)


def gh_json(args: list[str], expect=None):
    """Run gh and parse its JSON. `expect` is the SHAPE a good answer has.

    `expect` is required to tolerate a non-zero exit. Recognising an error envelope
    was not enough -- `{"unexpected":"value"}` is neither empty nor an envelope, so a
    failed `gh pr list --json number` could still return a dict where every caller
    iterates a list. The caller is the only thing that knows what a good answer looks
    like here, so it has to say; a partial result that is not the right shape is not a
    partial result. Omitting `expect` is allowed on the success path and simply means
    the tolerance is unavailable, which fails closed.
    Reviewer-caught (codex, round 5 on #288).
    """
    proc = subprocess.run([_gh_exe()] + args, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        # "IT PRINTED JSON" IS NOT A DIAGNOSIS. This accepted ANY non-zero gh whose
        # stdout happened to parse, with no look at WHY it failed -- so an auth
        # failure, a 404, or a rate-limit that renders its error as JSON came back as
        # a successful partial result and went into the report. The tolerance exists
        # for one specific thing: a GraphQL query that returns data alongside errors
        # for some nodes. It is now scoped to that, and everything else raises.
        # Reviewer-caught (codex, round 3 on #288).
        err = (proc.stderr or "").strip()
        looks_partial = (_is_graphql_partial(err) and _invokes_graphql(args)
                         and expect is not None)
        if looks_partial and (proc.stdout or "").strip():
            try:
                data = json.loads(proc.stdout)
            except json.JSONDecodeError:
                data = _UNPARSEABLE
            # A partial result still has to BE a result. `null`, or a payload that
            # parses to nothing, is the error with a JSON hat on.
            if (data is not _UNPARSEABLE and isinstance(data, expect)
                    and _carries_partial_data(data)):
                print("warning: gh %s returned partial GraphQL data; some nodes are "
                      "missing: %s" % (" ".join(args), err), file=sys.stderr)
                return data
        raise RuntimeError("gh %s failed: %s" % (" ".join(args), err or "(silent)"))
    # EXIT 0 WITH NO OUTPUT IS NOT AN EMPTY RESULT. `json.loads(proc.stdout or "null")`
    # turned a silent gh into None, and every caller writes `... or []` after it, so a
    # call that produced NOTHING became an empty list -- and `collect` then rendered a
    # cheerful "no open pull requests" backlog report. The whole point of this file is
    # to describe a backlog accurately; a report that says the queue is empty because
    # the query fell over is worse than no report, because nobody goes looking.
    #
    # gh emits `[]`, `{}` or `null` for a genuinely empty result. Zero bytes means it
    # did not answer. Reviewer-caught (codex, round 2 on #288).
    if not (proc.stdout or "").strip():
        raise RuntimeError(
            "gh %s exited 0 but wrote nothing. That is not an empty result -- gh "
            "prints [], {} or null for those -- so this is an unanswered query and "
            "must not be reported as an empty backlog. stderr: %s"
            % (" ".join(args), proc.stderr.strip() or "(silent)"))
    # AND UNPARSEABLE OUTPUT RAISES RuntimeError, which is what this function
    # promises its callers. A bare JSONDecodeError escaping from here is a different
    # exception type than every other failure path, so the one caller that guards
    # against gh failing would not have caught it.
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "gh %s exited 0 but its output is not JSON (%s). First 200 characters: %r"
            % (" ".join(args), exc, proc.stdout[:200])) from exc


def collect(repo: str) -> list[PrRecord]:
    # `commits` is deliberately NOT in this field list. Asking for it across 200
    # PRs makes gh build a GraphQL query whose authors connection exceeds the
    # 500,000-node ceiling and the whole call 500s - so commit messages come
    # from REST, per PR, below.
    raw = gh_json([
        "pr", "list", "--repo", repo, "--state", "open", "--limit", str(LIST_LIMIT),
        "--json", "number,title,url,isDraft,mergeable,createdAt,updatedAt,changedFiles,"
                  "additions,deletions,baseRefName,reviews,statusCheckRollup,labels,"
                  "reviewRequests",
    ], expect=list) or []

    # A truncated list must not be reported as a complete backlog. `--limit` cuts
    # silently, and `open_prs` would then present a partial roll-up as the whole
    # picture - the same "looks healthy, is wrong" shape as the CI 'none' case.
    if len(raw) >= LIST_LIMIT:
        raise RuntimeError(
            f"gh returned {len(raw)} PRs, which is the --limit of {LIST_LIMIT}. The list is "
            f"probably truncated and this report would understate the backlog. Raise "
            f"LIST_LIMIT rather than trusting this number."
        )

    records: list[PrRecord] = []
    for pr in raw:
        number = pr["number"]

        # Findings live on the inline diff threads, not in the review body.
        inline = gh_json(["api", f"repos/{repo}/pulls/{number}/comments", "--paginate"],
                          expect=list) or []
        findings: dict[str, int] = {}
        for c in inline:
            key = normalise_login((c.get("user") or {}).get("login", ""))
            if key:
                findings[key] = findings.get(key, 0) + 1

        reviewers: dict[str, ReviewerRecord] = {}
        for rv in pr.get("reviews") or []:
            author = rv.get("author") or {}
            login = author.get("login", "")
            key = normalise_login(login)
            if not key:
                continue
            is_bot = bool(author.get("is_bot")) or key in FAMILY_BY_LOGIN
            rec = reviewers.setdefault(key, ReviewerRecord(
                login=login,
                family=classify_reviewer(login, is_bot),
                findings=findings.get(key, 0),
            ))
            rec.states.append(rv.get("state", ""))
            when = rv.get("submittedAt")
            if when:
                ts = parse_ts(when)
                if rec.last_reviewed_at is None or ts > rec.last_reviewed_at:
                    rec.last_reviewed_at = ts

        commits = gh_json(["api", f"repos/{repo}/pulls/{number}/commits", "--paginate"],
                           expect=list) or []
        messages = [(c.get("commit") or {}).get("message", "") for c in commits]

        # Idleness is computed from real activity, never from the PR's own
        # `updatedAt` - see last_activity_at() for why that field is poisoned by
        # this tool's own comment.
        issue_comments = gh_json(
            ["api", f"repos/{repo}/issues/{number}/comments", "--paginate"],
            expect=list) or []
        human_comment_times = [
            parse_ts(c["created_at"]) for c in issue_comments
            if MARKER not in (c.get("body") or "")
            and AUDIT_MARKER not in (c.get("body") or "")
            and ((c.get("user") or {}).get("type", "")).lower() != "bot"
        ]
        human_review_times = [
            r.last_reviewed_at for r in reviewers.values()
            if r.family == "human" and r.last_reviewed_at is not None
        ]
        commit_times = [
            parse_ts((c.get("commit") or {}).get("committer", {}).get("date")
                     or (c.get("commit") or {}).get("author", {}).get("date"))
            for c in commits
            if (c.get("commit") or {}).get("committer", {}).get("date")
            or (c.get("commit") or {}).get("author", {}).get("date")
        ]
        created = parse_ts(pr["createdAt"])

        records.append(PrRecord(
            number=number,
            title=pr["title"],
            url=pr["url"],
            is_draft=pr["isDraft"],
            mergeable=pr.get("mergeable") or "UNKNOWN",
            created_at=created,
            updated_at=last_activity_at(created, commit_times,
                                        human_comment_times, human_review_times),
            github_updated_at=parse_ts(pr["updatedAt"]),
            copilot_requested=any(
                normalise_login(r.get("login") or r.get("name") or "") == COPILOT_LOGIN
                for r in (pr.get("reviewRequests") or [])
            ),
            changed_files=pr.get("changedFiles") or 0,
            additions=pr.get("additions") or 0,
            deletions=pr.get("deletions") or 0,
            base_ref=pr.get("baseRefName") or "main",
            ci=ci_state(pr.get("statusCheckRollup")),
            author_families=author_families(messages),
            reviewers=list(reviewers.values()),
            labels=[l["name"] for l in (pr.get("labels") or [])],
        ))
    return records


def find_own_comment(repo: str, number: int) -> tuple[int | None, str]:
    comments = gh_json(["api", f"repos/{repo}/issues/{number}/comments", "--paginate"],
                       expect=list) or []
    for c in comments:
        if MARKER in (c.get("body") or ""):
            return c["id"], c["body"]
    return None, ""


def upsert_comment(repo: str, number: int, body: str, existing_id: int | None,
                   dry_run: bool) -> str:
    if dry_run:
        return "would-update" if existing_id else "would-create"
    payload = json.dumps({"body": body})
    if existing_id:
        gh(["api", "-X", "PATCH", f"repos/{repo}/issues/comments/{existing_id}",
            "--input", "-"], stdin=payload)
        return "updated"
    gh(["api", "-X", "POST", f"repos/{repo}/issues/{number}/comments",
        "--input", "-"], stdin=payload)
    return "created"


def ensure_label(repo: str, number: int, dry_run: bool) -> None:
    if dry_run:
        return
    try:
        gh(["label", "create", STALE_LABEL, "--repo", repo, "--color", "d4c5f9",
            "--description", "Flagged stale; auto-close pending if it is a draft"])
    except RuntimeError:
        pass  # already exists
    gh(["api", "-X", "POST", f"repos/{repo}/issues/{number}/labels", "--input", "-"],
       stdin=json.dumps({"labels": [STALE_LABEL]}))


def remove_label(repo: str, number: int, dry_run: bool) -> None:
    if dry_run:
        return
    try:
        gh(["api", "-X", "DELETE", f"repos/{repo}/issues/{number}/labels/{STALE_LABEL}"])
    except RuntimeError:
        pass  # not labelled


def request_copilot_review(repo: str, number: int, dry_run: bool) -> str:
    """Ask Copilot to review one PR.

    The documented REST route does not work for this bot:
        POST /repos/{repo}/pulls/{n}/requested_reviewers
        reviewers[]=copilot-pull-request-reviewer
        -> 422 "Reviews may only be requested from collaborators"
    Copilot has to be passed as a BOT id through GraphQL. And the documented way
    to find that id, suggestedActors(capabilities: [CAN_BE_REVIEWER]), is not in
    the live schema - the only enum values are CAN_BE_ASSIGNED and CAN_BE_AUTHOR.
    Resolving it through the bot's own [bot] user account is what works.
    """
    if dry_run:
        return "would-request"
    # gh(), not gh_json(): `--jq .node_id` emits a BARE STRING, not JSON, so
    # json.loads() dies on it. This whole function was unreachable until the
    # --no-comment gate above was fixed, which is why the dry run never showed it.
    bot_id = gh(["api", "users/copilot-pull-request-reviewer%5Bbot%5D",
                 "--jq", ".node_id"]).strip()
    pr_id = gh(["api", "graphql", "-f", "query="
                 "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n)"
                 "{pullRequest(number:$p){id}}}",
                 "-f", f"o={repo.split('/')[0]}", "-f", f"n={repo.split('/')[1]}",
                 "-F", f"p={number}",
                 "--jq", ".data.repository.pullRequest.id"]).strip()
    if not bot_id or not pr_id:
        raise RuntimeError(f"could not resolve Copilot bot id or PR node id for #{number}")
    gh(["api", "graphql", "-f", "query="
        "mutation($pr:ID!,$bot:ID!){requestReviews(input:{pullRequestId:$pr,"
        "botIds:[$bot],union:true}){pullRequest{number}}}",
        "-f", f"pr={pr_id}", "-f", f"bot={bot_id}"])
    return "requested"


def close_pr(repo: str, number: int, dry_run: bool) -> None:
    if dry_run:
        return
    gh(["pr", "close", str(number), "--repo", repo])


# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"),
                    help="owner/name; defaults to $GITHUB_REPOSITORY, then the checkout")
    ap.add_argument("--stale-idle-days", type=int,
                    default=int(os.environ.get("STALE_IDLE_DAYS", "14")))
    ap.add_argument("--close-after-flag-days", type=int,
                    default=int(os.environ.get("CLOSE_AFTER_FLAG_DAYS", "7")))
    ap.add_argument("--dry-run", action="store_true",
                    help="decide and print, change nothing on GitHub")
    ap.add_argument("--no-close", action="store_true",
                    help="flag stale drafts but never close them")
    ap.add_argument("--no-comment", action="store_true",
                    help="compute the report without writing anything to PRs")
    ap.add_argument("--request-copilot-reviews", type=int, default=0, metavar="N",
                    help="spend up to N Copilot reviews on the most stuck PRs. This is a "
                         "HARD CAP, not a target - it is the whole quota control, so set "
                         "it from the plan's monthly allowance, not from how many PRs are "
                         "open.")
    ap.add_argument("--stuck-days", type=int, default=int(os.environ.get("STUCK_DAYS", "7")),
                    help="days idle before an already-reviewed PR counts as stuck")
    ap.add_argument("--monthly-allowance", type=int,
                    default=int(os.environ.get("COPILOT_MONTHLY_ALLOWANCE", "1500")),
                    help="premium interactions the plan grants per month. Used ONLY to "
                         "print the budget as a share of it - this tool cannot read the "
                         "real figure, because /user returns plan:null without the `user` "
                         "scope and /user/copilot/billing is organisation-only.")
    ap.add_argument("--only", type=int, action="append", metavar="PR",
                    help="restrict to these PR numbers; repeatable. For trying the "
                         "comment format on one PR before letting it touch the whole "
                         "backlog.")
    ap.add_argument("--json-out", help="write the machine-readable roll-up here")
    ap.add_argument("--summary-out", help="write the three-bucket markdown summary here")
    args = ap.parse_args(argv)

    if not args.repo:
        args.repo = gh_json(["repo", "view", "--json", "nameWithOwner"], expect=dict)["nameWithOwner"]

    read_only = args.dry_run or args.no_comment
    prs = collect(args.repo)
    if args.only:
        wanted = set(args.only)
        prs = [p for p in prs if p.number in wanted]
        missing = wanted - {p.number for p in prs}
        if missing:
            print(f"warning: not open on {args.repo}: "
                  f"{', '.join('#' + str(n) for n in sorted(missing))}", file=sys.stderr)
    buckets: dict[str, list[int]] = {"ready": [], "draft": [], "stale": [], "blocked": []}
    rows = []

    for pr in prs:
        existing_id, existing_body = find_own_comment(args.repo, pr.number)
        pr.flagged_on = parse_flag_date(existing_body)

        # Activity after the flag clears it, so a nudge really does reset the clock.
        if flag_was_superseded(pr):
            pr.flagged_on = None
            remove_label(args.repo, pr.number, read_only)

        action = stale_action(pr, args.stale_idle_days, args.close_after_flag_days)
        if action == "close" and args.no_close:
            action = "none"
        if action == "flag":
            pr.flagged_on = pr.now.strftime("%Y-%m-%d")

        body = render_comment(pr, args.stale_idle_days, args.close_after_flag_days, action)
        wrote = "skipped" if args.no_comment else upsert_comment(
            args.repo, pr.number, body, existing_id, args.dry_run)

        if action == "flag":
            ensure_label(args.repo, pr.number, read_only)
        if action == "close":
            close_pr(args.repo, pr.number, read_only)

        bucket = "stale" if action in {"flag", "close"} else bucket_of(pr, args.stale_idle_days)
        buckets[bucket].append(pr.number)
        rows.append({
            "number": pr.number,
            "title": pr.title,
            "url": pr.url,
            "bucket": bucket,
            "action": action,
            "comment": wrote,
            "draft": pr.is_draft,
            "mergeable": pr.mergeable,
            "ci": pr.ci,
            "days_open": pr.days_open,
            "days_idle": pr.days_idle,
            "author_families": sorted(pr.author_families),
            "reviewers": [{"login": r.login, "family": r.family, "findings": r.findings}
                          for r in pr.reviewers],
            "same_family_conflict": sorted(pr.conflict),
            "changed_files": pr.changed_files,
            "additions": pr.additions,
            "deletions": pr.deletions,
        })

    requested = []
    if args.request_copilot_reviews > 0:
        for pr, why in copilot_candidates(prs, args.stuck_days,
                                          args.request_copilot_reviews,
                                          explicit=bool(args.only)):
            # Gated on --dry-run ALONE, never on read_only. --no-comment means
            # "do not write the backlog comment"; the weekly sweep passes it so
            # it does not race the daily reporter for that comment body. Folding
            # it into read_only made the sweep request nothing at all while
            # printing a list of PRs it claimed to have sent - a no-op that reads
            # exactly like a working job.
            outcome = request_copilot_review(args.repo, pr.number, args.dry_run)
            requested.append({"number": pr.number, "why": why, "outcome": outcome})

    # Per REVIEWER, not per PR. Copilot caught this too: a PR where Codex found
    # 5 and Copilot found 0 scored as "not silent", hiding the one reviewer that
    # had gone quiet - the precise thing this metric exists to detect.
    all_reviews = [r for p in prs for r in p.reviewers]
    reviewed = [p for p in prs if p.reviewers]
    roll = {
        "repo": args.repo,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": args.dry_run,
        "open_prs": len(prs),
        "buckets": buckets,
        "reviewed": len(all_reviews),
        "reviewed_prs": len(reviewed),
        "reviews_with_zero_findings": sum(1 for r in all_reviews if r.findings == 0),
        "silent_reviewers": sorted({r.login for r in all_reviews if r.findings == 0}),
        "same_family_conflicts": [p.number for p in prs if p.conflict],
        "copilot_reviews_requested": requested,
        "copilot_budget": args.request_copilot_reviews,
        "copilot_monthly_allowance": args.monthly_allowance,
        "prs": rows,
    }

    summary = render_summary(roll)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(roll, fh, indent=2)
    if args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as fh:
            fh.write(summary + "\n")
    print(summary)

    # Non-zero when a review is void under the family rule. That is a real defect
    # in the review process and a green run would bury it.
    return 1 if roll["same_family_conflicts"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

