"""
deploy.py — Regenerate Meridian data, build the site, and rsync it to the server.

Steps (each can be skipped):
    1. steady_states data   (cd <xija_repo> && python -m xija_steady_states --output-dir <meridian>/steady_states)
    2. model_dash data      python -m chandra_model_eval --trailing-days N model_dash/data <models_root>
    3. build                build.build("dist", force=True), then normalize permissions
    4. deploy               rsync -a dist/ <dest>/   (over SSH, never deletes remote files)

Any failure stops the run before anything is sent to the server.

Usage:
    python deploy.py                         # all steps, settings from deploy_config.json
    python deploy.py --skip-model-dash       # reuse existing model_dash/data/
    python deploy.py --skip-data             # build + deploy only
    python deploy.py --no-deploy             # regenerate + build, don't sync
    python deploy.py --dry-run               # show what rsync would change; no generation
    python deploy.py --log-file deploy.log   # for cron: also log to a file

Must run inside the Ska environment (both generators import xija/cheta and need SKA set).
On the deployment host, run it through deploy.csh, which sources the Ska setup script first.

Exit codes: 0 success; 1 a step failed; 2 bad configuration; 3 another run holds the lock.
"""
import argparse
import contextlib
import io
import fcntl
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import build

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "deploy_config.json"
LOCK_FILE = ROOT / ".deploy.lock"

DEFAULTS = {
    "dest": None,                                # user@host:/path/to/webroot (required to deploy)
    "xija_repo": "~/AXAFLIB/xija_steady_states", # not pip-installed: run from its checkout
    "models_root": "~/AXAFLIB/chandra_models",   # chandra_models checkout for chandra_model_eval
    "model_days": 1096,                          # model_dash window: trailing days ending today (~3 years)
    "ssh_options": ["-o", "BatchMode=yes"],      # fail instead of prompting (needed under cron)
}

log = logging.getLogger("meridian.deploy")


