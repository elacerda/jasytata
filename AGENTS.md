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

The published v0.3.0 scientific behavior is the regression-protected baseline during v0.4.0 development, including the inherited v0.2.0 T80-South/S-PLUS compatibility contract.

Do not change scientific behavior, constants, fixture expectations, coordinate semantics, coverage semantics, or T80 compatibility unless the current task explicitly authorizes that change.

For v0.4.0 work, follow the current gate and acceptance criteria in `docs/V0.4.0_ROADMAP.md`. The v0.3.0 roadmap is historical evidence. Do not implement later gates opportunistically.

## Validation

Use the smallest relevant tests while developing, then run the repository validation required by the current gate.

Do not commit or modify the local untracked `poly.txt` file.
Do not modify or stage the local untracked `.codex/` directory.
