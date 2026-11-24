#!/usr/bin/env python3
"""Lane 6 audience-fit prompt (PROVENANCE_NARRATION, OFF_AUDIENCE), measured K times.

prompts/audience-fit.txt is generated from the shipped prompt with the
grounding note filled in (see README.md). The fixture is copied (minus
expected.json) into a fresh git repo and the prompt runs once over the whole
file, as lane6.mjs dispatches it. Every call runs under isolated_config(), so
user-level plugins and CLAUDE.md cannot leak into the measurement. A failed
call fails its run; it never counts as clean.

Ship gate (spec, Round 16 in REPORT.md): every run succeeds, every planted
item is found in at least runs - 1 runs (4 of 5 at the default K=5), no
control is flagged in any run, and no run has an unassigned finding. The
fixture plants every failure it contains, so a finding that matches no
planted item is a false positive.
"""
import argparse, json, os
from concurrent.futures import ThreadPoolExecutor
from run_repodrift import isolated_config, one_run, score

HERE = os.path.dirname(os.path.abspath(__file__))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=os.path.join(HERE, "fixtures/audience-fit"))
    ap.add_argument("--prompt", default=os.path.join(HERE, "prompts/audience-fit.txt"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", help="write per-run findings and the summary as JSON")
    a = ap.parse_args()
    expected = json.load(open(os.path.join(a.fixture, "expected.json")))
    template = open(a.prompt).read()

    with isolated_config() as env, ThreadPoolExecutor(max_workers=min(3, a.runs)) as ex:
        runs = list(ex.map(lambda _: one_run(a.fixture, template, doc="DOC.md", env=env), range(a.runs)))

    ok = [f for f, err in runs if f is not None]
    for f, err in runs:
        if f is None:
            print(f"FAILED RUN: {err}")
    hits = {d["id"]: 0 for d in expected["planted"]}
    flagged = {c["id"]: 0 for c in expected["controls"]}
    fps = []
    for findings in ok:
        found, ctl, fp = score(findings, expected)
        for k, v in found.items():
            hits[k] += v
        for k, v in ctl.items():
            flagged[k] += v
        fps.append(fp)

    n = len(ok)
    print(f"runs ok: {n}/{a.runs}")
    for k, v in hits.items():
        print(f"  planted {k:22} {v}/{n}")
    for k, v in flagged.items():
        print(f"  control {k:22} flagged {v}/{n}")
    print(f"  unassigned findings per run: {fps}")
    gate = (n == a.runs and all(v >= a.runs - 1 for v in hits.values())
            and not any(flagged.values()) and not any(fps))
    print(f"SHIP GATE: {'PASS' if gate else 'FAIL'}")
    if a.out:
        json.dump({"runs": [f for f, _ in runs], "hits": hits, "controls": flagged, "unassigned": fps,
                   "errors": [err for _, err in runs], "gate": gate},
                  open(a.out, "w"), indent=2)

if __name__ == "__main__":
    main()
