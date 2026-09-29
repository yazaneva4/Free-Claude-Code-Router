'use strict';

const updater = require('./updater');

/**
 * Owns the one update flow this build has: check, download, verify, swap the
 * packed build, relaunch.
 *
 * The bundled router also has an update screen. It talks to Squirrel.Mac, which
 * cannot install anything for an ad-hoc signed app, and it is fed upstream's
 * releases, so it can only ever offer a download that fails and a button that
 * then does nothing. `silenceBundledUpdater` takes that path away so the only
 * update the app offers is one that actually installs.
 */

const TARGET = process.env.CCR_APP_ASAR
  || '/Applications/Claude Code Router.app/Contents/Resources/app.asar';

/**
 * How often a running app looks for a new build.
 *
 * Long enough not to chatter at the release API, short enough that a session
 * left open over a few days still hears about a release without needing a
 * relaunch. A device that is closed simply checks the next time it starts.
 *
 * The cached answer from the last check has to expire before this fires, or
 * every tick is answered from disk and nothing is ever asked again. That
 * relationship is asserted in the tests rather than left to a comment.
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

class UpdateService {
  constructor({
    currentVersion,
    home = null,
    target = TARGET,
    fetchImpl = fetch,
    relaunch = null,
    now = Date.now(),
    log = () => {},
    isSignedIn = () => true,
    intervalMs = CHECK_INTERVAL_MS,
  } = {}) {
    this.log = log;
    this.isSignedIn = isSignedIn;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.currentVersion = currentVersion;
    this.home = home;
    this.target = target;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.relaunch = relaunch;
    this.status = {
      state: 'idle',
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      progress: 0,
      error: null,
      notes: null,
      releaseUrl: null,
      checkedAt: null,
    };
    this.busy = false;
  }

  snapshot() {
    return { ...this.status, busy: this.busy, target: this.target };
  }

  /**
   * One scheduled look. It only ever reports: installing stays a decision the
   * person makes, because it replaces the build of a running app.
   */
  async tick() {
    if (this.busy) return this.snapshot();
    const before = this.status.latestVersion;
    const found = await this.check();
    if (found.updateAvailable && found.latestVersion !== before) {
      this.log(`update available: ${found.latestVersion} (not installed without asking)`);
    }
    return found;
  }

  /**
   * Starts the periodic check. The timer is unref'd so it can never be the
   * reason a process stays alive.
   */
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`scheduled update check failed: ${err && err.message ? err.message : err}`));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (!this.timer) return this;
    clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  async check({ force = false } = {}) {
    if (this.busy) return this.snapshot();
    // Signed out there is no account to update, so nothing is asked of GitHub.
    // This keeps the scheduled check from phoning home for a signed out device.
    if (typeof this.isSignedIn === 'function' && !this.isSignedIn()) {
      return { ...this.snapshot(), state: 'signed-out' };
    }
    this.busy = true;
    try {
      const found = await updater.check({
        currentVersion: this.currentVersion,
        home: this.home || undefined,
        force,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
      this.status = {
        ...this.status,
        state: found.state,
        latestVersion: found.latestVersion,
        updateAvailable: found.updateAvailable,
        notes: found.notes,
        releaseUrl: found.releaseUrl,
        // The download needs these, and they only exist on the check that found
        // the release, so they are kept rather than looked up again.
        assetUrl: found.assetUrl || null,
        checksumUrl: found.checksumUrl || null,
        error: found.error || null,
        code: found.code || null,
        checkedAt: found.checkedAt,
        progress: 0,
      };
      this.log(`update check: ${found.state}${found.latestVersion ? ` ${found.latestVersion}` : ''}${found.error ? ` (${found.error})` : ''}`);
      return this.snapshot();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Downloads, verifies and installs in one call, reporting progress as it goes.
   * Any failure leaves the installed build exactly as it was.
   */
  async install() {
    if (this.busy) return { ...this.snapshot(), refused: 'busy' };
    if (!this.status.updateAvailable || !this.status.latestVersion) {
      return { ...this.snapshot(), refused: 'nothing_to_install' };
    }
    this.busy = true;
    const version = this.status.latestVersion;
    const report = (event) => {
      if (event.phase === 'download') {
        this.status = { ...this.status, state: 'downloading', progress: Math.round(event.ratio * 100) };
      } else if (event.phase === 'verified') {
        this.status = { ...this.status, state: 'installing', progress: 100 };
      }
    };
    try {
      const got = await updater.download({
        version,
        assetUrl: this.status.assetUrl,
        checksumUrl: this.status.checksumUrl,
        home: this.home || undefined,
        fetchImpl: this.fetchImpl,
        onProgress: report,
      });
      const done = updater.install({ version, file: got.file, target: this.target, home: this.home || undefined, now: this.now });
      this.status = {
        ...this.status,
        state: 'installed',
        currentVersion: done.installedVersion || version,
        latestVersion: null,
        updateAvailable: false,
        progress: 100,
        error: null,
      };
      this.log(`update installed: ${done.version} (previous build kept at ${done.backup})`);
      if (typeof this.relaunch === 'function') {
        this.relaunch();
      } else {
        // Only reached inside Electron, where the relaunch is the real one.
        const { app } = require('electron');
        app.relaunch();
        app.exit(0);
      }
      return this.snapshot();
    } catch (err) {
      this.status = {
        ...this.status,
        state: 'failed',
        error: err && err.message ? err.message : String(err),
        code: (err && err.code) || 'install_failed',
        progress: 0,
      };
      this.log(`update failed: ${this.status.error}`);
      return this.snapshot();
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Stops the bundled Squirrel updater from checking, downloading or installing.
 *
 * It is left as a harmless object rather than deleted so the router's own update
 * screen renders "no update available" instead of throwing, and so nothing in
 * the bundle can call `quitAndInstall` behind our back. A release published to
 * the upstream feed would otherwise replace this whole build.
 */
function silenceBundledUpdater(electron = null) {
  if (!electron) ({ electron } = { electron: require('electron') });
  const target = electron.autoUpdater;
  if (!target || target.__ccrSilenced) return false;
  const noUpdate = { updateInfo: { version: null }, version: null, updateNotAvailable: null, downloadedUpdate: false };

  target.checkForUpdates = async () => {
    // Nothing is downloaded, so nothing can be half-applied.
    return { updateInfo: { version: null } };
  };
  target.downloadUpdate = async () => { throw Object.assign(new Error('Updates are handled by this build.'), { code: 'ccr_managed' }); };
  target.quitAndInstall = () => {};
  target.setFeedURL = () => {};
  target.addListener = () => target;
  target.removeListener = () => target;
  target.removeAllListeners = () => target;
  target.on = () => target;
  target.once = () => target;
  target.emit = () => false;
  target.checkForUpdatesAndNotify = async () => undefined;
  target.__ccrSilenced = true;
  return true;
}

module.exports = { UpdateService, silenceBundledUpdater, TARGET, CHECK_INTERVAL_MS };
