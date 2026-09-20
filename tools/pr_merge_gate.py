#!/usr/bin/env python3
"""Merge a pull request the moment a human approves it - and refuse otherwise.

WHY THIS EXISTS
---------------
Review without merge is where the work dies. #117 sat approved and conflicted
for six days. #176 aged into a conflict. #154 was nearly closed. Every one of
those was *finished*; what killed them was the gap between "someone said yes"
and "someone clicked the button". Ivan is not going into GitHub to click it.

So approval is the decision point and the merge follows mechanically from it.

WHY NOT `gh pr merge --auto`
----------------------------
Because on this repo it would be a no-op wearing a safety helmet. GitHub's
native auto-merge queues a PR until its *required* checks and *required*
reviews pass - and both of those live in branch protection or rulesets, which
are paid features on a private repo:

    GET /repos/ivangegovdve-sudo/hermes_agents/branches/main/protection
    403  "Upgrade to GitHub Pro or make this repository public"
    GET /repos/ivangegovdve-sudo/hermes_agents/rulesets
    403  same

    GET /repos/ivangegovdve-sudo/hermes_agents/branches/main
    -> "protected": false

With nothing required, `--auto` has nothing to wait for: it is not an approval
gate, it is an instruction to merge now. Turning it on would mean PRs merging
without any approval at all - the opposite of what was asked for.

So the gate is here, in code, where it can be read and tested. If the repo ever
goes public or the account moves to Pro, replace this with a branch protection
rule requiring one approving review plus `--auto`, and delete the file.

WHAT AUTHORISES A MERGE  (rewritten 2026-09-04 - see WHY, below)
-----------------------
An APPROVED review, on the current head, from a principal that did not write the
code.

  - THE PROPERTY IS "THE VERDICT CAME FROM A PROCESS THE ORCHESTRATOR CANNOT
    AUTHOR." Not "a different model family" - that is a CONSEQUENCE which must
    also hold, not the thing itself. The distinction is load-bearing and was
    established the hard way: a vendor list rots the moment the estate gains or
    loses a reviewer, and it passes trivially if one principal wears two model
    names.
  - The approver must be a DIFFERENT PRINCIPAL from whoever authored the diff.
    Two independent signals, both required to be clean: the approving login must
    not be a committer on the PR, and the approver's family must not appear in
    the commit trailers. The estate keeps separate Apps precisely so this can be
    checked - `ivan-codex-reviewer` reviews and never authors;
    `forest-fleet-author` and `forest-fleet-worker` author.
  - The approval must name the CURRENT head. A review of an earlier commit is
    not a review of what is about to merge, and a stale approval is how a gate
    becomes decorative.
  - The state must genuinely be APPROVED. GitHub silently degrades a review of
    one's own pull request to COMMENTED, so requiring APPROVED is also what
    excludes an author approving themselves - the case that most looks like
    compliance.
  - The approver must be on MERGE_APPROVERS: a deliberate, reviewable list of
    reviewer principals, not "anyone who can leave a review".

WHY THE HUMAN REQUIREMENT WAS REMOVED
-------------------------------------
The previous rule was "an approval from a named human, and NO BOT MAY EVER
APPROVE". It was written when a human approval was the only independence signal
available, and it made `deny_bot_approval` the most important line in the file.

It had to go, because Ivan does not review code and never has. Every merge
therefore routed around this tool, including the one on 2026-09-04 that shipped
#427. A control that everyone bypasses is worse than no control: it trains
people to bypass controls, and it makes the bypass the normal path rather than
the exception anyone would notice.

⚠ THIS IS NOT A WEAKENING, AND THE SHAPE OF THE CHANGE MATTERS. The old rule
asked "is the approver a person?". The new one asks "could the thing that wrote
this code have produced this verdict?" - which is the question the old rule was
a proxy for, asked directly. A bot may now approve; the SAME bot that wrote the
code may not, and neither may any principal that co-authored it.

There is deliberately NO override flag. A flag that disables the check is the
bypass in a nicer costume, and the reason this rewrite exists is that a bypass
already existed.

WHAT IT STILL CHECKS AFTER THE APPROVAL
---------------------------------------
Approval authorises the merge; it does not make a conflicted branch mergeable.
The PR must be open, not a draft, and MERGEABLE. CI must be green if CI exists -
and this repo has no workflows on `main`, so "no checks configured" is allowed
but is written into the audit comment verbatim rather than being quietly
rendered as a pass.

Independence is ESTABLISHED by the approving review, not inferred from the
approver being a person - that inference is what this rewrite removed. Other
reviews on the PR are recorded for the reader but are not required, because
requiring a second one would deadlock a PR on a reviewer that runs weekly.
"""

