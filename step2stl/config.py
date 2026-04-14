from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    max_file_size: int = 50 * 1024 * 1024  # 50 MB in bytes
    timeout_seconds: int = 60
    linear_deflection: float = 0.1   # mm; lower = finer mesh, slower conversion
    angular_deflection: float = 0.5  # degrees
    freecadcmd_path: str = "/usr/bin/freecadcmd"
    tmp_dir: str = "/tmp/step2stl"   # advisory — systemd PrivateTmp overrides this
    log_level: str = "INFO"

    model_config = {"env_file": ".env"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
