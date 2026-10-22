"""Tests for otel-hook SDK."""

import pytest
import tempfile
from pathlib import Path

from otel_hook import (
    HookContext,
    HookResult,
    HookConfig,
    Hook,
    HookWrapper,
    HookChain,
    HookRegistry,
    register_hook,
    run_hooks,
    SpanNames,
    SpanAttributes,
    ExportConfig,
)


class TestHookContext:
    """Tests for HookContext."""

    def test_create_basic_context(self):
        ctx = HookContext(data={"action": "test"})
        assert ctx.data == {"action": "test"}

    def test_create_context_with_all_fields(self):
        ctx = HookContext(data={
            "model": "gpt-4",
            "session_id": "session_123",
            "user_id": "user_456",
        })
        assert ctx.data["model"] == "gpt-4"
        assert ctx.data["session_id"] == "session_123"
        assert ctx.data["user_id"] == "user_456"


class TestHookResult:
    """Tests for HookResult."""

    def test_allow_result(self):
        result = HookResult(allowed=True)
        assert result.allowed is True
        assert result.reason is None
        assert result.data is None

    def test_deny_result(self):
        result = HookResult(allowed=False, reason="test reason")
        assert result.allowed is False
        assert result.reason == "test reason"

    def test_allow_with_data(self):
        result = HookResult(allowed=True, data={"key": "value"})
        assert result.allowed is True
        assert result.data == {"key": "value"}

    def test_deny_with_data(self):
        result = HookResult(allowed=False, reason="reason", data={"attr": "new_value"})
        assert result.allowed is False
        assert result.data == {"attr": "new_value"}


class TestHookConfig:
    """Tests for HookConfig."""

    def test_default_config(self):
        config = HookConfig()
        assert config.timeout_ms == 1000
        assert config.enabled is True

    def test_custom_config(self):
        config = HookConfig(timeout_ms=500, enabled=False)
        assert config.timeout_ms == 500
        assert config.enabled is False


class TestHookWrapper:
    """Tests for HookWrapper."""

    def test_wrapper_executes_hook(self):
        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True)
        
        wrapper = HookWrapper(my_hook, "test_hook", priority=10)
        ctx = HookContext(data={})
        result = wrapper(ctx)
        assert result.allowed is True

    def test_wrapper_respects_priority(self):
        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True)
        
        wrapper = HookWrapper(my_hook, "test_hook", priority=5)
        assert wrapper.priority == 5

    def test_wrapper_respects_enabled(self):
        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(allowed=False, reason="should not run")
        
        config = HookConfig(enabled=False)
        wrapper = HookWrapper(my_hook, "test_hook", config=config)
        ctx = HookContext(data={})
        result = wrapper(ctx)
        assert result is None

    def test_wrapper_handles_error(self):
        def bad_hook(ctx: HookContext) -> HookResult:
            raise ValueError("test error")
        
        wrapper = HookWrapper(bad_hook, "test_hook")
        ctx = HookContext(data={})
        with pytest.raises(ValueError):
            wrapper(ctx)


class TestHookChain:
    """Tests for HookChain."""

    def test_chain_sorts_by_priority(self):
        def hook1(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True)
        
        def hook2(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True)
        
        def hook3(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True)
        
        wrappers = [
            HookWrapper(hook3, "hook3", priority=100),
            HookWrapper(hook1, "hook1", priority=10),
            HookWrapper(hook2, "hook2", priority=50),
        ]
        chain = HookChain(wrappers)
        
        priorities = [w.priority for w in chain.hooks]
        assert priorities == [10, 50, 100]

    def test_chain_runs_all_hooks_and_returns_results(self):
        executed = []
        
        def hook1(ctx: HookContext) -> HookResult:
            executed.append("hook1")
            return HookResult(allowed=False, reason="blocked")
        
        def hook2(ctx: HookContext) -> HookResult:
            executed.append("hook2")
            return HookResult(allowed=True)
        
        wrappers = [
            HookWrapper(hook1, "hook1", priority=10),
            HookWrapper(hook2, "hook2", priority=20),
        ]
        chain = HookChain(wrappers)
        
        ctx = HookContext(data={})
        results = chain.run(ctx)
        
        assert len(results) == 2
        assert results[0].allowed is False
        assert results[0].reason == "blocked"
        assert results[1].allowed is True
        assert executed == ["hook1", "hook2"]

    def test_chain_collects_data_modifications(self):
        def hook1(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True, data={"key1": "value1"})
        
        def hook2(ctx: HookContext) -> HookResult:
            return HookResult(allowed=True, data={"key2": "value2"})
        
        wrappers = [
            HookWrapper(hook1, "hook1", priority=10),
            HookWrapper(hook2, "hook2", priority=20),
        ]
        chain = HookChain(wrappers)
        
        ctx = HookContext(data={})
        results = chain.run(ctx)
        
        assert len(results) == 2
        assert results[0].data == {"key1": "value1"}
        assert results[1].data == {"key2": "value2"}


