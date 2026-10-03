import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
// Copy sources: override only platform probing in the test copy, never production code.
const FIXTURE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installer-fixture-')));
for (const item of ['scripts', 'deploy', 'src', 'Dockerfile', 'package.json', 'package-lock.json', '.dockerignore']) {
  fs.cpSync(path.join(REPO_ROOT, item), path.join(FIXTURE, item), { recursive: true });
}
const lib = path.join(FIXTURE, 'scripts/lib/server-preflight.sh');
fs.appendFileSync(lib, `
preflight_check() {
 preflight_validate_domain "$1" && preflight_validate_mode "$2" && preflight_validate_install_dir "$3" && preflight_validate_port "$4"
}
`);
const INSTALL_SCRIPT = path.join(FIXTURE, 'scripts', 'install-server.sh');
// Real installer checks id; stub id in the test copy to avoid root privileges.
fs.writeFileSync(INSTALL_SCRIPT, fs.readFileSync(INSTALL_SCRIPT, 'utf8').replace('${EUID:-$(id -u)}', '0'));
after(() => fs.rmSync(FIXTURE, { recursive: true, force: true }));

function createTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function createDockerStub(
  binDir: string,
  options: { failHealth?: boolean; failBuild?: boolean; failNewHealth?: boolean; failRestoreTag?: boolean } = {},
) {
  const dockerPath = path.join(binDir, 'docker');
  const restored = path.join(binDir, 'restored');
  fs.rmSync(restored, { force: true });
  // failNewHealth: only the rebuilt image is unhealthy; health passes again once the old image id is re-tagged.
  const script = `#!/bin/sh
cmd="$1"
shift

if [ "$cmd" = "image" ]; then
  case "$*" in *--format*) echo "sha256:old" ;; esac
  exit 0
fi

if [ "$cmd" = "tag" ]; then
  if [ "$1" = "sha256:old" ]; then
    ${options.failRestoreTag ? 'exit 1' : `touch "${restored}"`}
  fi
  exit 0
fi

if [ "$cmd" = "inspect" ]; then
  echo "sha256:old"
  exit 0
fi

if [ "$cmd" = "build" ]; then
  ${options.failBuild ? 'exit 1' : 'exit 0'}
fi

if [ "$cmd" = "compose" ]; then
  exit 0
fi

if [ "$cmd" = "exec" ]; then
  ${options.failHealth ? 'exit 1' : options.failNewHealth ? `[ -f "${restored}" ] && exit 0; exit 1` : 'exit 0'}
fi

exit 0
`;
  fs.writeFileSync(dockerPath, script, { mode: 0o755 });
}

function installEnv(binDir: string, backupDir: string) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    EUID: '0',
    PI_REMOTE_BACKUP_DIR: backupDir,
    PI_REMOTE_HEALTH_RETRIES: '2',
    PI_REMOTE_HEALTH_INTERVAL: '0.1',
  };
}

function runInstall(targetDir: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir], {
    encoding: 'utf-8',
    env,
  });
}

function listTree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

test('server-install: --help prints usage and exits cleanly', () => {
  const res = spawnSync('bash', [INSTALL_SCRIPT, '--help'], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--domain/);
  assert.match(res.stdout, /--mode/);
  assert.match(res.stdout, /--dry-run/);
});

test('server-install: fails if --domain is missing', () => {
  const res = spawnSync('bash', [INSTALL_SCRIPT], { encoding: 'utf-8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /必须指定 --domain 参数/);
});

test('server-install: dry-run does not write files or directories', () => {
  const tmpParent = createTempDir('pi-dryrun-');
  const targetDir = path.join(tmpParent, 'should-not-exist');

  const res = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'test.example.com', '--install-dir', targetDir, '--dry-run'],
    { encoding: 'utf-8' }
  );

  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[DRY-RUN\]/);
  assert.equal(fs.existsSync(targetDir), false, 'target directory must not be created during dry-run');
  fs.rmSync(tmpParent, { recursive: true, force: true });
});

