import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PREFLIGHT_LIB = path.join(REPO_ROOT, 'scripts', 'lib', 'server-preflight.sh');

function createTempDir(prefix: string): string {
  // Use realpathSync to resolve /var/folders symlink to /private/var/folders on macOS
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(rawDir);
}

function runBashScript(commandStr: string, envOverrides: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', commandStr], {
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides }
  });
}

function createDockerStub(binDir: string, options: {
  composeOk?: boolean;
  daemonOk?: boolean;
  projectLabel?: string;
  networkExists?: boolean;
} = {}) {
  const composeOk = options.composeOk ?? true;
  const daemonOk = options.daemonOk ?? true;
  const projectLabel = options.projectLabel ?? 'pi-remote';
  const networkExists = options.networkExists ?? true;

  const script = `#!/bin/sh
cmd="$1"
shift

if [ "$cmd" = "compose" ]; then
  ${composeOk ? 'exit 0' : 'exit 1'}
fi

if [ "$cmd" = "info" ]; then
  ${daemonOk ? 'exit 0' : 'exit 1'}
fi

if [ "$cmd" = "inspect" ]; then
  echo "${projectLabel}"
  exit 0
fi

if [ "$cmd" = "network" ]; then
  sub="$1"
  if [ "$sub" = "inspect" ]; then
    ${networkExists ? 'exit 0' : 'exit 1'}
  fi
  exit 0
fi

exit 0
`;
  fs.writeFileSync(path.join(binDir, 'docker'), script, { mode: 0o755 });
}

