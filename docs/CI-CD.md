# CircleCI: what ran and what still requires a runner

CI configuration is [`.circleci/config.yml`](../.circleci/config.yml). Each
actual job is explicit; no checks are silently disabled. On **2026-10-25**, the
latest public `main` pipeline visible through CircleCI's **unauthenticated** API
was [pipeline 17](https://app.circleci.com/pipelines/github/favour187/fluxa/17)
for upstream commit `e58c3ffc56a29d058a037bc6908d2529b6e61d70`. Its `main`
workflow finished **success** with `validate`, `security`, `e2e-browser`,
`e2e-desktop`, `build-web`, `build-linux`, `build-windows`,
`build-macos-unsigned` and `build-android` successful. These were runs of the
**previous upstream revision**; they do **not** test the local working tree,
protocol v2, iOS project or new recovery/sharing tests. No CI URL is claimed
for unpushed work.

You can monitor a **public** repository without supplying a personal token:

```bash
curl -fsS 'https://circleci.com/api/v2/project/gh/favour187/fluxa/pipeline?branch=main'
# Take a returned pipeline id; then:
curl -fsS 'https://circleci.com/api/v2/pipeline/<id>/workflow'
# Take a returned workflow id; then:
curl -fsS 'https://circleci.com/api/v2/workflow/<id>/job'
```

Do not put a CircleCI personal access token in a source file, command-line URL,
shell history, log or conversation reply. If a private API endpoint is needed,
use a secret manager or an authenticated integration. Public API access is
sufficient to read this repo's existing workflow/job statuses. A manually
triggered `macos_runner: true` workflow is only possible with a macOS executor
on the CircleCI plan and an authorised operator; **none was triggered here**.

## Jobs on branch and main pipelines

- `validate`: lockfile install, strict TypeScript check, Node tests, web/Node build.
- `security`: production dependency audit, source-pattern credential scan and
  checks against tracking signing keys.
- `e2e-browser`: real Chromium two-context transfer/consent/restart suite.
- `e2e-desktop`: Linux Electron instances under Xvfb, native-save/mDNS tests.
- `build-web`: static bundle archive and manifest.
- `build-linux`: unsigned AppImage/deb, manifest.
- `build-windows`: Windows machine, NSIS and portable exe, metadata check.
- `build-android`: Android executor, Capacitor sync, APK/AAB, conditional signing
  verification. If signing inputs are absent it reports an **unsigned** output;
  a successful build alone is not proof of release signing. In upstream pipeline
  **17**, Android job **173** did have signing enabled: its public build manifest
  reports the APK and AAB signed. The APK's SHA-256 matches the manifest and
  independent `apksigner verify --verbose --print-certs` confirms release-key
  APK v1/v2 signatures (one `CN=Fluxa, OU=Fluxa Releases` signer). The *new*
  revision still needs its own signed job and artifact verification.
- `build-macos-unsigned`: Linux produces a macOS-shaped unsigned zip, **not** a
  tested/notarised macOS release.

When the optional `macos_runner` pipeline parameter is enabled on a plan with
Mac machines: `build-macos` compiles desktop dmg/zip, and the **new**
`build-ios-simulator` syncs pods, compiles Xcode source with
`CODE_SIGNING_ALLOWED=NO`, checks identifiers/version and stores an unsigned
Simulator `.app` zip. That artifact is neither an installable iPhone IPA nor a
signed App Store package. This job **has not run**, so iOS is source/sync-only.

Release-tag workflows include a **manual hold** and, if an operator supplies
proper separate credentials, may create a draft GitHub release. Do not confuse
those publishing secrets with Fluxa's coturn REST/enrolment secrets. For this
request no tag, publishing operation or intermediate branch push is permitted.

CI artifacts are not bundled into the git tree; consult the run's artifacts
and build manifests for actual hashes/signing state. See [RELEASE.md](RELEASE.md)
for local commands, SDK requirements and per-platform blockers.
