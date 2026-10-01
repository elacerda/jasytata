# Jasytata agent instructions

## Code navigation

Use `code-review-graph` as the default code-navigation layer.

For implementation, debugging, refactoring, or review:

1. Start with `get_minimal_context_tool`.
2. Use `semantic_search_nodes_tool` or `query_graph_tool` to locate the relevant symbols and relationships.
3. Use `get_impact_radius_tool` when changing existing code.
4. Read source files directly only after the graph has identified the relevant files, symbols, tests, or callers.
5. Do not preload broad fixed lists of source files.
6. After implementation, use `detect_changes_tool` or `get_review_context_tool` to inspect the affected surface before final validation.
7. Update the graph with `build_or_update_graph_tool` when it may be stale.

The graph is a navigation and context-reduction aid, not a source of scientific truth. Exact source code, tests, contracts, and explicitly authoritative project documentation take precedence over graph summaries.

## Jasytata scientific compatibility

The published v0.4.0 scientific baseline is frozen at commit
`7613a08b1cd1f23bfc40918c8391cea995085af4`, tag `v0.4.0`. Its behavior remains
regression-protected, including the intended T80-South/S-PLUS compatibility
contract and inherited v0.2.0 behavior. v0.5.0 work is on branch `0.5.0` and
follows `docs/V0.5.0_ROADMAP.md`; later gates are not permission to implement
their work opportunistically. Do not modify `main` or move/recreate `v0.4.0`.

Do not change scientific behavior, constants, fixture expectations, coordinate semantics, coverage semantics, or T80 compatibility unless the current task explicitly authorizes that change.

For v0.4.0 compatibility work, use `docs/V0.4.0_ROADMAP.md` as historical
release evidence. For v0.5.0, the v0.5.0 roadmap is the active authority.

## Validation

Use the smallest relevant tests while developing, then run the repository validation required by the current gate.

Do not modify, move, recreate, stage, or delete the local untracked `.codex/`
directory or `poly.txt` file.