from __future__ import annotations

import argparse
import time
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pr_backlog_report import (  # noqa: E402
    FAMILY_BY_LOGIN,
    author_families,
    ci_state,
    classify_reviewer,
    gh,
    gh_json,
    normalise_login,
)

AUDIT_MARKER = "<!-- pr-merge-gate:v1 -->"
APPROVAL_SOURCES = ("github-review", "conversation")


@dataclass
class Decision:
    merge: bool
    reasons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def refuse(self, reason: str) -> "Decision":
        self.merge = False
        self.reasons.append(reason)
        return self


def deny_self_approval(login: str, committers: set[str], author_fams: set[str]) -> str | None:
    """Refusal reason if the approver could have authored the diff, else None.

    THIS IS THE GATE. Everything else here is hygiene; this is the property.

    Two independent signals, EITHER of which disqualifies, because they catch
    different disguises of the same thing:

      1. IDENTITY. The approving login is a committer on this PR. A principal
         cannot clear its own work, whatever it is called.
      2. FAMILY. The approver's model family appears in the commit trailers.
         This catches one principal wearing two names - a session that authors
         under one App and approves under another of the same lineage. Identity
         alone would wave that through.

    ⚠ FAMILY IS THE CONSEQUENCE, NOT THE PROPERTY. It is checked second and it
    is not sufficient on its own: two different models owned by the same
    orchestrating process are still one principal. Ordering them this way is
    deliberate, so a future edit that deletes the family check weakens the gate
    without silently removing its core.

    ⚠ ABSENT TRAILERS ARE REPORTED, NOT ASSUMED CLEAN. `author_families()`
    returns an empty set both when a human wrote the diff and when a tool left
    no trace; those are different claims and this cannot tell them apart. The
    identity check still holds in that case, which is why an empty set is not
    fatal here - but see `evaluate`, which records it rather than passing over
    it. Related, and the reason this is spelled out: on 2026-09-01 an "unknown"
    author family was routed to Codex, whose approval then counted as
    cross-family purely because the string "openai" differs from the string
    "unknown". Not knowing who wrote it is not evidence that someone else did.
    """
    key = normalise_login(login)
    if not key:
        return "the approving identity is empty"
    if key in committers:
        return (f"`{login}` committed to this pull request. A principal may not "
                f"approve its own work - that is the whole point of the rule")
    fam = FAMILY_BY_LOGIN.get(key)
    if fam and fam in author_fams:
        return (f"`{login}` is of the {fam} family and the commit trailers say the "
                f"{fam} family co-authored this diff. Same lineage reviewing itself "
                f"is a model agreeing with itself, not an independent verdict")
    return None


# The workflow this gate runs inside. Its own check run is IN_PROGRESS for as long
# as the gate is deciding, so counting it makes CI "pending" on every automated run
# and the gate can then only ever merge by hand (measured on #434, 2026-09-06).
SELF_WORKFLOW = os.environ.get("MERGE_GATE_SELF_WORKFLOW", "Merge on approval")


