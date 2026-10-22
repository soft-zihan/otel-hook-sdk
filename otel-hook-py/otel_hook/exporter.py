"""Smart exporter: export when online, optionally cache when offline.
Supports conditional export - only export traces marked as violations.
"""

import json
import sqlite3
import threading
import time
import logging
from pathlib import Path
from typing import Optional, List, Sequence, Set, Dict
from dataclasses import dataclass

from opentelemetry.sdk.trace import SpanProcessor, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

logger = logging.getLogger(__name__)


@dataclass
class ExportConfig:
    otlp_endpoint: str
    cache: bool = True
    cache_db_path: str = "./data/traces/cache.db"
    retry_interval: int = 5
    expire_seconds: int = 86400
    batch_size: int = 100
    conditional_export: bool = False


class TraceState:
    """Tracks state for a trace, including whether it should be exported."""
    
    def __init__(self):
        self.should_export: bool = False
        self.violation_type: Optional[str] = None
        self.spans: List[ReadableSpan] = []
        self.root_span: Optional[ReadableSpan] = None


class TraceStateManager:
    """Manages trace states for conditional export."""
    
    def __init__(self):
        self._states: Dict[str, TraceState] = {}
        self._lock = threading.Lock()
    
    def get_or_create(self, trace_id: str) -> TraceState:
        with self._lock:
            if trace_id not in self._states:
                self._states[trace_id] = TraceState()
            return self._states[trace_id]
    
    def mark_for_export(self, trace_id: str, violation_type: Optional[str] = None):
        state = self.get_or_create(trace_id)
        state.should_export = True
        if violation_type:
            state.violation_type = violation_type
    
    def add_span(self, trace_id: str, span: ReadableSpan):
        state = self.get_or_create(trace_id)
        state.spans.append(span)
        if span.parent is None:
            state.root_span = span
    
    def get_state(self, trace_id: str) -> Optional[TraceState]:
        with self._lock:
            return self._states.get(trace_id)
    
    def remove_state(self, trace_id: str):
        with self._lock:
            self._states.pop(trace_id, None)


_global_trace_manager = TraceStateManager()


def get_trace_manager() -> TraceStateManager:
    return _global_trace_manager


def mark_trace_for_export(trace_id: str, violation_type: Optional[str] = None):
    """Mark a trace for export due to violation."""
    _global_trace_manager.mark_for_export(trace_id, violation_type)


class SmartExporter(SpanProcessor):

    def __init__(self, config: ExportConfig):
        self.config = config
        self._exporter = OTLPSpanExporter(
            endpoint=config.otlp_endpoint,
            insecure=config.otlp_endpoint.startswith("http://"),
        )
        self._local = threading.local()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._trace_manager = _global_trace_manager
        if config.cache:
            self._init_cache_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn"):
            Path(self.config.cache_db_path).parent.mkdir(parents=True, exist_ok=True)
            self._local.conn = sqlite3.connect(self.config.cache_db_path)
            self._local.conn.execute("PRAGMA journal_mode=WAL")
        return self._local.conn

    def _init_cache_db(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_created_at ON cache(created_at);
        """)
        conn.commit()

    def on_start(self, span, parent_context=None):
        pass

    def on_end(self, span: ReadableSpan):
        ctx = span.get_span_context()
        trace_id = f"{ctx.trace_id:032x}"
        
        self._trace_manager.add_span(trace_id, span)
        
        if not self.config.conditional_export:
            self._do_export([span])
            return
        
        if span.parent is None:
            state = self._trace_manager.get_state(trace_id)
            if state and state.should_export:
                self._do_export(state.spans)
                logger.info(f"Exported trace {trace_id} with {len(state.spans)} spans (violation: {state.violation_type})")
            else:
                logger.debug(f"Skipped trace {trace_id} (no violation)")
            self._trace_manager.remove_state(trace_id)

    def start(self):
        if not self.config.cache or self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def shutdown(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        self._exporter.shutdown()
        if hasattr(self._local, "conn"):
            self._local.conn.close()

    def force_flush(self, timeout_millis: int = 5000) -> bool:
        if self.config.cache:
            self._retry()
        return True

    def _do_export(self, spans: List[ReadableSpan]):
        try:
            result = self._exporter.export(spans)
            if result != SpanExportResult.SUCCESS:
                if self.config.cache:
                    for span in spans:
                        self._cache_span(span)
        except Exception as e:
            logger.error(f"Export failed: {e}")
            if self.config.cache:
                for span in spans:
                    self._cache_span(span)

    def _loop(self):
        while self._running:
            try:
                self._expire()
                self._retry()
            except Exception as e:
                logger.error(f"SmartExporter loop error: {e}")
            time.sleep(self.config.retry_interval)

    def _cache_span(self, span: ReadableSpan):
        try:
            ctx = span.get_span_context()
            data = json.dumps({
                "trace_id": f"{ctx.trace_id:032x}",
                "span_id": f"{ctx.span_id:016x}",
                "parent_span_id": f"{span.parent.span_id:016x}" if span.parent else None,
                "name": span.name,
                "kind": span.kind.value if span.kind else None,
                "start_time": span.start_time,
                "end_time": span.end_time,
                "attributes": dict(span.attributes) if span.attributes else None,
                "events": [
                    {"name": e.name, "attributes": dict(e.attributes) if e.attributes else {}, "timestamp": e.timestamp}
                    for e in span.events
                ] if span.events else None,
                "status": {
                    "code": span.status.status_code.value if span.status else 0,
                    "description": span.status.description if span.status else None,
                } if span.status else None,
            })
            conn = self._get_conn()
            conn.execute("INSERT INTO cache (data, created_at) VALUES (?, ?)", (data, time.time()))
            conn.commit()
        except Exception as e:
            logger.error(f"Cache span failed: {e}")

    def _retry(self):
        conn = self._get_conn()
        cursor = conn.execute(
            "SELECT id, data FROM cache ORDER BY id LIMIT ?",
            (self.config.batch_size,),
        )
        rows = cursor.fetchall()
        if not rows:
            return

        for row_id, _ in rows:
            conn.execute("DELETE FROM cache WHERE id = ?", (row_id,))
        conn.commit()

    def _expire(self):
        if self.config.expire_seconds <= 0:
            return
        cutoff = time.time() - self.config.expire_seconds
        try:
            conn = self._get_conn()
            conn.execute("DELETE FROM cache WHERE created_at < ?", (cutoff,))
            conn.commit()
        except Exception as e:
            logger.error(f"Expire failed: {e}")
