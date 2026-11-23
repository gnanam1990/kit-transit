"""Launch an isolated local Gno chain for a normal signed custody exercise."""

import base64
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

repo = pathlib.Path.cwd()
helpers = pathlib.Path(__file__).resolve().parent
proof = (
    pathlib.Path(env_output)
    if (env_output := os.getenv("KIT_QA_OUTPUT"))
    else repo / ".local" / "qa"
)
proof.mkdir(parents=True, exist_ok=True)
tools = repo / ".tools/bin"
env = dict(os.environ, GNOROOT=str(repo / ".tools/src/gno"))
chain = "kit-qa-local"
realm = "gno.land/r/kittransit/custody"


def run(args, stdin="", check=True):
    p = subprocess.run(
        list(map(str, args)),
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if check and p.returncode:
        raise RuntimeError("command failed: " + (p.stderr + p.stdout)[-1100:])
    return p.returncode, p.stdout + p.stderr


with tempfile.TemporaryDirectory(prefix="kit-probe-") as tmp:
    tmp = pathlib.Path(tmp)
    pwd = secrets.token_urlsafe(24)
    root = tmp / "custody"
    shutil.copytree(
        repo / "realm" / realm, root, ignore=shutil.ignore_patterns("*test.gno")
    )
    src_hash = hashlib.sha256(
        b"".join(p.read_bytes() for p in sorted(root.glob("*.gno")))
    ).hexdigest()
    addr = {}
    for name in ["registrar", "institutionA", "institutionB"]:
        h = tmp / name
        h.mkdir(mode=0o700)
        args = [
            tools / "gnokey",
            "add",
            "-home",
            h,
            "-insecure-password-stdin",
            "-nobackup",
        ] + [name]
        run(args, pwd + "\n" + pwd + "\n")
        _, s = run([tools / "gnokey", "list", "-home", h])
        addr[name] = re.search(r"\bg1[a-z0-9]{38}\b", s).group()
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    rpc = "127.0.0.1:" + str(port)
    cmd = [
        tools / "gnodev",
        "local",
        "-home",
        tmp / "node",
        "-no-watch",
        "-no-web",
        "-unsafe-api=false",
        "-node-rpc-listener",
        rpc,
        "-chain-id",
        chain,
        "-deploy-key",
        addr["registrar"],
    ]
    for a in addr.values():
        cmd += ["-add-account", a + "=100000000000ugnot"]
    node = subprocess.Popen(
        list(map(str, cmd + ["."])),
        cwd=root,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    result = {"chain": chain, "source_digest": src_hash, "receipts": []}
    try:
        for _ in range(80):
            if node.poll() is not None:
                raise RuntimeError("node exited")
            try:
                with urlopen("http://" + rpc + "/status", timeout=0.8) as r:
                    if json.load(r)["result"]["node_info"]["network"] == chain:
                        break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("local node startup timed out")

        def call(who, fn, *args, refusal=None):
            cmd = [
                tools / "gnokey",
                "maketx",
                "call",
                "-home",
                tmp / who,
                "-remote",
                rpc,
                "-chainid",
                chain,
                "-insecure-password-stdin",
                "-gas-fee",
                "1000000ugnot",
                "-gas-wanted",
                "50000000",
                "-pkgpath",
                realm,
                "-func",
                fn,
            ]
            for a in args:
                cmd += ["-args", str(a)]
            code, s = run(cmd + [who], pwd + "\n", check=refusal is None)
            if refusal is not None:
                assert code != 0 and refusal in s, "expected domain refusal: " + refusal
                return
            tx = re.search(
                r"(?:tx hash|txhash|hash)\s*[:=]\s*([A-Za-z0-9+/]{43}=)", s, re.I
            )
            if not tx:
                raise RuntimeError(fn + " receipt unavailable " + s[-600:])
            result["receipts"].append(
                {
                    "function": fn,
                    "signer": who,
                    "sha256": base64.b64decode(tx.group(1)).hex(),
                }
            )

        def query(expr):
            _, s = run(
                [
                    tools / "gnokey",
                    "query",
                    "-data",
                    realm + "." + expr,
                    "-remote",
                    rpc,
                    "vm/qeval",
                ]
            )
            v = re.search(r'data: \(("(?:\\.|[^"\\])*") .*\)', s)
            return json.loads(json.loads(v.group(1)))

        for attempt in range(30):
            code, bootstrap = run(
                [
                    tools / "gnokey",
                    "query",
                    "-data",
                    realm + ".Registrar()",
                    "-remote",
                    rpc,
                    "vm/qeval",
                ],
                check=False,
            )
            if code == 0:
                break
            time.sleep(0.35)
        if code:
            raise RuntimeError("registrar query failed: " + bootstrap[:600])
        assert addr["registrar"] in bootstrap, (
            "The deployed realm must bind registrar to this disposable deployer"
        )
        call("registrar", "EnrollOrg", "enroll-a", "A", addr["institutionA"])
        call("registrar", "EnrollOrg", "enroll-b", "B", addr["institutionB"])
        parts = ["body", "lens", "strap", "cable", "card", "cap"]
        call(
            "institutionA",
            "DefineManifest",
            "define",
            "camera",
            ";".join(p + ":1:1:unit:" + p for p in parts),
            "inspect-each-return",
        )
        call(
            "institutionA",
            "Dispatch",
            "ship",
            "camera",
            "B",
            1,
            "",
            ";".join(p + ":1" for p in parts),
        )
        leg = query('GetKit("camera")')["activeLeg"]
        if "--retry" in sys.argv:
            args0 = ["camera", "B", 1, "", ";".join(p + ":1" for p in parts)]
            before = query('GetKit("camera")')
            original = query('GetOp("A","ship")')
            call("institutionA", "Dispatch", "ship", *args0)
            call(
                "institutionA",
                "Dispatch",
                "ship",
                *args0[:-1],
                "lens:1",
                refusal="operation id conflict",
            )
            call("institutionA", "Dispatch", "ship-again", *args0, refusal="active leg")
            after = query('GetKit("camera")')
            replay = query('GetOp("A","ship")')
            clean = lambda x: {k: v for k, v in x.items() if k != "height"}
            assert clean(before) == clean(after) and clean(original) == clean(replay)
            result["replay"] = {
                "beforeRevision": before["rev"],
                "afterRevision": after["rev"],
                "activeLeg": after["activeLeg"],
                "dispatchedUnits": sum(x["inTransit"] for x in after["lines"]),
                "duplicateChangedQuantity": False,
            }
        call(
            "institutionB",
            "ReceiveDelta",
            "receive",
            leg,
            ";".join(p + ":1" for p in parts if p != "lens"),
            "",
            "lens:1",
            "lens missing",
        )
        result["kit"] = query('GetKit("camera")')
        result["leg"] = query("GetLeg(" + json.dumps(leg) + ")")
        result["exceptions"] = query('GetExceptions("camera")')
        assert (
            sum(result["leg"]["accepted"].values()) == 5
            and result["leg"]["outstanding"]["lens"] == 1
        )
        assert result["kit"]["hold"] and not result["kit"]["available"]
        assert result["exceptions"]["exceptions"][0]["line"] == "lens"

        def project(stage):
            _, data = run(
                [
                    "node",
                    "--disable-warning=ExperimentalWarning",
                    "--experimental-transform-types",
                    helpers / "projection.mjs",
                    rpc,
                    stage,
                ]
            )
            result.setdefault("projection", []).append(
                json.loads(data.strip().splitlines()[0])
            )
            if stage == "partial":
                env["KIT_QA_EPHEMERAL_PASS"] = pwd
                try:
                    _, resp = run(
                        [
                            "node",
                            "--disable-warning=ExperimentalWarning",
                            "--experimental-transform-types",
                            helpers / "staff.mjs",
                            rpc,
                            addr["institutionA"],
                            tmp / "institutionA",
                            stage,
                        ]
                    )
                    result["staffSignIn"] = json.loads(resp.strip().splitlines()[0])
                finally:
                    env.pop("KIT_QA_EPHEMERAL_PASS", None)

        project("partial")
        if "--recovery" in sys.argv:
            call(
                "institutionA",
                "ResolveException",
                "close-missing",
                result["exceptions"]["exceptions"][0]["id"],
                "close-unreceived",
                "await partner search",
            )
        else:
            call(
                "institutionB",
                "ReceiveDelta",
                "receive-lens",
                leg,
                "lens:1",
                "",
                "",
                "late lens",
            )
            call(
                "institutionA",
                "ResolveException",
                "reconcile",
                result["exceptions"]["exceptions"][0]["id"],
                "resolved",
                "late receipt checked",
            )
        call("institutionB", "CloseLeg", "close-out", leg)
        qty = ";".join(p + ":1" for p in parts)
        recovery = "--recovery" in sys.argv
        qty = ";".join(p + ":1" for p in parts if not recovery or p != "lens")
        call("institutionB", "StartReturn", "send-back", "camera", qty)
        back = query('GetKit("camera")')["activeLeg"]
        call(
            "institutionA",
            "ReceiveDelta",
            "received-return",
            back,
            qty,
            "",
            "",
            "received",
        )
        call("institutionA", "CloseLeg", "close-back", back)
        if recovery:
            result["beforeRecovery"] = query('GetKit("camera")')
            prior = result["beforeRecovery"]
            assert prior["hold"] and not prior["available"]
            assert sum(x["held"].get("A", 0) for x in prior["lines"]) == 5
            assert (
                next(x for x in prior["lines"] if x["id"] == "lens")["unlocated"] == 1
            )
            call("institutionB", "ReportFound", "found", "camera", "lens", 1, leg)
            claim = query('GetClaims("camera")')["claims"][0]["id"]
            call("institutionA", "ConfirmRecovery", "confirm", claim)
            recovered = query('GetKit("camera")')
            lens = next(x for x in recovered["lines"] if x["id"] == "lens")
            assert lens["unlocated"] == 0 and lens["held"]["B"] == 1
            call("institutionB", "StartReturn", "return-recovered", "camera", "lens:1")
            late = query('GetKit("camera")')["activeLeg"]
            call(
                "institutionA",
                "ReceiveDelta",
                "receive-recovered",
                late,
                "lens:1",
                "",
                "",
                "lens received",
            )
            call("institutionA", "CloseLeg", "close-recovered", late)
        held = query('GetKit("camera")')
        assert (
            held["hold"]
            and not held["available"]
            and all(x["held"]["A"] == 1 for x in held["lines"])
        )
        call(
            "institutionA",
            "AssessReturn",
            "inspect",
            "camera",
            ";".join(p + ":ok" for p in parts),
        )
        call("institutionA", "ReleaseKit", "release", "camera")
        result["final"] = query('GetKit("camera")')
        assert (
            result["final"]["available"]
            and not result["final"]["hold"]
            and not result["final"]["openExceptions"]
        )
        assert all(
            x["held"]["A"] == 1 and x["assessment"] == "serviceable"
            for x in result["final"]["lines"]
        )
        project("final")
        (proof / "custody-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "chain": chain,
                    "transactions": len(result["receipts"]),
                    "final_height": result["final"]["height"],
                    "available": result["final"]["available"],
                }
            )
        )
    finally:
        node.terminate()
        try:
            node.wait(timeout=10)
        except subprocess.TimeoutExpired:
            node.kill()
            node.wait()
