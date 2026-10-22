"""TracerProvider setup."""

import logging
from typing import Optional

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.resources import Resource

from .exporter import ExportConfig, SmartExporter

logger = logging.getLogger(__name__)

_provider: Optional[TracerProvider] = None


def setup_tracing(
    service_name: str = "otel-hook",
    service_version: str = "0.1.0",
    otlp_endpoint: Optional[str] = None,
    cache: bool = True,
    cache_db_path: str = "./data/traces/cache.db",
    retry_interval: int = 5,
    expire_seconds: int = 86400,
    conditional_export: bool = False,
) -> trace.Tracer:
    """Setup tracing.

    Args:
        service_name: Service name
        service_version: Service version
        otlp_endpoint: OTLP backend endpoint (None = discard all)
        cache: Cache locally on send failure for later retry
        cache_db_path: Local cache database path
        retry_interval: Seconds between retry attempts
        expire_seconds: Seconds before cached spans expire (0 = never)
        conditional_export: Only export traces with violations
    """
    global _provider

    if _provider is not None:
        logger.warning("Tracing already initialized")
        return _provider.get_tracer(service_name)

    resource = Resource.create({
        "service.name": service_name,
        "service.version": service_version,
    })

    _provider = TracerProvider(resource=resource)

    if otlp_endpoint:
        config = ExportConfig(
            otlp_endpoint=otlp_endpoint,
            cache=cache,
            cache_db_path=cache_db_path,
            retry_interval=retry_interval,
            expire_seconds=expire_seconds,
            conditional_export=conditional_export,
        )
        exporter = SmartExporter(config)
        _provider.add_span_processor(exporter)
        exporter.start()
        logger.info(f"Tracing: endpoint={otlp_endpoint}, cache={cache}, conditional={conditional_export}")
    else:
        logger.info("Tracing: disabled (no endpoint)")

    trace.set_tracer_provider(_provider)
    return _provider.get_tracer(service_name)


def get_tracer(name: str = "otel-hook") -> trace.Tracer:
    if _provider is None:
        logger.warning("Tracing not initialized")
        return trace.get_tracer(name)
    return _provider.get_tracer(name)


def shutdown_tracing():
    global _provider
    if _provider:
        _provider.shutdown()
        _provider = None
