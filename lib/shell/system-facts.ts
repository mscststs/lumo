/**
 * The pseudo-system the sandbox presents.
 *
 * `uname`, `/proc/version`, `/etc/os-release` and `node --version` all describe
 * the same machine, so the strings live here instead of being spelled out at
 * each call site. Dependency-free on purpose: the filesystem imports it to
 * serve `/proc`, and the runtime imports it to answer `uname`, without either
 * pulling in the other.
 */

export const SYSNAME = 'Linux';
export const NODENAME = 'lumo';
export const RELEASE = '6.1.0-lumo';
export const KERNEL_VERSION = '#1 SMP PREEMPT';
export const MACHINE = 'x86_64';
/**
 * `uname -o`. Every Linux system answers `GNU/Linux` here (`uname` reports the
 * kernel's userland, not the distribution); the distribution name lives in
 * `/etc/os-release` as `ID=lumo`.
 */
export const OPERATING_SYSTEM = 'GNU/Linux';

/**
 * Node compatibility level the guest advertises.
 *
 * `v0.0.0-lumo` made every `node -v` gate in a script take the "unsupported"
 * branch, including gates that only test for APIs the QuickJS guest does
 * implement. `22.0.0` is the line whose commonly used surface (fs,
 * child_process, crypto, zlib, fetch, timers, Buffer) the guest covers;
 * `process.versions.lumo` still carries the extension version for callers that
 * need the real one.
 */
export const NODE_VERSION = 'v22.0.0-lumo';
export const NODE_SEMVER = '22.0.0';

/** The installed extension version, or `0.0.0` outside the extension. */
export function extensionVersion(): string {
  try {
    const runtime = (globalThis as {
      chrome?: { runtime?: { getManifest?: () => { version?: string } } };
    }).chrome;
    return runtime?.runtime?.getManifest?.().version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `/etc/os-release`, in the shape `source` and `grep '^ID='` expect. */
export function osRelease(): string {
  const version = extensionVersion();
  return [
    'NAME="Lumo Shell"',
    'ID=lumo',
    'ID_LIKE=linux',
    'PRETTY_NAME="Lumo Shell"',
    `VERSION_ID="${version}"`,
    `VERSION="${version} (browser extension)"`,
    'HOME_URL="https://github.com/mscststs/lumo"',
    '',
  ].join('\n');
}

/** `/proc/version`, in the shape `uname -a`-style probes look for. */
export function procVersion(): string {
  return `${SYSNAME} version ${RELEASE} (lumo@just-bash) ${KERNEL_VERSION}\n`;
}
