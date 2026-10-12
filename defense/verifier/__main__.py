"""Verifier CLI entry point: performs integrity checks and prints verdict JSON."""
import argparse
import json
import sys
import tomllib
from pathlib import Path

from verifier.checks import verify


def main(argv: list[str] | None = None) -> int:
    """Run verifier CLI, print results as JSON, and exit with status code 0, 1, or 2."""
    parser = argparse.ArgumentParser(prog="python -m verifier", description="Verify log integrity.")
    parser.add_argument("--config", type=Path, default=Path("config.toml"), help="path to profile config file")
    parser.add_argument("--witness", type=str, default=None, help="witness service URL (for online checks)")
    parser.add_argument("--node-id", type=str, default=None,
                        help="node id to look up at the witness (default: [node] node_id from the config)")
    args = parser.parse_args(argv)

    try:
        if not args.config.exists():
            print(f"error: config file not found: {args.config}", file=sys.stderr)
            return 2

        with open(args.config, "rb") as f:
            config = tomllib.load(f)

        db_path = Path(config["paths"]["db_path"])
        pub_path = Path(config["paths"]["public_key_path"])
        # An auditor should pass --node-id: the config sits on the host being audited.
        node_id = args.node_id or config.get("node", {}).get("node_id")

        result = verify(db_path, pub_path, witness_url=args.witness, node_id=node_id)
    except Exception as exc:
        print(f"error: verification failed: {exc}", file=sys.stderr)
        return 2

    # Print JSON output to stdout exactly as specified in CONTRACT.md section 6
    print(json.dumps(result, indent=2 if sys.stdout.isatty() else None))
    return 0 if result["clean"] else 1


if __name__ == "__main__":
    sys.exit(main())
