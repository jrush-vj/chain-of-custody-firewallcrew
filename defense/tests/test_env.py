"""Environment and configuration smoke tests for D0."""
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_config_template_loads() -> None:
    """The committed profile template parses with tomllib and has the contract keys."""
    with open(ROOT / "config.example.toml", "rb") as f:
        config = tomllib.load(f)
    assert config["profile"]["event_types"] == []
    assert config["paths"]["spool_path"]
    assert config["node"]["node_id"]


def test_packages_importable() -> None:
    """All defence packages are importable."""
    import sidecar  # noqa: F401
    import tools  # noqa: F401
    import verifier  # noqa: F401
    import witness  # noqa: F401