class TestHookRegistry:
    """Tests for HookRegistry."""

    def test_register_and_run_hook(self):
        registry = HookRegistry()
        
        def my_hook(ctx: HookContext) -> HookResult:
            if "dangerous" in ctx.data.get("action", ""):
                return HookResult(allowed=False, reason="dangerous action")
            return HookResult(allowed=True)
        
        registry.register("tool_call", my_hook, "security_check", priority=10)
        
        ctx = HookContext(data={"action": "dangerous command"})
        results = registry.run("tool_call", ctx)
        assert len(results) == 1
        assert results[0].allowed is False

    def test_unregistered_event_returns_empty(self):
        registry = HookRegistry()
        
        ctx = HookContext(data={})
        results = registry.run("unknown_event", ctx)
        assert results == []


class TestGlobalFunctions:
    """Tests for global hook functions."""

    def test_register_and_run_global_hook(self):
        def my_hook(ctx: HookContext) -> HookResult:
            return HookResult(allowed=False, reason="blocked")
        
        register_hook("test_event", my_hook, "test_hook", priority=10)
        
        ctx = HookContext(data={})
        results = run_hooks("test_event", ctx)
        assert len(results) == 1
        assert results[0].allowed is False


class TestSpanNames:
    """Tests for SpanNames."""

    def test_span_names_defined(self):
        assert SpanNames.AGENT_SESSION == "agent.session"
        assert SpanNames.MODEL_CALL == "llm.model_call"
        assert SpanNames.TOOL_CALL == "tool.call"
        assert SpanNames.CHAIN == "chain"


class TestSpanAttributes:
    """Tests for SpanAttributes."""

    def test_span_attributes_defined(self):
        assert SpanAttributes.SESSION_ID == "session.id"
        assert SpanAttributes.LLM_MODEL == "llm.model"
        assert SpanAttributes.TOOL_NAME == "tool.name"
        assert SpanAttributes.HOOK_NAME == "hook.name"


class TestExportConfig:
    """Tests for ExportConfig."""

    def test_default_config(self):
        config = ExportConfig(otlp_endpoint="http://localhost:4317")
        assert config.otlp_endpoint == "http://localhost:4317"
        assert config.cache is True
        assert config.cache_db_path == "./data/traces/cache.db"
        assert config.retry_interval == 5
        assert config.expire_seconds == 86400
        assert config.batch_size == 100

    def test_custom_config(self):
        config = ExportConfig(
            otlp_endpoint="http://custom:4317",
            cache=False,
            cache_db_path="/tmp/custom.db",
            retry_interval=10,
            expire_seconds=3600,
            batch_size=50,
        )
        assert config.otlp_endpoint == "http://custom:4317"
        assert config.cache is False
        assert config.cache_db_path == "/tmp/custom.db"
        assert config.retry_interval == 10
        assert config.expire_seconds == 3600
        assert config.batch_size == 50


class TestSmartExporter:
    """Tests for SmartExporter."""

    def test_exporter_creates_cache_db(self):
        """Test that exporter creates cache database when cache=True."""
        from otel_hook import SmartExporter
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "cache.db")
            config = ExportConfig(
                otlp_endpoint="http://localhost:4317",
                cache=True,
                cache_db_path=db_path,
            )
            exporter = SmartExporter(config)
            assert Path(db_path).exists()
            exporter.shutdown()

    def test_exporter_no_cache_db_when_disabled(self):
        """Test that exporter does not create cache database when cache=False."""
        from otel_hook import SmartExporter
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "cache.db")
            config = ExportConfig(
                otlp_endpoint="http://localhost:4317",
                cache=False,
                cache_db_path=db_path,
            )
            exporter = SmartExporter(config)
            assert not Path(db_path).exists()
            exporter.shutdown()

    def test_exporter_caches_on_failure(self):
        """Test that exporter caches spans when export fails."""
        from otel_hook import SmartExporter
        from opentelemetry.sdk.trace import TracerProvider
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "cache.db")
            config = ExportConfig(
                otlp_endpoint="http://invalid:4317",
                cache=True,
                cache_db_path=db_path,
            )
            exporter = SmartExporter(config)
            
            provider = TracerProvider()
            provider.add_span_processor(exporter)
            tracer = provider.get_tracer("test")
            
            with tracer.start_as_current_span("test.span") as span:
                span.set_attribute("test.key", "test.value")
            
            import sqlite3
            conn = sqlite3.connect(db_path)
            cursor = conn.execute("SELECT COUNT(*) FROM cache")
            count = cursor.fetchone()[0]
            conn.close()
            
            assert count == 1
            exporter.shutdown()

    def test_exporter_discards_on_failure_when_no_cache(self):
        """Test that exporter discards spans when export fails and cache=False."""
        from otel_hook import SmartExporter
        from opentelemetry.sdk.trace import TracerProvider
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "cache.db")
            config = ExportConfig(
                otlp_endpoint="http://invalid:4317",
                cache=False,
                cache_db_path=db_path,
            )
            exporter = SmartExporter(config)
            
            provider = TracerProvider()
            provider.add_span_processor(exporter)
            tracer = provider.get_tracer("test")
            
            with tracer.start_as_current_span("test.span") as span:
                span.set_attribute("test.key", "test.value")
            
            assert not Path(db_path).exists()
            exporter.shutdown()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