def without_self(rollup: list[dict] | None, self_workflow: str = SELF_WORKFLOW) -> list[dict] | None:
    """The status rollup minus this workflow's own check runs. None stays None: the
    caller distinguishes 'could not read' from 'nothing there'."""
    if rollup is None:
        return None
    return [c for c in rollup if (c.get("workflowName") or "") != self_workflow]


def ci_for(pr: dict) -> str:
    """pass / fail / pending / none / unknown for a pull request record, minus this
    workflow's own check. A rollup that is absent (None) stays 'unknown' -- it is not
    turned into an empty list on the way, because 'could not read the checks' and
    'there are no checks' are different facts and only one of them is safe."""
    return ci_state(without_self(pr.get("statusCheckRollup")))


def approving_review(reviews: list[dict], head_oid: str,
                     qualifies=None) -> tuple[dict | None, str | None]:
    """The APPROVED review on the current head, or (None, why not).

    Derived from the pull request's OWN review records rather than trusted from a
    caller's flags. The gate is invoked by the same kind of session that opens the
    pull requests, so an authorisation it could simply assert on the command line
    would authorise nothing.

    ⚠ Refusals are SPECIFIC. "No approval" and "an approval of a commit that is no
    longer the head" are different failures with different fixes, and a gate that
    collapsed them would send someone hunting the wrong one.
    """
    # ⚠⚠ AN APPROVAL WITH NO IDENTITY IS NOT AN APPROVAL. Reviewer-caught 2026-09-04:
    # `main()` previously fell back to the caller's --approver when the review record
    # carried no login, which handed the identity back to the one process that must not
    # supply it. Dropping them here means the fallback has nothing to fall back to.
    approvals = [r for r in reviews
                 if (r.get("state") or "").upper() == "APPROVED"
                 and normalise_login(r.get("login") or "")]
    anonymous = [r for r in reviews
                 if (r.get("state") or "").upper() == "APPROVED"
                 and not normalise_login(r.get("login") or "")]
    if not approvals and anonymous:
        return None, ("an APPROVED review exists but carries no reviewer identity, so "
                      "independence cannot be established. An approval nobody can be "
                      "named for is not an approval")
    if not approvals:
        states = sorted({(r.get("state") or "?").upper() for r in reviews})
        if not states:
            return None, "no review of any kind has been submitted"
        return None, (
            f"no APPROVED review - the states present are {', '.join(states)}. "
            f"COMMENTED is not an approval, and GitHub degrades a review of one's "
            f"own pull request to COMMENTED, so this is also what catches a "
            f"self-approval")
    if not head_oid:
        return None, "the head commit could not be established, so no approval can be pinned to it"
    on_head = [r for r in approvals if (r.get("commit") or {}).get("oid") == head_oid]
    if not on_head:
        seen = sorted({((r.get("commit") or {}).get("oid") or "?")[:12] for r in approvals})
        return None, (
            f"the approval(s) name {', '.join(seen)} but the head is {head_oid[:12]}. "
            f"Commits pushed after an approval were never approved")
    # ⚠ PREFER A QUALIFYING APPROVAL, don't just take the newest. Reviewer-caught
    # 2026-09-04: returning `on_head[-1]` meant a later approval from an unqualified
    # identity could mask an earlier valid one and refuse a merge that should stand.
    # The caller supplies the predicate because independence needs the committers and
    # the trailers, which this function deliberately knows nothing about.
    if qualifies is not None:
        for r in on_head:
            if qualifies(r):
                return r, None
    return on_head[-1], None



def stale_approval_reason(approved_sha: str | None, head_now: str | None) -> str | None:
    """Refuse when the approval names a commit that is no longer the head.

    An approval approves a COMMIT, not a pull request forever. The
    pull_request_review trigger fires at submission, when head == the reviewed
    commit -- but a push racing the webhook, or a re-run against a moved head,
    would merge code nobody approved. GitHub dismisses stale reviews only when
    branch protection is configured to, which cannot be assumed here.

    Unknown-but-absent is tolerated (older callers pass nothing); a MISMATCH
    never is.
    """
    a = (approved_sha or "").strip()
    h = (head_now or "").strip()
    if not a or not h:
        return None
    if a != h:
        return (f"the approval names {a[:12]} but the head is now {h[:12]}. "
                f"Commits pushed after an approval were never approved.")
    return None


