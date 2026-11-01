# Release validation

The desktop application and the separately maintained remote website use the
same conversation contracts. Their release checks remain separate so website
sources do not need to be committed to the application repository.

## Desktop

`npm run check:core` runs the existing core regressions, architecture and host
contracts, HTTP integration, scheduled-task authorization/lifecycle and network
checks. `Core checks` runs it for pull requests and main, alongside desktop
architecture, queue and scheduled-task UI tests. Kernel compatibility continues
to run on macOS, Windows and Linux. The queue UI test always validates desktop
behavior; its remote section is skipped only when the website is absent from
a core-only checkout.

`Release` waits for Core checks, Kernel compatibility and Windows compatibility.
All jobs check out one immutable source commit and apply the same validated
version-only package metadata. Only then can the tag job create the version
commit. Builds check out that exact resulting commit, not a mutable tag or main.
A concurrent main update causes the main push to fail rather than merging
untested changes. Release runs are serialized, including rebuilds of a version.

`Build verified artifacts` applies the same gates but never publishes. `Release
on tag` passes the tag's exact source commit to Release rather than implicitly
releasing newer main code.

The workflows enforce these dependencies internally. Repository branch-protection
settings can additionally require `Core checks` and `Kernel compatibility`; those
settings are not changed by this code.

## Remote website

Prepare the latest remote sources in `remote/` alongside the application checkout.
Keep a **separate checkout of the desktop version users currently run**, with its
Node dependencies installed. Do not point the baseline at the candidate checkout.
Install the separate remote package dependencies and then run:

```sh
npm ci --prefix remote
npm run check:remote-release -- --baseline /path/to/released-asHub --ui
```

This builds the candidate, tests the shared presentation/replay contracts, remote
protocol and rendering regressions, and the gateway against both candidate and
released desktop source. All integration tasks use temporary fixture data and
mock bridges, not real accounts or model endpoints. The released-desktop test
checks the current gateway against the older desktop routes and permissions;
shared implementation files are required to match only the candidate checkout.

`--ui` includes desktop/remote queue interactions, Chromium layout and WebKit
mobile scrolling/detail/sidebar tests. Remote queue acceptance explicitly requires
the website fixture; a missing website fails validation rather than being skipped.
The test environment must have Electron and Playwright with WebKit available
(the existing WebKit scripts resolve `playwright`, including through `NODE_PATH`).
Missing runtimes or failed tests stop the command. Running without `--ui` is a
protocol-only diagnostic and does **not** complete browser acceptance.

The command never connects to the deployment server or publishes files. Deploy
only the validated remote source after the full command passes, and retain the
baseline version and candidate commit in the deployment record.
