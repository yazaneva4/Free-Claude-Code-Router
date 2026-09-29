# Free Claude Code Router

A local account-gated front end for [Claude Code
Router](https://github.com/musistudio/claude-code-router). It puts a real
account system in front of the router, keeps your API keys encrypted, shares
them with your other devices if you want, and installs updates that actually
work.

## Install

This repository layers on top of the router rather than replacing it, so the
router app has to be installed once first:

```sh
open https://github.com/musistudio/claude-code-router/releases
```

Move `Claude Code Router.app` to `/Applications`, then from a clone of this
repository:

```sh
./run.command --install
```

That packs this repository and puts it in the installed app as
`Contents/Resources/app.asar`, re-signs the bundle so macOS will launch it, and
opens it.

If the app lives somewhere else, set `CCR_APP_PATH` to the `.app` bundle.

Check what you have at any time:

```sh
./run.command --status
```

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
installed. The first three run in CI on every push, using stock Node.
