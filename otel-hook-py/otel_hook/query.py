#!/usr/bin/env python3
"""Query local trace storage."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from rich.console import Console
from rich.table import Table
from rich.tree import Tree
from rich import box

from trace_backend.exporter import TraceQuery


def print_traces_table(traces: list, console: Console):
    table = Table(title="Recent Traces", box=box.ROUNDED)
    table.add_column("Trace ID", style="cyan", no_wrap=True)
    table.add_column("Start Time", style="green")
    table.add_column("Spans", justify="right", style="yellow")
    table.add_column("Span Names", style="dim")

    for t in traces:
        trace_id = t["trace_id"][:16] + "..."
        table.add_row(
            trace_id,
            str(t["start_time"]),
            str(t["span_count"]),
            str(t["span_names"])[:60] if t["span_names"] else "",
        )

    console.print(table)


def print_trace_tree(spans: list, console: Console):
    if not spans:
        console.print("[red]No spans found[/red]")
        return

    span_map = {s["span_id"]: s for s in spans}
    children_map = {}
    root_spans = []

    for s in spans:
        parent_id = s["parent_span_id"]
        if parent_id and parent_id in span_map:
            children_map.setdefault(parent_id, []).append(s)
        else:
            root_spans.append(s)

    def build_tree(span: dict, tree: Tree):
        name = span["name"]
        duration = ""
        if span["start_time"] and span["end_time"]:
            dur_ms = (span["end_time"] - span["start_time"]) / 1_000_000
            duration = f" ({dur_ms:.2f}ms)"

        attrs = ""
        if span["attributes"]:
            try:
                a = json.loads(span["attributes"])
                keys = []
                for k in ["session.id", "llm.model", "tool.name", "hook.allowed", "hook.reason"]:
                    if k in a:
                        keys.append(f"{k.split('.')[-1]}={a[k]}")
                if keys:
                    attrs = " | " + ", ".join(keys)
            except:
                pass

        branch = tree.add(f"[cyan]{name}[/cyan]{duration}{attrs}")

        for child in children_map.get(span["span_id"], []):
            build_tree(child, branch)

    tree = Tree("[bold]Trace Tree[/bold]")
    for root in root_spans:
        build_tree(root, tree)

    console.print(tree)


def print_stats(stats: dict, console: Console):
    table = Table(title="Trace Storage Stats", box=box.SIMPLE)
    table.add_column("Metric", style="cyan")
    table.add_column("Value", justify="right", style="green")

    table.add_row("Total Spans", str(stats["total_spans"]))
    table.add_row("Total Traces", str(stats["total_traces"]))
    table.add_row("Pending Export", str(stats["pending_export"]))
    table.add_row("Oldest Trace", stats["oldest_trace"] or "N/A")
    table.add_row("Newest Trace", stats["newest_trace"] or "N/A")

    console.print(table)


def main():
    parser = argparse.ArgumentParser(description="Query local trace storage")
    parser.add_argument("--db", default="./data/traces/traces.db", help="Database path")
    parser.add_argument("--trace-id", help="Show detail for specific trace")
    parser.add_argument("--name", help="Show spans by name")
    parser.add_argument("--stats", action="store_true", help="Show storage stats")
    parser.add_argument("--limit", type=int, default=20, help="Limit results")
    args = parser.parse_args()

    console = Console()
    query = TraceQuery(args.db)

    try:
        if args.stats:
            stats = query.get_stats()
            print_stats(stats, console)
        elif args.trace_id:
            spans = query.get_trace_detail(args.trace_id)
            print_trace_tree(spans, console)
        elif args.name:
            spans = query.get_spans_by_name(args.name, args.limit)
            console.print(f"\n[bold]Spans named '{args.name}'[/bold]\n")
            for s in spans:
                console.print(f"  [cyan]{s['trace_id'][:16]}...[/cyan] | {s['name']}")
        else:
            traces = query.get_recent_traces(args.limit)
            print_traces_table(traces, console)
    finally:
        query.close()


if __name__ == "__main__":
    main()