test('preflight: sourcing does not execute checks', () => {
  const res = runBashScript(`source "${PREFLIGHT_LIB}"`);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('preflight: validates domain properly', () => {
  const validDomains = ['example.com', 'api.foo-bar.org', 'sub.domain.co.uk'];
  for (const d of validDomains) {
    const res = runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_domain "${d}"`);
    assert.equal(res.status, 0, `Domain ${d} should be valid`);
  }

  const invalidDomains = [
    '',
    'https://example.com',
    'example.com/path',
    'example.com:8080',
    'foo bar.com',
    '-example.com',
    'example..com',
    'example'
  ];
  for (const d of invalidDomains) {
    const res = runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_domain "${d}"`);
    assert.notEqual(res.status, 0, `Domain ${d} should be rejected`);
  }
});

test('preflight: validates mode', () => {
  assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_mode "standalone"`).status, 0);
  assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_mode "external-proxy"`).status, 0);
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_mode "unknown"`).status, 0);
});

test('preflight: validates port', () => {
  for (const port of ['1', '80', '443', '8789', '65535']) {
    assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_port "${port}"`).status, 0);
  }
  for (const port of ['0', '65536', 'abc', '-1', '']) {
    assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_port "${port}"`).status, 0);
  }
});

test('preflight: validates install dir', () => {
  const tempParent = createTempDir('preflight-dir-');

  // Rejects relative
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "opt/pi-remote"`).status, 0);

  // Rejects system roots
  for (const sys of ['/', '/opt', '/usr', '/etc', '/var', '/tmp', '/home']) {
    const res = runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${sys}"`);
    assert.notEqual(res.status, 0, `System path ${sys} must be rejected`);
  }

  // Accepts non-existent deep path
  const deepPath = path.join(tempParent, 'subdir', 'app');
  assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${deepPath}"`).status, 0);

  // Rejects symlink anywhere in components
  const realTarget = path.join(tempParent, 'real');
  fs.mkdirSync(realTarget);
  const linkDir = path.join(tempParent, 'symlink-dir');
  fs.symlinkSync(realTarget, linkDir);
  const childOfLink = path.join(linkDir, 'nested');
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${linkDir}"`).status, 0);
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${childOfLink}"`).status, 0);

  // Non-empty dir without marker is rejected
  const dirtyDir = path.join(tempParent, 'dirty');
  fs.mkdirSync(dirtyDir);
  fs.writeFileSync(path.join(dirtyDir, 'somefile.txt'), 'content');
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${dirtyDir}"`).status, 0);

  // Non-empty dir with wrong marker is rejected
  const badMarkerDir = path.join(tempParent, 'bad-marker');
  fs.mkdirSync(badMarkerDir);
  fs.writeFileSync(path.join(badMarkerDir, '.pi-remote-managed'), 'other-tool-v1');
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${badMarkerDir}"`).status, 0);

  // Non-empty dir with correct marker is accepted
  const goodMarkerDir = path.join(tempParent, 'good-marker');
  fs.mkdirSync(goodMarkerDir);
  fs.writeFileSync(path.join(goodMarkerDir, '.pi-remote-managed'), 'pi-remote-installer-v1');
  assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_validate_install_dir "${goodMarkerDir}"`).status, 0);

  fs.rmSync(tempParent, { recursive: true, force: true });
});

test('preflight: OS and architecture detection via preflight_check_os fixture', () => {
  const tempDir = createTempDir('preflight-os-');
  const osReleaseUbuntu = path.join(tempDir, 'os-ubuntu');
  fs.writeFileSync(osReleaseUbuntu, 'ID=ubuntu\nID_LIKE=debian\n');

  const osReleaseRocky = path.join(tempDir, 'os-rocky');
  fs.writeFileSync(osReleaseRocky, 'ID="rocky"\nID_LIKE="rhel centos fedora"\n');

  const osReleaseDebian = path.join(tempDir, 'os-debian');
  fs.writeFileSync(osReleaseDebian, 'ID=debian\n');

  const osReleaseAlma = path.join(tempDir, 'os-alma');
  fs.writeFileSync(osReleaseAlma, 'ID=almalinux\nID_LIKE="rhel centos fedora"\n');

  const osReleaseFedora = path.join(tempDir, 'os-fedora');
  fs.writeFileSync(osReleaseFedora, 'ID=fedora\n');

  const osReleaseArch = path.join(tempDir, 'os-arch');
  fs.writeFileSync(osReleaseArch, 'ID=arch\n');

  // Test supported OSes on x86_64 and aarch64
  for (const osFile of [osReleaseUbuntu, osReleaseRocky, osReleaseDebian, osReleaseAlma, osReleaseFedora]) {
    assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_check_os "${osFile}" "x86_64"`).status, 0);
    assert.equal(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_check_os "${osFile}" "aarch64"`).status, 0);
  }

  // Unsupported architecture
  assert.notEqual(runBashScript(`source "${PREFLIGHT_LIB}" && preflight_check_os "${osReleaseUbuntu}" "mips64"`).status, 0);

  // Unsupported OS
  const resArch = runBashScript(`source "${PREFLIGHT_LIB}" && preflight_check_os "${osReleaseArch}" "x86_64"`);
  assert.notEqual(resArch.status, 0);
  assert.match(resArch.stderr, /不支持的 Linux 发行版/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('preflight: Docker and daemon checks with actionable instructions', () => {
  const tempDir = createTempDir('preflight-docker-');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);

  const osReleaseUbuntu = path.join(tempDir, 'os-ubuntu');
  fs.writeFileSync(osReleaseUbuntu, 'ID=ubuntu\n');

  // Docker not found
  const resNoDocker = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_docker "${osReleaseUbuntu}"`,
    { PATH: '/usr/bin:/bin', PREFLIGHT_OS_RELEASE: osReleaseUbuntu }
  );
  assert.notEqual(resNoDocker.status, 0);
  assert.match(resNoDocker.stderr, /未检测到 docker 命令/);
  assert.match(resNoDocker.stderr, /Docker/);

  // Docker Compose missing / failing
  createDockerStub(binDir, { composeOk: false });
  const resNoCompose = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_docker "${osReleaseUbuntu}"`,
    { PATH: `${binDir}:/usr/bin:/bin`, PREFLIGHT_OS_RELEASE: osReleaseUbuntu }
  );
  assert.notEqual(resNoCompose.status, 0);
  assert.match(resNoCompose.stderr, /Docker Compose 未安装或无法运行/);

  // Docker daemon down
  createDockerStub(binDir, { composeOk: true, daemonOk: false });
  const resDaemonDown = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_docker "${osReleaseUbuntu}"`,
    { PATH: `${binDir}:/usr/bin:/bin`, PREFLIGHT_OS_RELEASE: osReleaseUbuntu }
  );
  assert.notEqual(resDaemonDown.status, 0);
  assert.match(resDaemonDown.stderr, /Docker 守护进程未运行/);

  // Docker all good
  createDockerStub(binDir, { composeOk: true, daemonOk: true });
  const resDockerOk = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_docker "${osReleaseUbuntu}"`,
    { PATH: `${binDir}:/usr/bin:/bin`, PREFLIGHT_OS_RELEASE: osReleaseUbuntu }
  );
  assert.equal(resDockerOk.status, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('preflight: port check and own container recognition', () => {
  const tempDir = createTempDir('preflight-port-');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);

  // Stub ss that says port 80 is occupied
  const ssScript = `#!/bin/sh