test('server-install: refuses symlinked install directory', () => {
  const tmpDir = createTempDir('pi-symlink-test-');
  const realDir = path.join(tmpDir, 'real');
  const symlinkDir = path.join(tmpDir, 'link');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, symlinkDir);

  const res = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'test.example.com', '--install-dir', symlinkDir, '--dry-run'],
    { encoding: 'utf-8' }
  );

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /符号链接/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: refuses collision with non-managed existing directory', () => {
  const tmpDir = createTempDir('pi-collision-test-');
  const targetDir = path.join(tmpDir, 'unmanaged');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, 'some-file.txt'), 'hello');

  const res = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'test.example.com', '--install-dir', targetDir, '--dry-run'],
    { encoding: 'utf-8' }
  );

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /未包含受管标记|拒绝覆盖/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: refuses invalid marker file content', () => {
  const tmpDir = createTempDir('pi-marker-test-');
  const targetDir = path.join(tmpDir, 'badmarker');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, '.pi-remote-managed'), 'wrong-v0');

  const res = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'test.example.com', '--install-dir', targetDir, '--dry-run'],
    { encoding: 'utf-8' }
  );

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /受管标记不匹配|管理标记不合法/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: successful install and second-run token preservation with stub docker', () => {
  const tmpDir = createTempDir('pi-install-run-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);

  createDockerStub(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    EUID: '0', // pretend root
    PI_REMOTE_BACKUP_DIR: backupDir,
    PI_REMOTE_HEALTH_RETRIES: '2',
    PI_REMOTE_HEALTH_INTERVAL: '0.1',
  };

  // Run 1: initial install
  const res1 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir, '--mode', 'standalone'],
    { encoding: 'utf-8', env }
  );

  assert.equal(res1.status, 0, `Run 1 failed: ${res1.stderr}\n${res1.stdout}`);
  assert.equal(fs.existsSync(path.join(targetDir, '.pi-remote-managed')), true);
  const marker = fs.readFileSync(path.join(targetDir, '.pi-remote-managed'), 'utf-8').trim();
  assert.equal(marker, 'pi-remote-installer-v1');

  // Verify .env created with permissions
  const envPath = path.join(targetDir, '.env');
  assert.equal(fs.existsSync(envPath), true);
  const envStat = fs.statSync(envPath);
  assert.equal((envStat.mode & 0o777), 0o600);
  const envContent1 = fs.readFileSync(envPath, 'utf-8');
  const match1 = envContent1.match(/^RELAY_TOKEN=([a-f0-9]+)$/m);
  assert.ok(match1, 'token should be hex format');
  const initialToken = match1[1]!;
  assert.ok(initialToken.length >= 32);

  // Run 2: upgrade/re-install should preserve the exact same token
  const res2 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir, '--mode', 'standalone'],
    { encoding: 'utf-8', env }
  );

  assert.equal(res2.status, 0, `Run 2 failed: ${res2.stderr}\n${res2.stdout}`);
  const envContent2 = fs.readFileSync(envPath, 'utf-8');
  const match2 = envContent2.match(/^RELAY_TOKEN=([a-f0-9]+)$/m);
  assert.ok(match2);
  assert.equal(match2[1], initialToken, 'existing token must be preserved on upgrade');

  // Output must NOT leak the secret token
  assert.equal(res1.stdout.includes(initialToken), false, 'token must not be printed in stdout');
  assert.equal(res1.stderr.includes(initialToken), false, 'token must not be printed in stderr');
  assert.equal(res2.stdout.includes(initialToken), false, 'token must not be printed in stdout');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: rollback on health check failure during upgrade', () => {
  const tmpDir = createTempDir('pi-rollback-run-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);

  createDockerStub(binDir, { failHealth: false });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    EUID: '0',
    PI_REMOTE_BACKUP_DIR: backupDir,
    PI_REMOTE_HEALTH_RETRIES: '2',
    PI_REMOTE_HEALTH_INTERVAL: '0.1',
  };

  // Step 1: Good initial install
  const res1 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir],
    { encoding: 'utf-8', env }
  );
  assert.equal(res1.status, 0);
  const oldEnv = fs.readFileSync(path.join(targetDir, '.env'), 'utf-8');

  // Modify something in target to check restoration
  fs.writeFileSync(path.join(targetDir, 'canary.txt'), 'canary-original-version');

  // Step 2: Second run with failing health check
  createDockerStub(binDir, { failHealth: true });
  const res2 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir],
    { encoding: 'utf-8', env }
  );

  assert.notEqual(res2.status, 0);
  assert.match(res2.stderr, /健康检查失败/);
  assert.match(res2.stderr, /触发安全回滚/);

  // Check canary is restored
  assert.equal(fs.existsSync(path.join(targetDir, 'canary.txt')), true);
  assert.equal(fs.readFileSync(path.join(targetDir, 'canary.txt'), 'utf-8'), 'canary-original-version');
  assert.equal(fs.readFileSync(path.join(targetDir, '.env'), 'utf-8'), oldEnv);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: verifies backup sha256 creation and old backup cleanup on upgrade', () => {
  const tmpDir = createTempDir('pi-backup-verify-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);

  createDockerStub(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    EUID: '0',
    PI_REMOTE_BACKUP_DIR: backupDir,
    PI_REMOTE_HEALTH_RETRIES: '2',
    PI_REMOTE_HEALTH_INTERVAL: '0.1',
  };

  // Run 1: initial install
  const res1 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir],
    { encoding: 'utf-8', env }
  );
  assert.equal(res1.status, 0);

  // Run 2: upgrade 1 -> creates backup 1
  const res2 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir],
    { encoding: 'utf-8', env }
  );
  assert.equal(res2.status, 0);
  const backupsAfterRun2 = fs.readdirSync(backupDir).filter(f => f.endsWith('.tar.gz'));
  assert.equal(backupsAfterRun2.length, 1);
  const backup1 = backupsAfterRun2[0]!;
  assert.equal(fs.existsSync(path.join(backupDir, `${backup1}.sha256`)), true);

  // Wait 1.1s to ensure distinct timestamp for backup filename
  const start = Date.now();
  while (Date.now() - start < 1100) {}

  // Run 3: upgrade 2 -> creates backup 2 and deletes backup 1
  const res3 = spawnSync(
    'bash',
    [INSTALL_SCRIPT, '--domain', 'my.test.io', '--install-dir', targetDir],
    { encoding: 'utf-8', env }
  );
  assert.equal(res3.status, 0);
  const backupsAfterRun3 = fs.readdirSync(backupDir).filter(f => f.endsWith('.tar.gz'));
  assert.equal(backupsAfterRun3.length, 1);
  const backup2 = backupsAfterRun3[0]!;
  assert.notEqual(backup2, backup1);
  assert.equal(fs.existsSync(path.join(backupDir, backup1)), false, 'old backup should be cleaned up');
  assert.equal(fs.existsSync(path.join(backupDir, `${backup1}.sha256`)), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: failed upgrade restores the exact previous tree, image, and health', () => {
  const tmpDir = createTempDir('pi-restore-exact-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);
  createDockerStub(binDir);
  const env = installEnv(binDir, backupDir);

  assert.equal(runInstall(targetDir, env).status, 0);
  // Simulate an older managed install that predates .dockerignore; a failed upgrade must not leave it behind.
  fs.rmSync(path.join(targetDir, '.dockerignore'));
  const before = listTree(targetDir);

  createDockerStub(binDir, { failNewHealth: true });
  const res = runInstall(targetDir, env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /旧服务健康检查通过/);
  assert.deepEqual(listTree(targetDir), before);
  assert.deepEqual(fs.readdirSync(tmpDir).filter(n => n.startsWith('.pi-remote-')), [], 'no staging dirs left');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: reports rollback failure when the old image cannot be restored', () => {
  const tmpDir = createTempDir('pi-restore-tag-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);
  createDockerStub(binDir);
  const env = installEnv(binDir, backupDir);
  assert.equal(runInstall(targetDir, env).status, 0);

  createDockerStub(binDir, { failNewHealth: true, failRestoreTag: true });
  const res = runInstall(targetDir, env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /回滚失败，旧镜像/);
  assert.doesNotMatch(res.stderr, /已恢复为更新前状态/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server-install: upgrade never writes through symlinks inside the install dir', () => {
  const tmpDir = createTempDir('pi-inner-link-');
  const binDir = path.join(tmpDir, 'bin');
  const targetDir = path.join(tmpDir, 'target');
  const backupDir = path.join(tmpDir, 'backups');
  const outside = path.join(tmpDir, 'outside.txt');
  fs.mkdirSync(binDir);
  fs.mkdirSync(backupDir);
  fs.writeFileSync(outside, 'outside-original');
  createDockerStub(binDir);
  const env = installEnv(binDir, backupDir);
  assert.equal(runInstall(targetDir, env).status, 0);

  fs.rmSync(path.join(targetDir, 'Caddyfile'));
  fs.symlinkSync(outside, path.join(targetDir, 'Caddyfile'));
  assert.equal(runInstall(targetDir, env).status, 0);
  assert.equal(fs.readFileSync(outside, 'utf-8'), 'outside-original');
  assert.equal(fs.lstatSync(path.join(targetDir, 'Caddyfile')).isSymbolicLink(), false);

  const envPath = path.join(targetDir, '.env');
  fs.copyFileSync(envPath, outside);
  const outsideEnv = fs.readFileSync(outside, 'utf-8');
  fs.rmSync(envPath);
  fs.symlinkSync(outside, envPath);
  const res = runInstall(targetDir, env);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\.env 是符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf-8'), outsideEnv);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
