# Repository Guidance

- Order implementation as imports, native/runtime bindings, then feature logic.
- Prefer native APIs and low-cost engine primitives over higher-cost wrappers when equivalent.
- Add abstractions only to remove meaningful duplication; avoid one-line pass-through functions.
- Keep comments brief and limited to non-obvious behavior. Tests should exercise important behavior, not API existence or one-test-per-fix churn.
- Fix root causes and restructure when needed; avoid layering patches that degrade the design.