def parse_approvers(raw: str | None) -> set[str]:
    """MERGE_APPROVERS is comma- or whitespace-separated logins."""
    if not raw:
        return set()
    return {normalise_login(p) for p in raw.replace(",", " ").split() if p.strip()}


def evaluate(
    *,
    approver: str,
    approver_type: str,
    approval_source: str,
    allowlist: set[str],
    review_state: str,
    is_draft: bool,
    state: str,
    mergeable: str,
    ci: str,
    reviewer_families: set[str],
    author_fams: set[str],
    committers: set[str] | None = None,
    changes_requested_by: set[str] | None = None,
) -> Decision:
    """The whole gate. Pure - no network, no side effects, fully testable."""
    committers = committers or set()
    changes_requested_by = changes_requested_by or set()
    d = Decision(merge=True)

    if approval_source not in APPROVAL_SOURCES:
        return d.refuse(f"unknown approval source {approval_source!r}")

    if review_state.upper() != "APPROVED":
        return d.refuse(f"the review state is {review_state or 'empty'}, not APPROVED")

    if changes_requested_by:
        return d.refuse(
            f"CHANGES_REQUESTED is outstanding from {', '.join(sorted(changes_requested_by))}. "
            f"A later approval does not dismiss an unresolved objection")

    self_reason = deny_self_approval(approver, committers, author_fams)
    if self_reason:
        return d.refuse(f"THE APPROVER IS NOT INDEPENDENT - {self_reason}")

    if not allowlist:
        return d.refuse("MERGE_APPROVERS is empty, so nobody is authorised to approve")
    if normalise_login(approver) not in allowlist:
        return d.refuse(f"`{approver}` is not on MERGE_APPROVERS")

    if not author_fams:
        d.notes.append(
            "No commit trailer names an authoring model, so the family half of the "
            "independence check had nothing to compare against. The identity check "
            "still applied. Empty trailers mean 'nothing was recorded', which is not "
            "the same as 'a human wrote it'.")

    if state.upper() != "OPEN":
        return d.refuse(f"the pull request is {state.lower()}, not open")
    if is_draft:
        return d.refuse("it is still a draft - mark it ready for review first")
    if mergeable.upper() == "UNKNOWN":
        # NOT a conflict. GitHub computes mergeability asynchronously and serves
        # null while it works, which load_pr renders as "UNKNOWN". Folding that
        # into the branch below told the reader "approval cannot resolve a
        # conflict" about branches that merge cleanly -- #424 was refused this
        # way on 2026-09-09 and reported MERGEABLE/CLEAN minutes later. The
        # caller polls before asking (resolve_mergeability); reaching here means
        # it stayed unknown, which is still "we could not tell", never "no".
        return d.refuse("GitHub has not finished computing mergeability, so the gate "
                        "could not tell whether this merges - the approval still "
                        "stands and re-running the gate is all this needs")
    if mergeable.upper() != "MERGEABLE":
        return d.refuse(f"git reports {mergeable.lower()} - approval cannot resolve a conflict")

    if ci == "unknown":
        return d.refuse("the CI state could not be read - a rollup nobody could fetch is not a pass")
    if ci == "fail":
        return d.refuse("CI is failing")
    if ci == "pending":
        return d.refuse("CI has not finished")
    if ci == "none":
        d.notes.append("No CI is configured on this repository, so nothing was verified "
                       "mechanically before merging. That is a property of the repo, not a pass.")

    # Independence was ESTABLISHED above, not assumed from the approver being human.
    # What follows only describes the rest of the review landscape for the record.
    machine = {f for f in reviewer_families if f not in {"human", "unknown-bot"}}
    shared = machine & author_fams
    if shared:
        d.notes.append(f"Other reviews on this PR share base weights with its author "
                       f"({', '.join(sorted(shared))}); those were not counted toward "
                       f"independence.")
    independent = machine - author_fams
    d.notes.append(f"Independent reviewer families present: {', '.join(sorted(independent))}"
                   if independent
                   else "No other independent machine review was present at merge time.")
    return d


