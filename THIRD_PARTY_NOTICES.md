# Third-Party Notices and Provenance

Original contributions to this project are licensed under the MIT License in
[`LICENSE`](LICENSE), Copyright (c) 2026 dbc-hbin. Third-party code, artwork,
dependencies, and separately managed packages retain their own licenses and
copyright notices; the project license does not replace or relicense them.
When redistributing dependencies, preserve their LICENSE/NOTICE files and those
of their transitive dependencies. This document also identifies conceptual
references separately from copied or adapted material.

## Artwork adapted from oh-my-pi

- Source: [README hero](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/hero.png)
  and [icon.svg](https://github.com/can1357/oh-my-pi/blob/c308970263ae13744ea15ab67302e3dac840e266/assets/icon.svg).
- `assets/superagent-mascot.webp` was generated with `gpt-image-2` using the hero
  as a reference, retaining its pi silhouette and pink/purple palette while adding
  a visor, eyes, and short cape. The icon's plug motif became a small orange
  ornament. This replaced the former connected-node SVG logo.
- `assets/superagent-avatar.jpg` is a white-background JPEG conversion of that
  mascot, made with `sips -s format jpeg` at the original dimensions.
- This is an independent project's adapted logo, not an official upstream product
  or endorsement. The upstream MIT license and copyright notices are reproduced
  in the OMP section below and apply to the source artwork.

## ompbot: adapted SQLite ledger patterns

- Source: [gimso2x/ompbot](https://github.com/gimso2x/ompbot/tree/ddd0f854e8e8d395b7ed43104ec541f909a52ad4),
  revision `ddd0f854e8e8d395b7ed43104ec541f909a52ad4`.
- Original files: `src/store/db.ts`, `src/lanes/manager.ts`.
- Adapted in `src/store.ts`, whose header also retains the full MIT notice.
- Original [LICENSE](https://github.com/gimso2x/ompbot/blob/ddd0f854e8e8d395b7ed43104ec541f909a52ad4/LICENSE):

```text
MIT License

Copyright (c) 2026 ompbot contributors

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

## Discord transport

- Gateway/REST and component support use the
  [discord.js](https://github.com/discordjs/discord.js) dependency, not a copied
  client. The declared range is `^14.25.1`; `bun.lock` records the resolved version.
  The inspected installed version, `14.28.1`, is **Apache-2.0, not MIT**.
- The full license is in `node_modules/discord.js/LICENSE` and the
  [versioned upstream LICENSE](https://github.com/discordjs/discord.js/blob/14.28.1/packages/discord.js/LICENSE).
  It includes `Copyright 2021 Noel Buechler` and `Copyright 2015 Amish Shah`.
  Distributions containing the package must include its Apache-2.0 license and
  applicable notices; the project MIT license does not replace these terms.
- `src/discord.ts` independently implements behavior compared with
  [ompbot `4d2eb28d0bf66644892dc0fc333580d0eb7e7780`](https://github.com/gimso2x/ompbot/tree/4d2eb28d0bf66644892dc0fc333580d0eb7e7780),
  `src/discord/{adapter,attachments,channel,transport}.ts`. That revision is MIT;
  those files were not copied.
- `src/setup-profiles.ts` uses public `REST.get/patch` and `Routes.user` APIs from
  `14.28.1`. The [Modify Current User](https://docs.discord.com/developers/resources/user#modify-current-user)
  image-data upload and User response contracts were checked on 2026-11-15.
  No external avatar implementation was copied.
- No unlicensed poke code or SUL-covered Dori code was imported. Referencing
  operational concepts does not relicense code or grant permission to copy it.

## Operational skills: conceptual references, independently written

`skills/head/` and `skills/lane/` were written for this repository's design and
current OMP tool/session contracts, not copied from Dori skill text or scripts.

- Reference: [vntrevx/omp-dori `3b5487df12540cdd428ebcf7455375d72921e2dc`](https://github.com/vntrevx/omp-dori/tree/3b5487df12540cdd428ebcf7455375d72921e2dc),
  reviewed on 2026-11-13.
- Reviewed: `skills/dori-mode/SKILL.md`, `prompts/lead.md`,
  `prompts/lane-footer.md`, `skills/dori-mode/references/sessions.md`, and
  `skills/dori-mode/references/done-protocol.md`.
- Concepts: explicit handoff/completion conditions, checking reported facts and
  interrupted external effects, and distinguishing a worker's completion claim
  from verified closure.
- Not adopted: `dori`/`herdr`/`hc` commands, separate state/supervision registries,
  a resident duty LLM, mandatory delegation, or elapsed-time-based automatic
  approval, closure, or worktree deletion.
- The referenced upstream-derived material is governed by its
  [SUL and NOTICE](https://github.com/vntrevx/omp-dori/blob/3b5487df12540cdd428ebcf7455375d72921e2dc/NOTICE).
  `LICENSE.omp-dori` is not treated as an MIT grant for that entire repository.

### Dori pull-request comparisons: independent implementation

- Snapshot: [vntrevx/omp-dori `dc7402efce8adc87aeac808a1b1f50100f9f53d9`](https://github.com/vntrevx/omp-dori/tree/dc7402efce8adc87aeac808a1b1f50100f9f53d9).
- Compared Git environment isolation in [#9](https://github.com/vntrevx/omp-dori/pull/9),
  reply/voice context in [#32/#41](https://github.com/vntrevx/omp-dori/pull/41), and
  native prompt compatibility regressions in
  [#8/#27](https://github.com/vntrevx/omp-dori/pull/27) and
  [#31](https://github.com/vntrevx/omp-dori/pull/31).
- Also compared evidence-based progress, structured waiting, and visual
  preservation concepts in [#45](https://github.com/vntrevx/omp-dori/pull/45) and
  [#46](https://github.com/vntrevx/omp-dori/pull/46).
- Implemented independently using existing SQLite/Gateway contracts, native custom
  journals, tool results, lanes, progress receipts, discord.js/grammY APIs, and the
  OMP renderer/ExtensionRunner. No Dori code, skills, prompts, tests,
  supervisor, separate state registry, or timers were copied; its SUL notices are
  not reinterpreted.

## Telegram transport: grammY

- API client: [`grammy` 1.46.0](https://github.com/grammyjs/grammY/tree/055a5a440f04d0b9fd5fd75a6d14dac4c2b83553),
  source revision `055a5a440f04d0b9fd5fd75a6d14dac4c2b83553`.
  Installed metadata is in `node_modules/grammy/package.json`; dependency pins
  are in `bun.lock`.
- `src/telegram.ts` and `src/setup-profiles.ts` use `Api` and `InputFile`, not a
  copied Telegram bot or SUL implementation. Version `1.46.0`'s
  `Api.setMyProfilePhoto`, the [official method](https://core.telegram.org/bots/api#setmyprofilephoto),
  and [JPEG multipart contract](https://core.telegram.org/bots/api#inputprofilephotostatic)
  were checked on 2026-11-15. No separate raw Bot API client or image-conversion
  dependency was added.
- Documentation: [grammY API](https://grammy.dev/guide/api),
  [Telegram Bot API](https://core.telegram.org/bots/api).
- SDK cancellation uses [`abort-controller` 3.0.0](https://github.com/mysticatea/abort-controller),
  the signal implementation required by grammY's Node API. Its MIT license,
  Copyright (c) 2017 Toru Nagashima, is retained in
  `node_modules/abort-controller/LICENSE`; preserve it when redistributing the dependency.
- `node_modules/grammy/LICENSE` contains this MIT license. Preserve it when
  redistributing the package:

```text
MIT License

Copyright (c) 2021-2024 KnorpelSenf

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

## Slack transport: official Node Slack SDK

| Package | Installed version | Source revision | License |
| --- | --- | --- | --- |
| `@slack/web-api` | `8.3.0` | [`d8df118652c5749e56e00bb4f614b344993a24e4`](https://github.com/slackapi/node-slack-sdk/tree/d8df118652c5749e56e00bb4f614b344993a24e4) | MIT |
| `@slack/socket-mode` | `3.2.0` | [`5e8d3f08c16144a2d700c38389bf94cbcc4d5f0f`](https://github.com/slackapi/node-slack-sdk/tree/5e8d3f08c16144a2d700c38389bf94cbcc4d5f0f) | MIT |

- `src/slack.ts` uses the official `WebClient` and `SocketModeClient`.
  Transport, routing, and approval coordination are implemented by this
  repository's adapter, not copied from another Slack bot or SUL-covered bot.
- Documentation: [Web API SDK](https://docs.slack.dev/tools/node-slack-sdk/web-api/),
  [Socket Mode SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/),
  [Socket Mode setup](https://docs.slack.dev/apis/events-api/using-socket-mode),
  [starting external uploads](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/),
  and [completing uploads](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).
- Both installed `node_modules/@slack/{web-api,socket-mode}/LICENSE` files contain
  the following identical MIT license and copyright notice. Preserve it when
  redistributing either package:

```text
MIT License

Copyright (c) 2014- Slack Technologies, LLC

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Hermes setup: UX reference, independent implementation

- Reference: [`NousResearch/hermes-agent` `4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5`](https://github.com/NousResearch/hermes-agent/tree/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5).
- Reviewed [`scripts/install.sh`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/scripts/install.sh)
  for `/dev/tty` setup handoff and `0600` environment files,
  [`hermes_cli/secret_prompt.py`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/hermes_cli/secret_prompt.py)
  for secret input and terminal restoration, and
  [`hermes_cli/setup_platforms.py`](https://github.com/NousResearch/hermes-agent/blob/4b40ffb0ad6d7da5d3260f5e499e1691508dd4d5/hermes_cli/setup_platforms.py)
  for platform credential prompts and preservation of existing configuration.
- `scripts/setup.sh` and CLI setup/credential loading were independently written
  for this project's OMP/Gateway contracts using Bash builtins, Node's standard
  `readline`/dotenv parser, and existing configuration validation. No Python or
  installer code was copied, and Hermes is not a runtime dependency.
- Scope is Unix terminals, Bun, and a separately installed unmodified OMP.
  Hermes automatic bot creation, login, Gateway service installation/restart,
  and allow-all policies were not adopted.

## Hermes Gateway: login-autostart UX reference, independent implementation

- Reference: [`NousResearch/hermes-agent` `fa1aab3187fa9951fa7c3620e0aa6f922d6636f6`](https://github.com/NousResearch/hermes-agent/tree/fa1aab3187fa9951fa7c3620e0aa6f922d6636f6).
- Reviewed install/uninstall dispatch in
  [`hermes_cli/gateway.py`](https://github.com/NousResearch/hermes-agent/blob/fa1aab3187fa9951fa7c3620e0aa6f922d6636f6/hermes_cli/gateway.py)
  and per-instance LaunchAgents, `ProgramArguments`, `RunAtLoad`, no-start
  installation, and ownership checks in
  [`hermes_cli/gateway_launchd.py`](https://github.com/NousResearch/hermes-agent/blob/fa1aab3187fa9951fa7c3620e0aa6f922d6636f6/hermes_cli/gateway_launchd.py).
- Upstream license: [MIT, Copyright (c) 2025 Nous Research](https://github.com/NousResearch/hermes-agent/blob/fa1aab3187fa9951fa7c3620e0aa6f922d6636f6/LICENSE).
  `src/autostart.ts` and CLI install/uninstall/status were independently
  implemented with Node/Bun APIs and macOS `launchctl`/`plutil`, not copied Python.
- Registration runs the existing `start` once at macOS login. It does not import
  Hermes KeepAlive supervision, forced process replacement, detached fallback,
  sudo/system services, or a Windows backend. Installation does not start the bot;
  prepare/doctor/setup do not register it automatically.
- Assumptions: the current account's macOS GUI login, accessible absolute
  Bun/repository/config paths, private sibling credentials, and separately installed
  OMP. Registration is distinct from Gateway readiness and does not establish
  successful reboot or operational-account round-trip verification.

## Managed ULW: separately licensed package and bundled skills

- Source: [dbc-hbin/omp-ulw](https://github.com/dbc-hbin/omp-ulw);
  management configuration: `upstream/ulw.json`. Packages are prepared separately
  under `.upstream/ulw/revisions/<revision>/package`; `active.json` identifies the
  selected revision. The inspected snapshot was
  [`1625e0de2e4807f1cfdac19e6b54578af1329951`](https://github.com/dbc-hbin/omp-ulw/tree/1625e0de2e4807f1cfdac19e6b54578af1329951).
- This project's MIT license does not grant a license to that separate package or
  override its per-file licenses and attribution. The inspected snapshot has no
  root LICENSE or `package.json` license declaration; no blanket package license
  is asserted here.
- Bundled `skills/{browser,coding-agent-sessions,ultimate-browsing}/LICENSE.md`
  retain the Sustainable Use License. `skills/computer-use/LICENSE.md` retains
  SUL terms for OMO-derived portions and MIT terms for OMP-derived guidance.
  These are actual bundled materials, not merely conceptual references.
- Other retained notices include `skills/frontend/LICENSE-Apache-2.0.txt`,
  the MIT license in `skills/frontend/references/designpowers/vendor/LICENSE`
  (`Copyright (c) 2026 MC Dean`), and the MIT license in
  `skills/programming/scripts/typescript/oxc/lint/oxlint-plugin/LICENSE`
  (`Copyright (c) 2026 T3 Tools Inc.`).
- Consult the selected package's license and attribution files before using or
  redistributing it. Preserve those files and applicable modification notices;
  the Dori non-copy statements above do not imply that ULW's bundled skills are MIT.

## OMP: installed runtime and published SDK

- Runtime baseline: [can1357/oh-my-pi v18.20.2](https://github.com/can1357/oh-my-pi/tree/7c49c11aa5bbaf3f418406583096168ad5b8c6dc),
  revision `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`.
- The operator installs OMP separately. This repository does not patch, build,
  or redistribute an OMP executable. CI downloads upstream release binaries and
  verifies them against the upstream checksum manifest.
- Published `@oh-my-pi/pi-coding-agent`, `pi-ai`, `pi-catalog`, `pi-tui`, and `pi-utils`
  dependencies are pinned in `package.json`; `bun.lock` records resolved packages
  and integrity data. Public SDK interfaces support this project's managed
  extensions and transport adapter. Same-process native TUI attach is not claimed.
- `pi-tui` supplies native thinking-level helpers and the keyword matcher used by
  tests; no TUI implementation is copied into this project.
- The live state projection in `src/host-extension.ts` adapts the `get_state`
  object from [`rpc-mode.ts` at the baseline revision](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/packages/coding-agent/src/modes/rpc/rpc-mode.ts).
  It reads the actual session through public getters so status remains observable
  during a serialized command. It conservatively reports unsettled while that
  command is pending; idle disposal still requires the stock RPC settlement check.
  The upstream copyright and MIT terms below apply to this adapted projection.
- The published SDK and the source artwork identified above retain the following
  MIT notice, also present in the installed package's `LICENSE` and the
  [upstream LICENSE](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/LICENSE):

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
