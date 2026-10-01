#!/usr/bin/env python3
"""Repo-mode content drift (Lane 6 prompt 1), measured K times.

Copies the fixture (minus expected.json, so the model never sees the ground
truth) into a fresh git repository in a temp directory, fills the prompt's
{file}/{repo_root} placeholders the way /docs-audit does, and scores each run:
recall per planted drift, how often each negative control is flagged, and
false positives (findings matching no planted item). Each finding is scored
against at most one planted item — the first one, in expected.json order,
whose groups it matches — so a finding that happens to satisfy two planted
items' groups is not double-counted.

With `--repo`, audits an existing checkout in place instead of copying a
fixture (real-document mode); `--fixture` still supplies expected.json.

With `--chunk-lines N`, the doc is split at H2/H3 headings into consecutive
groups of at most N lines (a longer single section stays whole) and the
prompt runs once per group, its {start}/{end} placeholders filled with the
group's 1-based line range. A run's findings are the union over its groups;
a run with any failed group counts as failed, never as clean.
"""
import argparse, json, os, shutil, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
from run_citeddrift import parse_findings, tok_match

HERE = os.path.dirname(os.path.abspath(__file__))
GIT_ENV = dict(os.environ,
    GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
    GIT_AUTHOR_NAME="docs-discipline eval", GIT_AUTHOR_EMAIL="eval@docs-discipline.invalid",
    GIT_COMMITTER_NAME="docs-discipline eval", GIT_COMMITTER_EMAIL="eval@docs-discipline.invalid")

def matches(finding, groups):
    blob = " ".join(str(v) for v in finding.values()).lower()
    return all(any(tok_match(t, blob) for t in g) for g in groups)

def assign(findings, planted):
    """Assign each finding to the first planted item (in expected.json
    order) whose groups it matches, so a finding never double-counts toward
    two planted items. Return (assignment, unassigned): assignment maps
    planted id -> list of matched findings; unassigned holds findings that
    matched no planted item."""
    assignment = {d["id"]: [] for d in planted}
    unassigned = []
    for f in findings:
        for d in planted:
            if matches(f, d["groups"]):
                assignment[d["id"]].append(f)
                break
        else:
            unassigned.append(f)
    return assignment, unassigned

def heading_chunks(path, max_lines):
    """Split the doc at H2/H3 headings outside code fences and coalesce
    consecutive sections into groups of at most `max_lines` lines. Return a
    list of 1-based inclusive (start, end) line ranges covering the file."""
    lines = open(path).read().splitlines()
    starts, fence = [1], False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        elif not fence and line.startswith(("## ", "### ")) and i > 1:
            starts.append(i)
    sections = list(zip(starts, [s - 1 for s in starts[1:]] + [len(lines)]))
    groups = []
    for start, end in sections:
        if groups and end - groups[-1][0] + 1 <= max_lines:
            groups[-1] = (groups[-1][0], end)
        else:
            groups.append((start, end))
    return groups

def call(prompt, cwd):
    """Return (findings-or-None, error-excerpt-or-None). The excerpt includes
    stderr when the CLI exits non-zero, since stdout alone can be empty."""
    try:
        p = subprocess.run(
            ["claude", "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json", "--model", "claude-sonnet-5"],
            cwd=cwd, capture_output=True, text=True, timeout=400, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "timeout after 400 s"
    try:
        result = json.loads(p.stdout).get("result", "")
    except json.JSONDecodeError:
        result = p.stdout
    if p.returncode != 0:
        return None, f"cli exited {p.returncode}: {result[:500]} | stderr: {p.stderr[:500]}"
    findings = parse_findings(result)
    return (None, result[:500]) if findings is None else (findings, None)

def one_run(fixture, template, repo=None, doc="README.md", chunk_lines=None):
    """Return (findings-or-None, error-excerpt-or-None).

    With `repo` given, run against that existing checkout in place (no copy,
    no git init) — the real-document lane. Otherwise copy `fixture` into a
    fresh git repository in a temp directory. With `chunk_lines`, call once
    per heading group and union the findings; any failed group fails the run."""
    work = None
    try:
        if repo is None:
            work = tempfile.mkdtemp(prefix="repo-drift-")
            repo = os.path.join(work, "repo")
            shutil.copytree(fixture, repo, ignore=shutil.ignore_patterns("expected.json"))
            for cmd in (["git", "init", "-q"], ["git", "add", "."], ["git", "commit", "-q", "-m", "fixture"]):
                subprocess.run(cmd, cwd=repo, env=GIT_ENV, check=True)
        path = os.path.join(repo, doc)
        prompt = template.replace("{file}", path).replace("{repo_root}", repo)
        if chunk_lines is None:
            return call(prompt, repo)
        findings = []
        for start, end in heading_chunks(path, chunk_lines):
            got, err = call(prompt.replace("{start}", str(start)).replace("{end}", str(end)), repo)
            if got is None:
                return None, f"lines {start}-{end}: {err}"
            findings += got
        return findings, None
    finally:
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)

def score(findings, expected):
    """Recall is per planted item's assignment (each finding counts toward at
    most one planted item). Controls, and the false-positive count, are
    evaluated only on findings unassigned to any planted item."""
    assignment, unassigned = assign(findings, expected["planted"])
    found = {d_id: bool(fs) for d_id, fs in assignment.items()}
    flagged = {c["id"]: any(matches(f, c["groups"]) for f in unassigned) for c in expected["controls"]}
    fp = len(unassigned)
    return found, flagged, fp

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=os.path.join(HERE, "fixtures/repo-drift-attribution"),
                     help="directory holding expected.json (and, in fixture mode, the doc/repo to copy)")
    ap.add_argument("--prompt", default=os.path.join(HERE, "prompts/repo-drift.txt"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", help="real-document mode: an existing repo checkout to audit in place, "
                                    "instead of copying --fixture into a fresh git repo")
    ap.add_argument("--doc", default="README.md", help="doc to audit, relative to the repo root")
    ap.add_argument("--chunk-lines", type=int, help="split the doc at H2/H3 headings into groups of at most "
                                                   "this many lines; the prompt needs {start}/{end}")
    a = ap.parse_args()
    expected = json.load(open(os.path.join(a.fixture, "expected.json")))
    template = open(a.prompt).read()
    with ThreadPoolExecutor(max_workers=min(3, a.runs)) as ex:
        runs = list(ex.map(lambda _: one_run(a.fixture, template, repo=a.repo, doc=a.doc, chunk_lines=a.chunk_lines), range(a.runs)))
    rows = []
    for findings, err in runs:
        if findings is None:
            rows.append({"failed": True, "raw": err})
            continue
        found, flagged, fp = score(findings, expected)
        rows.append({"failed": False, "found": found, "controls_flagged": flagged, "fp": fp, "findings": findings})
    ok = [r for r in rows if not r["failed"]]
    summary = {
        "prompt": os.path.relpath(a.prompt, HERE),
        "runs": a.runs,
        "chunk_lines": a.chunk_lines,
        "failed_runs": len(rows) - len(ok),
        "recall": {d["id"]: sum(r["found"][d["id"]] for r in ok) / len(ok) for d in expected["planted"]} if ok else {},
        "control_flag_rate": {c["id"]: sum(r["controls_flagged"][c["id"]] for r in ok) / len(ok) for c in expected["controls"]} if ok else {},
        "mean_fp": sum(r["fp"] for r in ok) / len(ok) if ok else None,
        "detail": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(summary, open(a.out, "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "detail"}, indent=2))

if __name__ == "__main__":
    main()
