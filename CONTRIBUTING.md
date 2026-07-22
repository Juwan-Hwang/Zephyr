# Contributing to Zephyr

Thank you for your interest in contributing to Zephyr! This document describes the contribution process, coding standards, and testing requirements.

## Contribution Process

We use the standard GitHub fork-and-pull-request workflow:

1. **Fork** the repository to your GitHub account
2. **Clone** your fork locally: `git clone https://github.com/<your-username>/Zephyr.git`
3. **Create a branch**: `git checkout -b feature/your-feature-name`
4. **Make changes** following the coding standards below
5. **Run tests** locally to verify your changes (see Testing section)
6. **Commit** with a clear, descriptive message
7. **Push** to your fork: `git push origin feature/your-feature-name`
8. **Open a Pull Request** against the `main` branch

### Pull Request Guidelines

- One feature/fix per PR — keep changes focused
- Use [Conventional Commits](https://www.conventionalcommits.org/) format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`
- Provide a clear description of what changed and why

### Code Review

All submissions require review before being merged into `main`. The maintainer will review PRs for:

- Correctness and completeness
- Adherence to coding standards
- Test coverage for new functionality
- Security implications
- Documentation updates (if applicable)

## Coding Standards

### Rust (Backend)

| Tool | Config | Command |
|------|--------|---------|
| **rustfmt** | Default (`rustfmt.toml` not present — using Rust defaults) | `cargo fmt --all` |
| **Clippy** | `Cargo.toml` `[workspace.lints.clippy]` — 170 deny rules across 4 tiers | `cargo clippy --all-targets -- -D warnings` |
| **Workspace lints** | `Cargo.toml` `[workspace.lints.rust]` | Inherited by all member crates via `[lints] workspace = true` |

Clippy rule tiers:
1. **Correctness & Security** — `unwrap_used`, `expect_used`, `indexing_slicing`, `undocumented_unsafe_blocks`
2. **Concurrency & Memory Safety** — `await_holding_lock`, `future_not_send`, `rc_mutex`
3. **Memory Allocation Performance** — `redundant_clone`, `vec_init_then_push`, `large_enum_variant`
4. **CPU & Algorithm Performance** — `suboptimal_flops`, `float_cmp`, `single_char_pattern`

Test modules are exempt from `unwrap_used`/`expect_used`/`indexing_slicing` via `#![cfg_attr(test, allow(...))]`.

### JavaScript / CSS (Frontend)

| Tool | Config | Command |
|------|--------|---------|
| **ESLint** | `apps/desktop/eslint.config.mjs` (flat config) | `pnpm --filter @zephyr/desktop lint` |
| **Prettier** | Editor default (format-on-save) | — |

ESLint includes a custom inline `no-unsanitized` rule that detects unsafe `innerHTML`/`outerHTML` assignments and `insertAdjacentHTML` calls, requiring the use of `html`/`escapeHtml`/`sanitizeHtml` tagged templates or functions.

## Testing Policy

**All major new functionality MUST be accompanied by automated tests added to the test suite.**

This is a general policy (formal but not bureaucratic). When you add a new feature or fix a bug, you should add or update tests that verify the behavior.

### Rust Tests

```bash
# Run all tests (unit + integration + Golden snapshots)
cargo test --workspace --exclude zephyr-core-ffi --release

# Update Golden snapshots (insta)
INSTA_UPDATE=always cargo test --workspace --exclude zephyr-core-ffi --release
```

- Unit tests are inline (`#[cfg(test)] mod tests`)
- Golden (snapshot) tests use [`insta`](https://insta.rs) — `.snap` files live alongside source
- Integration tests are in `apps/desktop/src-tauri/src/prism_tests.rs`

### Frontend Tests

```bash
# Run Vitest
pnpm --filter @zephyr/desktop test
```

- Test framework: [Vitest](https://vitest.dev) with `happy-dom` environment
- Test files: `*.test.js` alongside source files
- Test patterns: unit tests, snapshot tests, state machine tests

### CI Verification

The CI pipeline (`.github/workflows/security.yml`) runs on every PR and push:
- `cargo clippy --all-targets -- -D warnings` (170 deny rules)
- `cargo test --workspace --exclude zephyr-core-ffi --release --locked`
- `pnpm --filter @zephyr/desktop test`
- `pnpm --filter @zephyr/desktop lint`

PRs will not be merged if any CI check fails.

## Build System

### Prerequisites

- **Rust** 1.96.0+ (see `rust-toolchain.toml`)
- **Node.js** 20+ (see `package.json` `engines.node`)
- **pnpm** 9+

### Build Commands

```bash
# Install dependencies
pnpm install

# Development mode
pnpm --filter @zephyr/desktop tauri dev

# Production build
pnpm --filter @zephyr/desktop tauri build

# Build specific platform
pnpm --filter @zephyr/desktop tauri build --target x86_64-pc-windows-msvc
```

## Reporting Issues

- **Bug reports**: Use [GitHub Issues](https://github.com/Juwan-Hwang/Zephyr/issues) with the bug label
- **Feature requests**: Use GitHub Issues with the enhancement label
- **Security vulnerabilities**: See [SECURITY.md](./SECURITY.md) — do NOT open public issues for security vulnerabilities

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
