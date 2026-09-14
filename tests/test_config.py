from app.config import load_config


def test_port_environment_variable_overrides_local_dashboard_port(monkeypatch) -> None:
    monkeypatch.setenv("PORT", "10000")
    assert load_config("config.yaml").dashboard_port == 10000


def test_invalid_port_environment_variable_uses_configured_default(monkeypatch) -> None:
    monkeypatch.setenv("PORT", "not-a-port")
    assert load_config("config.yaml").dashboard_port == 8347
