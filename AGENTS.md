# Engineering Principles

## API and data boundaries

- Validate untrusted input at system boundaries and convert it into typed values that downstream code can trust.
- Keep public APIs small and centered on user intent. Hide parsing, representation, and platform mechanics unless callers have a concrete need to control them.
- Do not expose `Map` in public types or function parameters and return values. Prefer a shape whose accepted keys and values are explicit in the API. When an internal `Map` is useful, make the meaning and expected format of its keys clear through domain-specific key types, structure, names, or a focused comment.
- Reuse shared domain constraints so the same concept has consistent rules across the codebase.
- Prefer small, named types composed together over deriving a type from another type or interface property with indexed access.
- Model state as immutable snapshots updated by pure transitions. Isolate any mutable root reference required by a long-lived runtime at its outer effect boundary.
- Write comments about contracts, behavior, and rationale; avoid recording implementation details that can change independently.
- Keep `src/internal` modules independent of public API modules. If an implementation helper needs public contracts and extracting a neutral shared contract layer is not warranted, keep the helper outside an `internal` directory.

## Architecture and runtime integration

- Separate domain contracts from infrastructure mechanisms. Define behavior at the framework level and implement platform-specific mechanisms behind adapters.
- Treat an abstraction as integrated only when production call paths use it and a concrete implementation fulfills its contract.
- Let callers declare intent; keep platform bindings, lifecycle hooks, and deployment translation inside the framework where practical.
- Define reliability semantics explicitly. Durable storage alone does not define acceptance, ordering, retries, recovery, or terminal outcomes.
- Route scheduled work through the same reliable delivery path as other work, and keep one authoritative schedule definition.
- Describe guarantees precisely. Retries can repeat external side effects, so use stable operation identities or idempotent operations where repetition matters.
- Verify runtime compatibility against the APIs, lifecycle, and migration behavior the implementation depends on; do not infer support from surface-level API similarity.
