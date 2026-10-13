"""Run a read-only runtime check, including spool-versus-record comparison."""
import argparse
import tomllib
from pathlib import Path

from coc.spooldiff import compare_spool, describe


def run_check(config_path: Path) -> int:
    with config_path.open("rb") as stream:
        config = tomllib.load(stream)
    paths = config["paths"]
    db_path = Path(paths["db_path"])
    spool_path = Path(paths["spool_path"])
    if not db_path.exists():
        print(f"WARN  sidecar database does not exist: {db_path}")
    else:
        report = compare_spool(db_path, spool_path)
        if report["changed"] or report["removed_lines"]:
            print(f"FAIL  spool vs record: {len(report['changed'])} changed line(s)")
            for item in report["changed"][:10]:
                print(f"      {describe(item)}")
            if report["removed_lines"]:
                print(f"      {report['removed_lines']} line(s) removed from spool")
            return 1
        if report["tracked"]:
            print(f"PASS  spool vs record: {report['tracked']} tracked line(s) unchanged")
        elif report["untracked"]:
            print(f"WARN  spool vs record: {report['untracked']} older entry/entries are not line-tracked")
        else:
            print("PASS  spool vs record: no recorded entries")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m coc.check")
    parser.add_argument("--config", type=Path, default=Path("config.toml"))
    args = parser.parse_args()
    return run_check(args.config)
