"""
build.py — Assemble meridian site into a deployable dist/ directory.

Usage:
    python build.py [--output-dir DIR] [--force]

Prerequisites:
    - steady_states/data/ must already exist. Generate it first with:
        SKA=~/AXAFDATA/SKADATA python -m xija_steady_states --output-dir steady_states

Options:
    --output-dir DIR    Destination directory (default: dist)
    --force             Delete and recreate output-dir if it exists
"""
import argparse
import shutil
import sys
from pathlib import Path


def build(output_dir: Path, force: bool = False) -> None:
    if output_dir.exists():
        if not force:
            print(f"Error: {output_dir} already exists. Use --force to overwrite.")
            sys.exit(1)
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    # ── Protractor ─────────────────────────────────────────────────────────────
    print("Copying protractor...")
    shutil.copytree("protractor", output_dir / "protractor")

    print("Copying protractor data...")
    shutil.copytree("data", output_dir / "data")

    # ── Steady States ──────────────────────────────────────────────────────────
    ss_src = Path("steady_states")
    ss_dst = output_dir / "steady_states"
    ss_dst.mkdir()

    print("Copying steady_states static files...")
    shutil.copy(ss_src / "index.html", ss_dst / "index.html")
    shutil.copy(ss_src / "app.js",     ss_dst / "app.js")
    shutil.copytree(ss_src / "vendor", ss_dst / "vendor")

    ss_data = ss_src / "data"
    if ss_data.exists():
        print("Copying steady_states data...")
        shutil.copytree(ss_data, ss_dst / "data")
    else:
        print(
            "Warning: steady_states/data/ not found. "
            "Run xija_steady_states to generate it before deploying."
        )

    print(f"Done. Site assembled in {output_dir}/")
    print(f"  Serve with: python -m http.server 8765 --directory {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--output-dir", default="dist", metavar="DIR",
        help="Output directory (default: dist)",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite output-dir if it exists",
    )
    args = parser.parse_args()
    build(Path(args.output_dir), force=args.force)
