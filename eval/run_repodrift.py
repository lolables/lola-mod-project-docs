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

With `--chunked`, the doc is split into chunks by the shipped
`md-chunks.mjs` script (heading-aligned, coalesced up to its line cap; a
longer single section stays whole) and the prompt runs once per chunk, its
{start}/{end} placeholders filled with the chunk's 1-based line range — this
measures exactly what /docs-audit ships, not a separate Python
reimplementation of the chunking rule. A run's findings are the union over
its chunks; a run with any failed chunk counts as failed, never as clean.
"""
import argparse, contextlib, json, os, re, shutil, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
from run_citeddrift import parse_findings, tok_match

HERE = os.path.dirname(os.path.abspath(__file__))
PLACEHOLDER_RE = re.compile(r"\{(file|repo_root|start|end|claims)\}")
MD_CHUNKS_SCRIPT = os.path.join(HERE, "..", "module", "skills", "docs-organization", "scripts", "md-chunks.mjs")
GIT_ENV = dict(os.environ,
    GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
    GIT_AUTHOR_NAME="docs-discipline eval", GIT_AUTHOR_EMAIL="eval@docs-discipline.invalid",
    GIT_COMMITTER_NAME="docs-discipline eval", GIT_COMMITTER_EMAIL="eval@docs-discipline.invalid")

def fill_template(template, file, repo_root, start=None, end=None, claims=None):
    """Fill {file}/{repo_root}/{start}/{end}/{claims} placeholders in a single
    re.sub pass, so a substituted value (e.g. a file path containing the
    literal text "{start}") is never re-substituted by a later .replace()
    call."""
    values = {"file": file, "repo_root": repo_root,
              "start": "" if start is None else str(start),
              "end": "" if end is None else str(end),
              "claims": "" if claims is None else str(claims)}
    return PLACEHOLDER_RE.sub(lambda m: values[m.group(1)], template)

@contextlib.contextmanager
def isolated_config():
    """Yield an env for `claude -p` whose CLAUDE_CONFIG_DIR is a fresh temp
    dir holding only a copy of the user's .credentials.json (mode 600), so a
    headless run loads no user-level plugins, hooks, commands, or CLAUDE.md.
    The dir is removed on exit. The machine's managed policy file
    (/etc/claude-code/CLAUDE.md) and the audited repo's own instruction files
    still load; real users' runs see those too."""
    src = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), ".credentials.json")
    if not os.path.isfile(src):
        raise SystemExit(f"isolated config: no credentials at {src}")
    d = tempfile.mkdtemp(prefix="eval-claude-config-")
    try:
        fd = os.open(os.path.join(d, ".credentials.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as dst, open(src, "rb") as s:
            dst.write(s.read())
        yield dict(os.environ, CLAUDE_CONFIG_DIR=d)
    finally:
        shutil.rmtree(d, ignore_errors=True)

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

def md_chunks(path):
    """Return the 1-based inclusive (start, end) line ranges `md-chunks.mjs`
    computes for `path` — the same deterministic chunker /docs-audit's Lane 6
    runs, so this eval measures the shipped behavior rather than a
    reimplementation of it."""
    out = subprocess.run(["node", MD_CHUNKS_SCRIPT, path], capture_output=True, text=True, check=True).stdout
    return [(c["start"], c["end"]) for c in json.loads(out)["chunks"]]

def call(prompt, cwd, key="findings", env=None, meta=None):
    """Return (findings-or-None, error-excerpt-or-None). The excerpt includes
    stderr when the CLI exits non-zero, since stdout alone can be empty.

    `key` selects which JSON list field `parse_findings` extracts. `env`, when
    given, replaces the subprocess environment (e.g. `isolated_config()`'s
    env). When `meta` is a dict, each call increments `meta["calls"]` and adds
    the reply's `total_cost_usd` (0 if absent) to `meta["cost_usd"]`."""
    try:
        p = subprocess.run(
            ["claude", "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json", "--model", "claude-sonnet-5"],
            cwd=cwd, env=env, capture_output=True, text=True, timeout=400, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "timeout after 400 s"
    try:
        outer = json.loads(p.stdout)
        result = outer.get("result", "")
    except json.JSONDecodeError:
        outer = {}
        result = p.stdout
    if meta is not None:
        meta.setdefault("calls", 0)
        meta.setdefault("cost_usd", 0)
        meta["calls"] += 1
        meta["cost_usd"] += outer.get("total_cost_usd", 0)
    if p.returncode != 0:
        return None, f"cli exited {p.returncode}: {result[:500]} | stderr: {p.stderr[:500]}"
    findings = parse_findings(result, key)
    return (None, result[:500]) if findings is None else (findings, None)

@contextlib.contextmanager
def fixture_repo(fixture):
    """Copy `fixture` (minus expected.json) into a fresh git repository in a
    temp directory, yield the repo path, and remove the temp dir on exit."""
    work = tempfile.mkdtemp(prefix="repo-drift-")
    try:
        repo = os.path.join(work, "repo")
        shutil.copytree(fixture, repo, ignore=shutil.ignore_patterns("expected.json"))
        for cmd in (["git", "init", "-q"], ["git", "add", "."], ["git", "commit", "-q", "-m", "fixture"]):
            subprocess.run(cmd, cwd=repo, env=GIT_ENV, check=True)
        yield repo
    finally:
        shutil.rmtree(work, ignore_errors=True)

def one_run(fixture, template, repo=None, doc="README.md", chunked=False, env=None):
    """Return (findings-or-None, error-excerpt-or-None).

    With `repo` given, run against that existing checkout in place (no copy,
    no git init) — the real-document lane. Otherwise copy `fixture` into a
    fresh git repository in a temp directory via `fixture_repo`. With
    `chunked`, call once per chunk `md-chunks.mjs` returns (a single chunk
    still fills {start}/{end}, covering the whole file) and union the
    findings; any failed chunk fails the run. `env`, when given, is passed
    through to every `call()` (e.g. `isolated_config()`'s env)."""
    ctx = fixture_repo(fixture) if repo is None else contextlib.nullcontext(repo)
    with ctx as repo:
        path = os.path.join(repo, doc)
        if not chunked:
            return call(fill_template(template, path, repo), repo, env=env)
        findings = []
        for start, end in md_chunks(path):
            got, err = call(fill_template(template, path, repo, start, end), repo, env=env)
            if got is None:
                return None, f"lines {start}-{end}: {err}"
            findings += got
        return findings, None

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
    ap.add_argument("--chunked", action="store_true", help="split the doc with md-chunks.mjs and run the prompt "
                                                   "once per chunk; the prompt needs {start}/{end}")
    ap.add_argument("--isolated", action="store_true", help="run `claude` with an isolated CLAUDE_CONFIG_DIR "
                                                   "(see isolated_config()) instead of the caller's own config")
    a = ap.parse_args()
    expected = json.load(open(os.path.join(a.fixture, "expected.json")))
    template = open(a.prompt).read()
    with contextlib.ExitStack() as stack:
        env = stack.enter_context(isolated_config()) if a.isolated else None
        with ThreadPoolExecutor(max_workers=min(3, a.runs)) as ex:
            runs = list(ex.map(lambda _: one_run(a.fixture, template, repo=a.repo, doc=a.doc, chunked=a.chunked, env=env), range(a.runs)))
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
        "isolated": a.isolated,
        "chunked": a.chunked,
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