class StepFailed(Exception):
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_config(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if path.exists():
        cfg.update(json.loads(path.read_text()))
    elif path != DEFAULT_CONFIG:
        raise SystemExit(f"Config file not found: {path}")
    return cfg


def run(cmd: list, env: dict, cwd: Path = ROOT) -> None:
    """Run a command, streaming its output into the log. Raise StepFailed on non-zero exit."""
    log.info("$ %s%s", "" if cwd == ROOT else f"(cd {cwd}) ", shlex.join(str(c) for c in cmd))
    t0 = time.monotonic()
    proc = subprocess.Popen(
        [str(c) for c in cmd], cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    for line in proc.stdout:
        log.info("  %s", line.rstrip())
    rc = proc.wait()
    elapsed = time.monotonic() - t0
    if rc != 0:
        name = str(cmd[2]) if str(cmd[1]) == "-m" else Path(str(cmd[0])).name
        raise StepFailed(f"{name} exited with code {rc} after {elapsed:.0f}s")
    log.info("  done in %.0fs", elapsed)


def normalize_permissions(tree: Path) -> None:
    """Directories 755, files 644, so the web server can read everything and nothing is executable.

    Done here rather than with rsync --chmod because macOS's bundled openrsync rejects
    'D755,F644' and silently ignores the other --chmod forms.
    """
    for dirpath, dirnames, filenames in os.walk(tree):
        os.chmod(dirpath, 0o755)
        for name in filenames:
            os.chmod(os.path.join(dirpath, name), 0o644)


def check_environment(args, cfg) -> None:
    """Fail fast (exit 2) on problems that would otherwise surface minutes into a run."""
    problems = []
    generating = not args.skip_steady_states or not args.skip_model_dash
    # SKA comes from the Ska setup script (deploy.csh sources it); never set here.
    # Checked before the imports below, because kadi reads os.environ["SKA"] at import time.
    ska = os.environ.get("SKA")
    ska_ok = bool(ska) and Path(ska).is_dir()
    if generating and not ska:
        problems.append("SKA is not set: run via deploy.csh, or set up the Ska environment first")
    elif generating and not ska_ok:
        problems.append(f"SKA directory does not exist: {ska}")

    def importable(module):
        try:
            __import__(module)
            return True
        except Exception as e:  # not just ImportError: Ska packages can fail on a broken environment
            problems.append(f"cannot import {module} ({type(e).__name__}: {e}); not in the Ska environment?")
            return False

    if not args.skip_steady_states:
        pkg = Path(cfg["xija_repo"]).expanduser() / "xija_steady_states" / "__main__.py"
        if not pkg.exists():
            problems.append(f"xija_repo is not a xija_steady_states checkout: {cfg['xija_repo']}")
        if ska_ok:
            importable("xija")
    if not args.skip_model_dash:
        if not Path(cfg["models_root"]).expanduser().is_dir():
            problems.append(f"models_root does not exist: {cfg['models_root']}")
        if ska_ok:
            importable("chandra_model_eval")
    if not args.no_deploy:
        if not cfg["dest"]:
            problems.append('no destination: set "dest" in deploy_config.json or pass --dest')
        if not shutil.which("rsync"):
            problems.append("rsync not found on PATH")
    if problems:
        for p in problems:
            log.error("config: %s", p)
        sys.exit(2)


# ── Steps ─────────────────────────────────────────────────────────────────────

def gen_steady_states(env: dict, cfg: dict, force: bool) -> None:
    log.info("── steady_states data ──")
    cmd = [sys.executable, "-m", "xija_steady_states", "--output-dir", ROOT / "steady_states"]
    if force:
        cmd.append("--force")
    run(cmd, env, cwd=Path(cfg["xija_repo"]).expanduser())


def gen_model_dash(env: dict, cfg: dict) -> None:
    log.info("── model_dash data (trailing %s days) ──", cfg["model_days"])
    models_root = Path(cfg["models_root"]).expanduser()
    tag = subprocess.run(["git", "-C", str(models_root), "describe", "--tags", "--always"],
                         capture_output=True, text=True).stdout.strip()
    log.info("chandra_models: %s (%s)", models_root, tag or "not a git checkout")
    data_dir = ROOT / "model_dash" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    run([sys.executable, "-m", "chandra_model_eval",
         "--trailing-days", str(cfg["model_days"]),
         data_dir, models_root,
         "--log-file", data_dir / "run.log"], env)


def build_site(dist: Path) -> None:
    log.info("── build ──")
    out = io.StringIO()  # build.py reports with print(); route it into the log
    with contextlib.redirect_stdout(out):
        build.build(dist, force=True)
    for line in out.getvalue().splitlines():
        log.info("  %s", line)
    normalize_permissions(dist)
    for junk in dist.rglob(".DS_Store"):
        junk.unlink()


def deploy(dist: Path, cfg: dict, dry_run: bool) -> None:
    log.info("── deploy to %s%s ──", cfg["dest"], " (dry run)" if dry_run else "")
    ssh = " ".join(["ssh", *cfg["ssh_options"]])
    cmd = ["rsync", "-a", "-z", "-e", ssh, "--itemize-changes"]
    if dry_run:
        cmd.append("-n")
    cmd += [f"{dist}/", cfg["dest"].rstrip("/") + "/"]
    run(cmd, os.environ.copy())


# ── Main ──────────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG,
                   help="JSON settings file (default: deploy_config.json)")
    p.add_argument("--dest", help="override config 'dest' (user@host:/path/to/webroot)")
    p.add_argument("--model-days", type=int, help="override config 'model_days'")
    p.add_argument("--skip-steady-states", action="store_true", help="don't regenerate steady_states/data/")
    p.add_argument("--skip-model-dash", action="store_true", help="don't regenerate model_dash/data/")
    p.add_argument("--skip-data", action="store_true", help="shorthand for both --skip-* flags")
    p.add_argument("--steady-states-force", action="store_true",
                   help="pass --force to xija_steady_states (recompute every date)")
    p.add_argument("--no-deploy", action="store_true", help="stop after the build")
    p.add_argument("--dry-run", action="store_true",
                   help="skip data generation; build, then show what rsync would change without sending")
    p.add_argument("--log-file", type=Path, help="also append log output to this file")
    args = p.parse_args(argv)

    handlers = [logging.StreamHandler()]
    if args.log_file:
        handlers.append(logging.FileHandler(args.log_file))
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")

    cfg = load_config(args.config)
    if args.dest:
        cfg["dest"] = args.dest
    if args.model_days:
        cfg["model_days"] = args.model_days
    if args.skip_data or args.dry_run:
        args.skip_steady_states = args.skip_model_dash = True

    check_environment(args, cfg)

    # One run at a time: overlapping cron runs would write the same data files.
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.error("another deploy.py run is in progress (%s is locked)", LOCK_FILE.name)
        return 3

    env = os.environ.copy()
    dist = ROOT / "dist"
    t0 = time.monotonic()
    try:
        if not args.skip_steady_states:
            gen_steady_states(env, cfg, args.steady_states_force)
        if not args.skip_model_dash:
            gen_model_dash(env, cfg)
        build_site(dist)
        if not args.no_deploy:
            deploy(dist, cfg, args.dry_run)
    except StepFailed as e:
        log.error("FAILED: %s. Later steps were not run.", e)
        return 1
    log.info("finished in %.0f min", (time.monotonic() - t0) / 60)
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
