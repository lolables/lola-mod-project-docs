#!/usr/bin/env python3
"""Persona walkthroughs (/docs-audit Lane 6), K runs per fixture.

Per run and fixture: copy the fixture into a fresh git repo, ask
check-walkthrough.mjs --plan for each persona's start files, run one cold
walker per persona with the Read tool only, verify each reply with --verify
(re-dispatch once on rejection, as the command does), locate every stuck
task with a search-enabled call, and classify with --classify. Scored
against expected.json: each planted case must come back with its kind (and,
for unreachable, its file); any other WALKTHROUGH_LOST is spurious. The
fabricated hop in expected.json is spliced into the persona's valid reply
and must be rejected; that check costs nothing. A locate reply the script
rejects is recorded as failed rather than re-dispatched. Every claude call
runs under isolated_config(), capped by --max-budget-usd.
"""
import argparse, json, os, re, subprocess, threading
from concurrent.futures import ThreadPoolExecutor
from string import Template
from run_repodrift import fixture_repo, isolated_config

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "module", "skills", "docs-organization", "scripts", "check-walkthrough.mjs")
FIXTURES = ["fixtures/walkthrough-repo", "fixtures/walkthrough-mkdocs"]
BUDGET = 0.5  # USD per claude call
METER = threading.Lock()  # walkers share one meta dict across threads

def node(repo, flag, payload=None):
    p = subprocess.run(["node", SCRIPT, flag], cwd=repo, input=None if payload is None else json.dumps(payload),
                       capture_output=True, text=True, timeout=120)
    if p.returncode == 2:
        raise SystemExit(f"check-walkthrough {flag} exited 2: {p.stderr}")
    return json.loads(p.stdout)

def claude(prompt, repo, tools, env, meta):
    """The reply's JSON object, or None. Adds the call and its cost to meta."""
    with METER:
        meta["calls"] += 1
    try:
        p = subprocess.run(["claude", "-p", prompt, "--output-format", "json", "--model", "sonnet",
                            "--dangerously-skip-permissions", "--max-budget-usd", str(BUDGET), "--tools", *tools],
                           cwd=repo, env=env, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None
    try:
        outer = json.loads(p.stdout)
    except json.JSONDecodeError:
        return None
    with METER:
        meta["cost_usd"] += outer.get("total_cost_usd") or 0
    text = outer.get("result") or ""
    decoder = json.JSONDecoder()
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = decoder.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None

def walker_prompt(tpl, persona, nav):
    return tpl.substitute(label=persona["label"], question=persona["question"], starts=", ".join(persona["starts"]),
                          sidebar=(", or an entry of the site's sidebar: " + ", ".join(nav)) if nav else "",
                          tasks="\n".join(f"{i}. {t}" for i, t in enumerate(persona["tasks"], 1)), id=persona["id"])

def walk(persona, nav, repo, env, meta, tpl):
    """(reply, verdict) from the first valid try of two; verdict None when no reply parsed."""
    got = (None, None)
    for _ in range(2):
        reply = claude(walker_prompt(tpl, persona, nav), repo, ["Read"], env, meta)
        got = (reply, node(repo, "--verify", reply) if reply is not None else None)
        if got[1] and got[1]["valid"]:
            break
    return got

def run_fixture(fixture, env, tpls):
    meta = {"calls": 0, "cost_usd": 0.0}
    with open(os.path.join(HERE, fixture, "expected.json")) as f:
        exp = json.load(f)
    with fixture_repo(os.path.join(HERE, fixture)) as repo:
        plan = node(repo, "--plan")
        if plan["skipped"]:
            raise SystemExit(f"{fixture}: walkthroughs skipped: {plan['skipped']}")
        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(lambda p: walk(p, plan["globalNav"], repo, env, meta, tpls["walkthrough"]), plan["personas"]))
        walks = {p["id"]: r for p, r in zip(plan["personas"], results)}
        findings, missed, failed = [], [], []
        for p in plan["personas"]:
            reply, verdict = walks[p["id"]]
            if not verdict or not verdict["valid"]:
                failed.append({"persona": p["id"], "why": verdict["rejected"][:2] if verdict else "no JSON reply"})
                continue
            located = []
            stuck = [t for t in reply["tasks"] if t["status"] == "stuck"]
            for t in stuck:
                loc = None
                for _ in range(2):
                    loc = claude(tpls["locate"].substitute(label=p["label"], concrete=t["concrete"], task=p["tasks"][t["n"] - 1]),
                                 repo, ["Read", "Grep", "Glob"], env, meta)
                    if loc is not None and "file" in loc:
                        break
                if loc is None or "file" not in loc:
                    failed.append({"persona": p["id"], "n": t["n"], "why": "locate gave no JSON" if loc is None else "locate JSON has no file key"})
                    continue
                located.append({"n": t["n"], "concrete": t["concrete"], "last": t["last"], "file": loc["file"], "line": loc.get("line")})
            if stuck:
                c = node(repo, "--classify", {"persona": p["id"], "stuck": [t["n"] for t in stuck], "located": located})
                findings += c["findings"]
                missed += c["missed"]
                if c["rejected"]:
                    failed.append({"persona": p["id"], "why": c["rejected"]})
        fab = exp["fabricated"]
        reply, verdict = walks.get(fab["persona"], (None, None))
        fabricated = {"checked": False}
        if verdict and verdict["valid"]:
            forged = dict(reply, hops=list(reply["hops"]) + [fab["hop"]])
            fabricated = {"checked": True, "rejected": not node(repo, "--verify", forged)["valid"]}
    want = {(c["persona"], c["n"]): c for c in exp["cases"]}
    got = {(f["persona"], f["n"]): f for f in findings}
    hits = {f"{p}#{n}": (got.get((p, n)) or {}).get("kind") == c["kind"]
                        and (c["kind"] != "unreachable" or c["file"] in got[(p, n)]["message"])
            for (p, n), c in want.items()}
    return {"hits": hits, "spurious": [f["message"] for k, f in got.items() if k not in want],
            "missed": missed, "failed": failed, "fabricated": fabricated,
            "calls": meta["calls"], "cost_usd": round(meta["cost_usd"], 4)}

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--k", type=int, default=1)
    ap.add_argument("--fixture", action="append", help="fixture directory relative to eval/ (default: both)")
    ap.add_argument("--out", help="write the JSON result here, relative to eval/")
    a = ap.parse_args()
    tpls = {}
    for name in ("walkthrough", "locate"):
        with open(os.path.join(HERE, "prompts", f"{name}.txt")) as f:
            tpls[name] = Template(f.read())
    rows = []
    with isolated_config() as env:
        for fixture in a.fixture or FIXTURES:
            for k in range(a.k):
                rows.append({"fixture": fixture, "run": k + 1, **run_fixture(fixture, env, tpls)})
    out = {"rows": rows, "total_cost_usd": round(sum(r["cost_usd"] for r in rows), 4)}
    print(json.dumps(out, indent=1))
    if a.out:
        with open(os.path.join(HERE, a.out), "w") as f:
            json.dump(out, f, indent=1)

if __name__ == "__main__":
    main()