echo "LISTEN 0 128 0.0.0.0:80 0.0.0.0:*"
`;
  fs.writeFileSync(path.join(binDir, 'ss'), ssScript, { mode: 0o755 });

  const managedDir = path.join(tempDir, 'managed');
  fs.mkdirSync(managedDir);
  fs.writeFileSync(path.join(managedDir, '.pi-remote-managed'), 'pi-remote-installer-v1');

  // Case 1: standalone occupied by foreign process -> fails
  createDockerStub(binDir, { projectLabel: 'some-other-app' });
  const resConflict = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_ports "standalone" "8789" "${managedDir}"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.notEqual(resConflict.status, 0);
  assert.match(resConflict.stderr, /端口 80 已被占用/);

  // Case 2: standalone occupied by pi-remote own container -> passes
  createDockerStub(binDir, { projectLabel: 'pi-remote' });
  const resOwnOccupied = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_ports "standalone" "8789" "${managedDir}"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.equal(resOwnOccupied.status, 0);

  // Case 3: external-proxy mode checking occupied custom port
  const ssPortScript = `#!/bin/sh
echo "LISTEN 0 128 0.0.0.0:9000 0.0.0.0:*"
`;
  fs.writeFileSync(path.join(binDir, 'ss'), ssPortScript, { mode: 0o755 });
  createDockerStub(binDir, { projectLabel: 'other' });
  const resExternalConflict = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_ports "external-proxy" "9000" "${managedDir}"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.notEqual(resExternalConflict.status, 0);
  assert.match(resExternalConflict.stderr, /端口 9000 已被占用/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('preflight: external proxy network validation', () => {
  const tempDir = createTempDir('preflight-net-');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);

  createDockerStub(binDir, { networkExists: true });
  // Network exists
  const resOk = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_proxy_network "external-proxy" "caddy_net"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.equal(resOk.status, 0);

  // Invalid network name
  const resInvalidName = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_proxy_network "external-proxy" "caddy net"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.notEqual(resInvalidName.status, 0);
  assert.match(resInvalidName.stderr, /格式不合法/);

  // Network does not exist
  createDockerStub(binDir, { networkExists: false });
  const resNotFound = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_proxy_network "external-proxy" "missing_net"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.notEqual(resNotFound.status, 0);
  assert.match(resNotFound.stderr, /不存在/);

  // Specified in standalone mode -> rejected
  const resStandaloneRejected = runBashScript(
    `source "${PREFLIGHT_LIB}" && preflight_check_proxy_network "standalone" "caddy_net"`,
    { PATH: `${binDir}:/usr/bin:/bin` }
  );
  assert.notEqual(resStandaloneRejected.status, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('preflight: unsupported kernel is rejected without writes', () => {
 const dir = createTempDir('preflight-kernel-');
 const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', {mode:0o755});
 const result = runBashScript(`source "${PREFLIGHT_LIB}"; preflight_check test.example.com standalone "${dir}/target" 8789 ""`, {PATH:`${bin}:${process.env.PATH}`});
 assert.notEqual(result.status, 0);
 assert.match(result.stderr, /Linux/);
 assert.equal(fs.existsSync(path.join(dir,'target')),false);
 fs.rmSync(dir,{recursive:true,force:true});
});
