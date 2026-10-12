"""D10 tests: Docker packaging and compose structure validation."""
from pathlib import Path


def test_sidecar_dockerfile_exists_and_configured() -> None:
    """Validate sidecar/Dockerfile presence, base image, and entrypoint."""
    path = Path("sidecar/Dockerfile")
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "FROM python:3.11-slim" in content or "FROM python:3.11" in content
    assert "requirements.txt" in content
    assert "sidecar.main" in content


def test_witness_dockerfile_exists_and_configured() -> None:
    """Validate witness/Dockerfile presence, exposed port, and entrypoint."""
    path = Path("witness/Dockerfile")
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "FROM python:3.11-slim" in content or "FROM python:3.11" in content
    assert "EXPOSE 8800" in content
    assert "witness.app" in content


def test_defence_compose_structure() -> None:
    """Validate defence-compose.yml specification, mounts, ports, and dependencies."""
    path = Path("defence-compose.yml")
    assert path.exists()
    content = path.read_text(encoding="utf-8")

    assert "services:" in content
    assert "sidecar:" in content
    assert "witness:" in content
    assert ":ro" in content  # spool mounted read-only
    assert "8800:8800" in content
    assert "witness-data:" in content
    assert "chain-of-custody-sidecar" in content
    assert "chain-of-custody-witness" in content


def test_integration_docs_publish_docker_details() -> None:
    """Verify INTEGRATION.md documents the compose file, image names, and witness URL."""
    path = Path("docs/INTEGRATION.md")
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "defence-compose.yml" in content
    assert "chain-of-custody-sidecar:latest" in content
    assert "chain-of-custody-witness:latest" in content
    assert "http://witness:8800" in content
