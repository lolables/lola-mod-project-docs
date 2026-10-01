#!/usr/bin/env python3
"""Shipped cold-read prompt (Lane 6 prompt 3), measured K times.

Scores recall per planted stumble and, when the prompt asks for it, whether
each found stumble carries the right `actionable` tag: yes for a command or
step the reader runs that fails as written, no for everything else. A prompt
without the tag (the baseline) reports tag accuracy as null. Each finding is
scored against at most one planted item — the first one, in expected.json
order, whose groups it matches — so a finding that happens to quote two
planted stumbles is not double-counted.
"""
import argparse, json, os, shutil, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
from run_citeddrift import parse_findings, tok_match

HERE = os.path.dirname(os.path.abspath(__file__))
GROUND = ("Grounding: {file} is a how-to quickstart for the recolor CLI (Diátaxis mode: how-to). "
          "Audience: a first-time user who wants to recolor the diagrams in one of their Markdown files.\n\n")

def matches(finding, groups):
    blob = " ".join(str(v) for v in finding.values()).lower()
    return all(any(tok_match(t, blob) for t in g) for g in groups)

def tag(finding):
    """True/False for a yes/no `actionable` field, None when absent."""
    v = finding.get("actionable")
    if v is None:
        return None
    return str(v).strip().lower() in ("yes", "true")

def one_run(fixture, template):
    """Return (findings-or-None, error-excerpt-or-None). The excerpt includes
    stderr when the CLI exits non-zero, since stdout alone can be empty."""
    work = tempfile.mkdtemp(prefix="cold-read-")
    try:
        doc = os.path.join(work, "DOC.md")
        shutil.copy(os.path.join(fixture, "DOC.md"), doc)
        prompt = (GROUND + template).replace("{file}", doc)
        try:
            p = subprocess.run(
                ["claude", "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json", "--model", "claude-sonnet-5"],
                cwd=work, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return None, "timeout after 300 s"
        try:
            result = json.loads(p.stdout).get("result", "")
        except json.JSONDecodeError:
            result = p.stdout
        if p.returncode != 0:
            return None, f"cli exited {p.returncode}: {result[:500]} | stderr: {p.stderr[:500]}"
        findings = parse_findings(result)
        return (None, result[:500]) if findings is None else (findings, None)
    finally:
        shutil.rmtree(work, ignore_errors=True)

def score(findings, expected):
    """Per planted id: (found, tag_correct) — tag_correct is None when not
    found or when the matching findings carry no tag. Each finding is
    assigned to at most one planted item — the first one, in expected.json
    order, whose groups it matches — so a finding that quotes two planted
    stumbles counts toward only the first. `fp` counts findings assigned to
    no planted item."""
    hits_by_id = {d["id"]: [] for d in expected["planted"]}
    fp = 0
    for f in findings:
        for d in expected["planted"]:
            if matches(f, d["groups"]):
                hits_by_id[d["id"]].append(f)
                break
        else:
            fp += 1
    out = {}
    for d in expected["planted"]:
        hits = hits_by_id[d["id"]]
        tags = [tag(f) for f in hits if tag(f) is not None]
        out[d["id"]] = (bool(hits), (d["actionable"] in tags) if tags else None)
    return out, fp

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=os.path.join(HERE, "fixtures/cold-read-actionable"))
    ap.add_argument("--prompt", default=os.path.join(HERE, "prompts/cold-read-shipped.txt"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    expected = json.load(open(os.path.join(a.fixture, "expected.json")))
    template = open(a.prompt).read()
    with ThreadPoolExecutor(max_workers=min(3, a.runs)) as ex:
        runs = list(ex.map(lambda _: one_run(a.fixture, template), range(a.runs)))
    rows = []
    for findings, err in runs:
        if findings is None:
            rows.append({"failed": True, "raw": err})
            continue
        per, fp = score(findings, expected)
        rows.append({"failed": False, "per": per, "fp": fp, "findings": findings})
    ok = [r for r in rows if not r["failed"]]
    ids = [d["id"] for d in expected["planted"]]
    def tag_acc(i):
        tagged = [r["per"][i][1] for r in ok if r["per"][i][1] is not None]
        return sum(tagged) / len(tagged) if tagged else None
    summary = {
        "prompt": os.path.relpath(a.prompt, HERE),
        "runs": a.runs,
        "failed_runs": len(rows) - len(ok),
        "recall": {i: sum(r["per"][i][0] for r in ok) / len(ok) for i in ids} if ok else {},
        "tag_accuracy": {i: tag_acc(i) for i in ids} if ok else {},
        "mean_other_findings": sum(r["fp"] for r in ok) / len(ok) if ok else None,
        "detail": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(summary, open(a.out, "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "detail"}, indent=2))

if __name__ == "__main__":
    main()
