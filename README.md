# Free Claude Code Router

A local account-gated front end for [Claude Code
Router](https://github.com/musistudio/claude-code-router). It puts a real
account system in front of the router, keeps your API keys encrypted, shares
them with your other devices if you want, and installs updates that actually
work.

## Install from a terminal

Install **Git and Node.js 22 or newer**, and close any running router app. Then
clone this repository:

```sh
git clone https://github.com/yazaneva4/Free-Claude-Code-Router.git
cd Free-Claude-Code-Router
```

Run the command for your operating system:

| Operating system | Terminal command |
| --- | --- |
| macOS | `bash install.sh` |
| Linux desktop | `bash install.sh` |
| Windows PowerShell | `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` |

`node scripts/install.js` or `npm run setup:app` also works on all three systems.
No `npm install` is required. If you already cloned the repo, run
`git pull --ff-only` first.

The installer finds an existing desktop app. If none is installed, it downloads
the matching official [desktop release](https://github.com/musistudio/claude-code-router/releases),
checks GitHub's SHA-256 digest, installs the runtime, and applies this repo's
build. It keeps `app-original.asar` and `app.asar.before-gate` for recovery.
macOS bundles are re-signed; a signing failure restores the previous archive.

| System | Default location for a fresh installation |
| --- | --- |
| macOS | `~/Applications/Claude Code Router.app` |
| Linux | `~/.local/opt/Claude Code Router` |
| Windows | `%LOCALAPPDATA%\Programs\Claude Code Router` |

Linux AppImages are extracted automatically, so FUSE is not required for the
installation. The extracted Electron app still needs your distribution's normal
desktop libraries and a graphical session. Downloads are available only for
architectures present in the upstream release; the installer reports unsupported
combinations rather than choosing the wrong binary.

For an existing app in another location, or a downloaded Linux AppImage:

```sh
node scripts/install.js --app-path "/path/to/the/app-or-AppImage"
```

`CCR_APP_PATH` and `CCR_NODE` are also supported by the shell/PowerShell entry
points. `./run.command --install` installs and opens an existing macOS app.

Installer tests cover all three OS branches with fixture runtimes and simulated
native extraction/signing commands. The router suites run on macOS, Linux and
Windows in CI. The official Linux v3.1.3 AppImage was also downloaded, verified, extracted and
patched successfully in an isolated test directory. Actual desktop launch, OS
installer dialogs and visual behavior require testing on the destination machine.


### Copy-and-paste terminal setup

The installer checks Git and Node.js, installs missing packages, and asks the available system package manager to update outdated packages. Already-current dependencies are left unchanged. Node.js **22+** is required; some Linux distribution repositories may not provide it, in which case the installer stops with an explanation. Package-manager updates may require administrator permission. Git is needed for the initial `git clone` step, so install Git first if it is missing (or download the repository ZIP). An internet connection is needed for fresh installations and package updates. Quit any running Claude Code Router app before installing.

**macOS — Terminal**

```bash
git clone https://github.com/yazaneva4/Free-Claude-Code-Router.git
cd Free-Claude-Code-Router
bash install.sh
```

**Linux — Terminal**

```bash
git clone https://github.com/yazaneva4/Free-Claude-Code-Router.git
cd Free-Claude-Code-Router
bash install.sh
```

**Windows — PowerShell**

```powershell
git clone https://github.com/yazaneva4/Free-Claude-Code-Router.git
Set-Location Free-Claude-Code-Router
.\install.ps1
```

If your Windows PowerShell execution policy blocks the local script, use `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` from inside the cloned repository. These commands install the desktop application, **not** a global `fcr` terminal executable. For updates, run `git pull --ff-only` inside the repository and rerun the relevant installer.

## Terminal commands: native versus routed

- `claude` starts the original Claude Code installation with its normal authentication and configuration.
- `fcr claude` starts Claude Code with a separate `CLAUDE_CONFIG_DIR` and the local FCR gateway token. Arguments are forwarded, for example `fcr claude -p "Hello"`.
- `fcr claude` requires a running, configured router. It does not silently fall back to native Claude.
- The installer places the `fcr` launcher in `~/.local/bin` on macOS/Linux or `%APPDATA%\\npm` on Windows. Ensure that directory is in your shell PATH, and reopen your terminal after installation.
- **Important:** This launcher does not rewrite your native Claude configuration. Older FCR/upstream router installations may already have changed `~/.claude/settings.json`; review and restore those older changes separately if native `claude` is still routed.

## Agent profiles: manual setup

The Agent Profiles page lists available harnesses as an **addable catalog**, not automatically configured profiles. A harness is only configured when you explicitly add it. Removing a profile deletes it from saved profiles; the catalog entry remains so you can add it again later. An unset model is not silently restored to a previously selected default. The terminal launcher currently supports `fcr claude`; additional harness launchers and desktop-app Run buttons are planned, not yet implemented.

## Free routed agents (`fcr`)

In Settings → Agents, choose `fcr Claude Code`, `fcr Codex CLI`, or the
corresponding `fcr <agent name>` option before adding the harness. Existing
profiles can switch modes there too. The `fcr` alias is accepted by the profile
API as well, for example `fcr claude-code`.

This mode uses the configured router models and does not ask for a harness
subscription or expose subscription-only models. Local models can run without
cloud inference charges; a configured cloud provider can still charge for its
models. Switching modes resets the selected model to automatic so a native
subscription model is not carried into routed mode.

## Everyday commands

| command | what it does |
| --- | --- |
| `./run.command` | open the app |
| `./run.command --install` | put this build in the installed app, then open it |
| `./run.command --tests` | syntax, unit, IPC and in-app tests, then open the app |
| `./run.command --selftest` | only the in-app tests, against a throwaway account |
| `./run.command --dist` | build an installable app and zip into `dist/` |
| `./run.command --log` | the last lines of the app's log |
| `./run.command --status` | what is installed and which build is in place |

## Updates

Updates are this project's own, not the router's. The router updates itself
with Squirrel.Mac, which cannot install anything for an ad-hoc signed build and
was pointed at upstream's releases, so it could only offer a download that fails
and then leave a dead button behind. That path is switched off at startup.

Instead, a release here carries one packed build plus its SHA-256. The app
downloads the build, checks it against the published hash, keeps the build it
replaces, and only then swaps it in. A build that does not match its hash is
never written, and one that lies about its version is rolled back.

## Publishing a release

From a machine that has the app installed:

```sh
GITHUB_TOKEN=… ./run.command --release 3.1.2 "What changed"
```

The token needs `repo` scope, from
<https://github.com/settings/tokens>. Releases go through the GitHub API rather
than over SSH, which is why this one step is not an SSH operation. The command
builds, hashes, creates the release and attaches `app.asar`, its checksum, and a
zip of the whole app for a manual install.

The version has to be higher than the one already published, and higher than the
one in `package.json`, or the app will not offer it as an update.

Once published, a signed-in device finds it within about half an hour: the app
checks every 30 minutes and caches an answer for 15, so every tick is a real
check. A closed device finds it at next launch. It is never installed without
you pressing Install in Settings.

## What is in here

```
src/main/          the gate: accounts, vault, settings, gateway, agents, updates
src/renderer/      the account and settings pages
src/preload/       the only bridge between them
scripts/           pack, build, verify and release
test/              unit and IPC tests
```

`src/main/main.js` loads the router from the installed app and wraps its window
so the account gate is in front of it. Everything else is plain Node with no
framework, which is why the test suite runs in CI without the app.

## Safety notes

- **Your keys are never sent anywhere by default.** They are encrypted with the
  macOS keychain where that is available, otherwise with a key on the device.
- **Shared keys stay sealed.** If you choose synced storage, keys are sealed
  with your account password before they leave. The sync endpoint only ever
  holds the sealed copy, and another device opens them by signing in with the
  same password. The seal is not tied to one device, which is what lets a second
  device read it.
- **No agent login is ever collected.** A paid agent's models appear once you
  sign in to that agent yourself, through the agent's own sign-in. This app runs
  the command the agent documents and then reads what the agent reports; it
  never sees or stores a third-party credential.
- **The bundled auto-updater is disabled**, because it points at upstream
  releases that would replace this whole build.
- A **CI check fails the build** if anything shaped like a real credential is
  committed, and `.gitignore` keeps `dist/`, keys and local state out.

## Tests

```sh
./run.command --tests
```

Syntax, unit, IPC and in-app tests, against a throwaway account in a temporary
directory. The in-app tests drive the real window, so they need the app
installed, and they are macOS only. The first three run in CI on every push, on
macOS, Linux and Windows, using stock Node:

```sh
node scripts/check.js
node test/run.js
node test/ipc.js
```
