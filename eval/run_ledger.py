#!/usr/bin/env python3
"""Two-stage claim ledger for repo-mode content drift (Round 15), K runs.

Per run: doc-chunks.mjs splits the doc; one extract call per chunk lists every
checkable claim; claims are numbered C1..Cn in document order and verified
in consecutive batches of --batch, each call returning one verdict per
claim. Ids left without a verdict are re-verified, for ATTEMPTS rounds in
all; any still missing are recorded (the LANE_FAILED analogue). Drift
verdicts are scored with run_repodrift's scorer against expected.json.
Every claude call runs under isolated_config(), so user-level plugins and
CLAUDE.md cannot leak in.
"""
import argparse, json, os, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from run_repodrift import call, fill_template, fixture_repo, isolated_config, md_chunks, score

HERE = os.path.dirname(os.path.abspath(__file__))
ATTEMPTS = 3  # first try plus two retries, as /docs-audit's empty-reply guardrail
VERDICTS = ("match", "drift", "unverifiable")

def extract(path, repo, env, meta, template):
    """Claims for every doc-chunks range, numbered C1..Cn; None plus an error
    when doc-chunks.mjs fails or a chunk yields no parseable reply after
    ATTEMPTS tries. Non-object entries in a reply are dropped."""
    try:
        ranges = md_chunks(path)
    except subprocess.CalledProcessError as e:
        return None, f"doc-chunks exited {e.returncode}: {e.stderr}"
    claims = []
    for start, end in ranges:
        for _ in range(ATTEMPTS):
            got, err = call(fill_template(template, path, repo, start, end), repo, key="claims", env=env, meta=meta)
            if got is not None:
                break
        else:
            return None, f"extract lines {start}-{end}: {err}"
        claims += [c for c in got if isinstance(c, dict)]
    return [{"id": f"C{i}", "kind": str(c.get("kind", "fact")), "line": c.get("line"), "quote": str(c.get("quote", "")),
             "target": str(c.get("target", "?"))}
            for i, c in enumerate(claims, 1)], None

def format_claims(batch):
    return "\n".join(f'{c["id"]} ({c["kind"]}, line {c["line"]}): "{c["quote"]}" — target: {c["target"]}' for c in batch)

def verify(claims, path, repo, env, meta, batch_size, template):
    """Return (verdicts, last_error): verdicts maps claim id -> verdict dict.
    Each round verifies every still-pending id in consecutive batches; a
    verdict counts only if it is an object whose id was in that batch and
    whose value is one of VERDICTS. last_error is the most recent failed
    call's excerpt (None if no call failed), kept so a run with missing ids
    says why."""
    verdicts, pending, last_error = {}, list(claims), None
    for _ in range(ATTEMPTS):
        for k in range(0, len(pending), batch_size):
            batch = pending[k:k + batch_size]
            got, err = call(fill_template(template, path, repo, claims=format_claims(batch)), repo, key="verdicts", env=env, meta=meta)
            if got is None:
                last_error = err
            ids = {c["id"] for c in batch}
            for v in got or []:
                if isinstance(v, dict) and v.get("id") in ids and v.get("verdict") in VERDICTS:
                    verdicts[v["id"]] = v
        pending = [c for c in claims if c["id"] not in verdicts]
        if not pending:
            break
    return verdicts, last_error

def ledger(path, repo, env, batch_size, prompts):
    """Return a row: drift findings, coverage, calls, cost, wall time."""
    meta, t0 = {}, time.monotonic()
    claims, err = extract(path, repo, env, meta, prompts["extract"])
    if claims is None:
        return {"failed": True, "raw": err, **meta, "wall_s": round(time.monotonic() - t0)}
    verdicts, verify_error = verify(claims, path, repo, env, meta, batch_size, prompts["verify"])
    drift = [{**c, "evidence": str(verdicts[c["id"]].get("evidence", "")), "code_says": str(verdicts[c["id"]].get("code_says", ""))}
             for c in claims if verdicts.get(c["id"], {}).get("verdict") == "drift"]
    return {"failed": False, "findings": drift, "claims": len(claims), "verdicts": len(verdicts),
            "missing": [c["id"] for c in claims if c["id"] not in verdicts],
            "verify_error": verify_error,
            "unverifiable": sum(1 for v in verdicts.values() if v["verdict"] == "unverifiable"),
            "ledger": [{**c, **verdicts.get(c["id"], {})} for c in claims],
            **meta, "wall_s": round(time.monotonic() - t0)}

def one_run(fixture, repo, doc, env, batch_size, prompts):
    if repo is not None:
        return ledger(os.path.join(repo, doc), repo, env, batch_size, prompts)
    with fixture_repo(fixture) as r:
        return ledger(os.path.join(r, doc), r, env, batch_size, prompts)

def mean(rows, k):
    return round(sum(r.get(k, 0) for r in rows) / len(rows), 3) if rows else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=os.path.join(HERE, "fixtures/repo-drift-attribution"))
    ap.add_argument("--repo", help="audit an existing checkout in place (real-document mode)")
    ap.add_argument("--doc", default="README.md")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--batch", type=int, default=10)
    ap.add_argument("--extract", default=os.path.join(HERE, "prompts/ledger-extract.txt"))
    ap.add_argument("--verify", default=os.path.join(HERE, "prompts/ledger-verify.txt"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    expected = json.load(open(os.path.join(a.fixture, "expected.json")))
    prompts = {"extract": open(a.extract).read(), "verify": open(a.verify).read()}
    with isolated_config() as env, ThreadPoolExecutor(max_workers=min(3, a.runs)) as ex:
        rows = list(ex.map(lambda _: one_run(a.fixture, a.repo, a.doc, env, a.batch, prompts), range(a.runs)))
    for r in rows:
        if not r["failed"]:
            r["found"], r["controls_flagged"], r["fp"] = score(r["findings"], expected)
    ok = [r for r in rows if not r["failed"]]
    summary = {
        "runs": a.runs, "batch": a.batch, "isolated": True,
        "prompts": [os.path.relpath(a.extract, HERE), os.path.relpath(a.verify, HERE)],
        "failed_runs": len(rows) - len(ok),
        "recall": {d["id"]: sum(r["found"][d["id"]] for r in ok) / len(ok) for d in expected["planted"]} if ok else {},
        "control_flag_rate": {c["id"]: sum(r["controls_flagged"][c["id"]] for r in ok) / len(ok) for c in expected["controls"]} if ok else {},
        "mean_fp": mean(ok, "fp"),
        "mean_claims": mean(ok, "claims"),
        "verdict_completeness": round(sum(r["verdicts"] for r in ok) / max(1, sum(r["claims"] for r in ok)), 3) if ok else None,
        "runs_with_missing": sum(1 for r in ok if r["missing"]),
        "mean_calls": mean(rows, "calls"), "mean_cost_usd": mean(rows, "cost_usd"), "mean_wall_s": mean(rows, "wall_s"),
        "detail": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(summary, open(a.out, "w"), indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "detail"}, indent=2))

if __name__ == "__main__":
    main()
