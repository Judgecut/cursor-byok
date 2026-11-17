# Checks and tests

Install the Rust toolchain with rustfmt and Clippy, Node.js 22+, Deno 2.9.6, and Make. Prepare the frontend and Chromium once:

```sh
npm --prefix apps/desktop ci
cd apps/desktop
npx playwright install --with-deps chromium
```

From the repository root, `make check` runs release validation, all repository Node script tests, built-in plugin Deno tests, Rust formatting/Clippy/tests, frontend type checks, frontend unit tests, the production build, and Chromium interaction tests. Missing tools or browsers fail the check.

```text
server/
├── src/                       # Module unit tests
├── tests/                     # Runtime behavior with temporary SQLite and controlled providers
│   └── request_context_history.rs # Consecutive turns, rule changes, retries, and fresh-store recovery
└── plugins/build-in/           # Deno workspace and built-in plugin tests
apps/desktop/
├── tests/                     # Function and store unit tests
│   └── browser/               # Production-build form, persistence, details, and locale interactions
└── src-tauri/src/              # Native desktop unit tests
crates/semble-core/             # Indexing, search, and embedding tests
scripts/                       # Local desktop update script tests
.github/scripts/               # Release script tests
```

The browser suite runs the normal Vite production build in Chromium. It keeps real React components, stores, routing, API serialization, and the static i18n transform. Only HTTP responses and the native action that opens an external URL are simulated. Each test starts with fresh server-side fixture state; reload assertions require the UI to read that state again. Unexpected management requests and browser exceptions fail the test. These tests do not exercise the Rust HTTP implementation or the native Tauri WebView.

Run focused checks from the repository root:

```sh
make check-plugins
node --test .github/scripts/*.test.mjs scripts/*.test.mjs
cargo test -p cursor-server --test request_context_history
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:browser
```

The real embedding-model inference test is explicitly ignored in the ordinary Rust suite because it downloads model assets. Run the dedicated check:

```sh
make check-embedding
```

This check downloads the model and tokenizer into an isolated temporary directory through the existing `ModelAssets` loader, verifies both against repository-pinned SHA-256 digests, and checks embedding dimensions, normalization, and distinct outputs. A download, checksum, load, or inference failure fails the check. No environment variables are required. CI runs this dedicated check after the ordinary Rust suite, where the test remains visibly ignored.
