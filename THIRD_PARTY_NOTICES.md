# Third-Party Notices and Provenance

Original contributions are licensed under the MIT License in [`LICENSE`](LICENSE),
Copyright (c) 2026 dbc-hbin. Third-party materials retain their own licenses and
copyright notices. Separately installed dependencies, OMP, and omp-superkit
are not bundled in Superagent's npm tarball; preserve their own notices if you
redistribute them.

## Native Host owner and Gateway

The npm package ships `omp-host-owner` and `omp-gateway` for macOS and Linux
(x64 and arm64). Preserve the matching notice directory when redistributing a
binary: `host-owner/bin/notices/<platform>-<arch>/` or
`gateway/bin/notices/<platform>-<arch>/`.

- `Cargo-LICENSES.txt` and `Cargo-SOURCES.txt` index the target's locked Cargo
  dependencies, declared licenses, and versioned sources. `crates/` preserves
  upstream notices, including the bundled Opus codec's `opus/COPYING` and the
  public-domain dedication for the SQLite amalgamation bundled on Linux.
- For the Gateway's [MPL-2.0](https://www.mozilla.org/MPL/2.0/)-covered hpke-rs
  components, the corresponding source is available at the locked crate URLs
  in `Cargo-SOURCES.txt`.
- `rust/COPYRIGHT-library.html` and `rust/licenses/` preserve the Rust standard
  library, runtime, and bundled musl notices.

## oh-my-pi: adapted code and artwork

- The opt-in worker memory import verifies Mnemopi's project-bank naming
  contract from [`mnemopi/config.ts` in v19.2.1](https://github.com/can1357/oh-my-pi/blob/b55cd1bb664d8ab46ddc77f2a34eb47555dbf1ac/packages/coding-agent/src/mnemopi/config.ts).
  `scripts/prepare-worker-memory.ts` builds the small embedded-CLI helper
  locally from the installed MIT-licensed `@oh-my-pi/pi-coding-agent` and
  `@oh-my-pi/pi-mnemopi` dependencies;
  the generated module is not part of either distribution.
- `src/host-extension.ts` adapts the `get_state` projection from
  [`rpc-mode.ts` in v18.22.0](https://github.com/can1357/oh-my-pi/blob/3e8cff3b7ce19a805c11a26a6dd1703066435851/packages/coding-agent/src/modes/rpc/rpc-mode.ts).
- `host-owner/src/wire.rs` adapts the wire limits, v1 shrink thresholds, and
  elision markers from [`rpc-frame.ts` in v19.0.0](https://github.com/can1357/oh-my-pi/blob/57771ae562b9345e0579bceb2d68d585e3e6927e/packages/coding-agent/src/modes/rpc/rpc-frame.ts).
  This adaptation is also part of the compiled Host owner.
- `assets/superagent-mascot.webp` adapts the pi silhouette and palette from the
  [README hero](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/hero.png)
  and the plug motif from [`icon.svg`](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/icon.svg).
  `assets/superagent-avatar.jpg` is a white-background conversion of the mascot.
  Neither image is an official upstream logo or implies endorsement.

The [upstream MIT notice](https://github.com/can1357/oh-my-pi/blob/57771ae562b9345e0579bceb2d68d585e3e6927e/LICENSE)
applies to the adapted code and source artwork:

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