def render_audit(pr_number: int, approver: str, approval_source: str, reference: str,
                 decision: Decision, ci: str, when: datetime,
                 evidence: dict | None = None) -> str:
    """The comment left on the PR.

    ⚠ AN ALLOWED MERGE MUST LEAVE EVIDENCE, NOT JUST HAPPEN. Every failure in this
    estate this week was something that left no trace: a merged fix that never
    deployed, a review that repeated itself because nothing recorded what the last
    round settled, a counter that reported zero because it read the wrong record.
    So the audit names the specific things a later reader would otherwise have to
    reconstruct and could get wrong: WHICH review authorised this (by id, which is
    permanent and unambiguous), WHICH commit it approved, and WHY that approver was
    treated as independent of the author.

    The refusal path carries the same detail. A refusal nobody can act on produces a
    retry, and a retry against an unstated reason is a guess.
    """
    ev = evidence or {}
    head = "Merged" if decision.merge else "Merge refused"
    lines = [
        AUDIT_MARKER,
        f"### {head} - approval by `{approver}`",
        "",
        f"| | |",
        f"|---|---|",
        f"| approved by | `{approver}` ({ev.get('approver_family') or 'family not in the table'}) |",
        f"| review id | {ev.get('review_id') or 'n/a'} |",
        f"| approved commit | `{(ev.get('approved_sha') or 'unknown')[:12]}` |",
        f"| authored by (commit trailers) | {', '.join(sorted(ev.get('author_families') or [])) or 'no trailer named a model'} |",
        f"| committers on this PR | {', '.join(sorted(ev.get('committers') or [])) or 'none resolved'} |",
        f"| approval reached the gate as | {approval_source} |",
        f"| reference | {reference or 'n/a'} |",
        f"| CI at decision time | {ci} |",
        f"| decided | {when.isoformat(timespec='seconds')} |",
        "",
    ]
    if decision.merge:
        lines += [
            "**Independence established, not assumed.** The approving principal is not a",
            "committer on this pull request, and its model family does not appear in the",
            "commit trailers. The property this gate enforces is that the verdict came from",
            "a process the merging session could not author - different weights is a",
            "consequence of that, checked second, and never sufficient on its own.",
            "",
            "Merge followed mechanically from that approval. Approval is the decision point;",
            "the button is not a second one.",
            "",
        ]
    else:
        lines += ["> [!CAUTION]", "> **Not merged.** " + " ".join(decision.reasons), ""]
    for note in decision.notes:
        lines.append(f"- {note}")
    lines += ["", f"<sub>`tools/pr_merge_gate.py` - the gate is in the repo because branch "
                  f"protection is a paid feature here and `--auto` would have no approval to "
                  f"wait on.</sub>"]
    return "\n".join(lines)


# ---------------------------------------------------------------------------


def load_pr(repo: str, number: int) -> dict:
    return gh_json([
        "pr", "view", str(number), "--repo", repo,
        "--json", "number,title,url,isDraft,state,mergeable,baseRefName,headRefName,headRefOid,"
                  "reviews,statusCheckRollup",
    ])


