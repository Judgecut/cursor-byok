# Upstream sources

## Cursor BYOK

- Direct upstream is [hainuoli/cursor-byok](https://github.com/hainuoli/cursor-byok), formerly linked as `leehainuo/cursor-byok`. The shared base is [e69bda0](https://github.com/hainuoli/cursor-byok/commit/e69bda0f6a8da4f002b934bc86c572d32d824800).
- The upstream history starts with [395b033](https://github.com/hainuoli/cursor-byok/commit/395b03356d4c222f3b425585f82cc8451a1c1bbf), which records the import from [leookun/cursor-byok at 31e9f5c](https://github.com/leookun/cursor-byok/commit/31e9f5cbc98a7d28cffcb5efbb9323cd3e143354).
- Both upstream copyright statements are preserved in [LICENSE](./LICENSE). The original project's complete MIT notice is also included in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md).

This fork maintains its Cursor protocol adaptation and Windows releases independently. Its changes include per-model request formats, call and cost reporting, and desktop interface updates.

## Semble

- Repository is [MinishLab/semble](https://github.com/MinishLab/semble).
- Baseline is [9218491](https://github.com/MinishLab/semble/commit/921849164e2632dd4f0e1c1370f82cfe15ed6d6c).
- The MIT copyright and license text are included in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md#semble).
- The embedding model is [minishlab/potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2).

The Rust implementation preserves the externally useful indexing and search behavior while remaining independent of Python at runtime.