def resolve_mergeability(fetch, attempts: int = 6, sleep_s: float = 5.0) -> dict:
    """Re-read the PR until GitHub settles `mergeable`, or give up saying so.

    `mergeable` is null until GitHub has computed the merge commit, and the
    merge-on-approval workflow fires within seconds of the review -- squarely
    inside that window. A single read is therefore a coin toss, and the gate
    used to lose it silently. A settled answer (MERGEABLE or CONFLICTING) is
    returned on the first read and never re-polled.
    """
    pr = fetch()
    for _ in range(max(0, attempts - 1)):
        if (pr.get("mergeable") or "UNKNOWN").upper() != "UNKNOWN":
            return pr
        if sleep_s:
            time.sleep(sleep_s)
        pr = fetch()
    return pr


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--approver", required=True, help="login of the approving human")
    ap.add_argument("--approver-type", default="User", help="GitHub account type (User/Bot)")
    ap.add_argument("--approval-source", default="github-review", choices=APPROVAL_SOURCES)
    ap.add_argument("--review-state", default="APPROVED")
    ap.add_argument(
        "--approved-sha", default=os.environ.get("APPROVED_SHA", ""),
        help=(
            "head commit the approval was submitted against. If given and it does "
            "not match the PR head at merge time, the merge is refused."
        ),
    )
    ap.add_argument("--reference", default="",
                    help="review URL, or the session reference for a conversation approval")
    ap.add_argument("--approvers", default=os.environ.get("MERGE_APPROVERS", ""),
                    help="allowlist; defaults to $MERGE_APPROVERS")
    ap.add_argument("--merge-method", default="squash",
                    choices=["squash", "merge", "rebase"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not args.repo:
        args.repo = gh_json(["repo", "view", "--json", "nameWithOwner"])["nameWithOwner"]

    # Poll rather than accept the first read: the workflow fires seconds after
    # the review, inside the window where GitHub still serves mergeable=null.
    pr = resolve_mergeability(lambda: load_pr(args.repo, args.pr))
    commits = gh_json(["api", f"repos/{args.repo}/pulls/{args.pr}/commits", "--paginate"]) or []
    fams = author_families([(c.get("commit") or {}).get("message", "") for c in commits])

    # WHO WROTE IT. Both halves matter and they answer different questions: the login
    # says which ACCOUNT pushed, the trailers say which MODEL wrote. In this estate
    # every commit is pushed by one account whatever produced it, so the logins alone
    # would make every approver look independent.
    committers = {normalise_login((c.get("author") or {}).get("login") or "")
                  for c in commits}
    committers |= {normalise_login((c.get("committer") or {}).get("login") or "")
                   for c in commits}
    committers.discard("")

    # ⚠ REVIEWS COME FROM REST, NOT FROM `gh pr view --json reviews`, WHICH OMITS THE
    # COMMIT OID. Without the oid there is nothing to pin an approval to, and the
    # head-pinning check would silently degrade to "an approval exists somewhere".
    rest_reviews = gh_json(
        ["api", f"repos/{args.repo}/pulls/{args.pr}/reviews", "--paginate"]) or []
    reviews_for_gate = [
        {"state": r.get("state"),
         "commit": {"oid": r.get("commit_id")},
         "id": r.get("id"),
         "login": ((r.get("user") or {}).get("login") or "")}
        for r in rest_reviews
    ]
    head_oid = pr.get("headRefOid") or ""

    # An objection stays live until it is withdrawn or superseded by the SAME
    # principal. A later approval from someone else does not answer it.
    latest_by_login: dict[str, str] = {}
    for r in reviews_for_gate:
        st = (r.get("state") or "").upper()
        if st in ("APPROVED", "CHANGES_REQUESTED"):
            latest_by_login[normalise_login(r["login"])] = st
    changes_requested_by = {lg for lg, st in latest_by_login.items()
                            if st == "CHANGES_REQUESTED"}

    allow = parse_approvers(args.approvers)

    def _qualifies(r):
        """Prefer an approval that would actually pass the gate, over the newest."""
        lg = normalise_login(r.get("login") or "")
        return bool(lg) and lg in allow and not deny_self_approval(lg, committers, fams)

    approval, approval_problem = approving_review(reviews_for_gate, head_oid, _qualifies)
    # The APPROVER IS READ OFF THE APPROVAL, not taken from the caller. This tool is
    # run by the same kind of session that opens these pull requests; an authorisation
    # it could assert on its own command line would authorise nothing.
    if approval:
        # NO FALLBACK TO THE CALLER. `approving_review` guarantees a non-empty login,
        # so this cannot silently become args.approver -- which was the hole a reviewer
        # found in the first version of this file, and it was the exact hole this file
        # exists to close: the identity must come from the record, or not at all.
        args.approver = approval["login"]
        args.review_state = "APPROVED"
        args.approved_sha = (approval.get("commit") or {}).get("oid") or args.approved_sha
    elif approval_problem:
        args.review_state = "NONE"

    reviewer_families = set()
    for rv in pr.get("reviews") or []:
        a = rv.get("author") or {}
        login = a.get("login", "")
        if login:
            reviewer_families.add(
                classify_reviewer(login, bool(a.get("is_bot"))
                                  or normalise_login(login) in FAMILY_BY_LOGIN))

    ci = ci_for(pr)
    decision = evaluate(
        approver=args.approver,
        approver_type=args.approver_type,
        approval_source=args.approval_source,
        allowlist=parse_approvers(args.approvers),
        review_state=args.review_state,
        is_draft=bool(pr.get("isDraft")),
        state=pr.get("state") or "OPEN",
        mergeable=pr.get("mergeable") or "UNKNOWN",
        ci=ci,
        reviewer_families=reviewer_families,
        author_fams=fams,
        committers=committers,
        changes_requested_by=changes_requested_by,
    )
    # The specific reason no approval qualified, rather than a generic state refusal.
    if approval_problem and not decision.merge:
        decision.reasons = [approval_problem] + [
            r for r in decision.reasons if "review state" not in r]

    audit = render_audit(args.pr, args.approver, args.approval_source,
                         args.reference, decision, ci, datetime.now(timezone.utc),
                         evidence={
                             "review_id": (approval or {}).get("id"),
                             "approved_sha": args.approved_sha or head_oid,
                             "approver_family": FAMILY_BY_LOGIN.get(
                                 normalise_login(args.approver)),
                             "author_families": fams,
                             "committers": committers,
                         })
    print(audit)

    if args.dry_run:
        print(f"\n[dry-run] would {'MERGE' if decision.merge else 'REFUSE'} #{args.pr}")
        return 0 if decision.merge else 2

    gh(["api", "-X", "POST", f"repos/{args.repo}/issues/{args.pr}/comments",
        "--input", "-"], stdin=json.dumps({"body": audit}))

    if not decision.merge:
        print(f"REFUSED: {' '.join(decision.reasons)}", file=sys.stderr)
        return 2

    stale = stale_approval_reason(args.approved_sha, pr.get("headRefOid"))
    if stale:
        raise SystemExit(f"refusing: {stale}")

    gh(["pr", "merge", str(args.pr), "--repo", args.repo, f"--{args.merge_method}"])

    # Confirm from the API that it really merged, rather than trusting the call.
    # `gh pr merge` prints NOTHING on success, so silent success and silent
    # failure look identical -- that cost this estate two false "merged" reports
    # on 2026-08-22 before anyone thought to fetch and check the SHA. An audit
    # record that says "merged" when nothing merged is worse than no record.
    after = gh_json(["pr", "view", str(args.pr), "--repo", args.repo,
                     "--json", "state,mergeCommit"])
    if (after.get("state") or "").upper() != "MERGED":
        raise SystemExit(
            f"merge did not take effect: #{args.pr} is state="
            f"{after.get('state')!r} after the merge call"
        )
    merge_sha = (after.get("mergeCommit") or {}).get("oid") or "unknown"
    print(f"merged -> {merge_sha}")
    print(f"Merged #{args.pr} by {args.merge_method}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

