'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { patchAgent, patchBridge, apply, uninstall } = require('../apply.cjs');
const { DEFAULT_CONFIG } = require('../per-chat-metadata.cjs');

const OWNER = 'local.codexusagebadge.windows';
const script = path.join(__dirname, '..', 'apply.cjs');

function fixtureAgent() {
  return [
    'function boot(){ return [installUsageBadge,installProjectColors,installProjectSizes,installThreadTokens]; }',
    'function installThreadTokens() {',
    '  const VERSION = 7;',
    "  const rule = 'position: relative; display: inline-block; align-self: center; flex: 0 0 12px; width: 12px; height: 12px;';",
    '  return { level: level(total), state: \'ready\', detail: `累计使用 ${formatTokens(total)} Token` };',
    "  if (badge.textContent) badge.textContent = '';",
    '}',
    'function isMainWindow(win) { return Boolean(win); }',
    'async function publish(session, requests, ids, totals, reader) {',
    '  const snapshot = reader.read(requests.flatMap(r => r.ids));',
    '  await session.evaluate(`window.__codexThreadTokens?.update(${JSON.stringify({ ...snapshot, totals })})`);',
    '}',
    ''
  ].join('\n');
}
function installDir(agent = fixtureAgent()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-install-'));
  fs.writeFileSync(path.join(dir, 'agent.cjs'), agent);
  fs.writeFileSync(path.join(dir, 'bridge.cjs'), 'prep();\nwindow.__codexUsageBadge?.destroy?.();\n');
  fs.writeFileSync(path.join(dir, '.codex-usage-badge-owner'), OWNER + '\n');
  return dir;
}

test('the agent patch numbers the sidebar, publishes per-chat metadata, and skips an unknown descendant total', () => {
  const patched = patchAgent(fixtureAgent());
  assert.match(patched, /require\('\.\/per-chat-usage\.cjs'\)/);
  assert.equal(patched.includes('const VERSION = 7;'), false);
  assert.match(patched, /const VERSION = 8;/);
  assert.match(patched, /display: inline-flex/);
  assert.match(patched, /text: formatTokens\(total\)/);
  assert.match(patched, /badge\.dataset\.totalTokens/);
  assert.match(patched, /installThreadTokens,installPerChatUsage/);
  assert.match(patched, /readPerChatMetadata\(allIds\)/);
  assert.match(patched, /row\.tokens != null && row\.descendant_tokens != null/);
  assert.match(patched, /window\.__codexPerChatUsage\?\.updateMetadata/);
  assert.doesNotMatch(patched, /const VERSION = 7;/);
  const bridge = patchBridge('prep();\nwindow.__codexUsageBadge?.destroy?.();\n');
  assert.equal(bridge, 'prep();\nwindow.__codexPerChatUsage?.destroy?.(); window.__codexUsageBadge?.destroy?.();\n');
});

test('an unsupported or ambiguous badge is rejected before any replacement', () => {
  assert.throws(() => patchAgent('function installThreadTokens() {\nfunction isMainWindow() {}\n'), /not supported/);
  assert.throws(() => patchBridge('nothing to see'), /not supported/);
  const doubled = fixtureAgent().replace('const VERSION = 7;', 'const VERSION = 7;\n  const VERSION = 7;');
  assert.throws(() => patchAgent(doubled), /ambiguous/);
});

test('apply is idempotent, keeps an edited settings file, and uninstall restores the backups', () => {
  const dir = installDir();
  const originalAgent = fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8');
  apply(dir);
  const patched = fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8');
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs.before-per-chat.bak'), 'utf8'), originalAgent);
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-usage.cjs')), true);
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-metadata.cjs')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'per-chat-usage.config.json'), 'utf8')), DEFAULT_CONFIG);

  const custom = '{"monthlyPrice":12}\n';
  fs.writeFileSync(path.join(dir, 'per-chat-usage.config.json'), custom);
  apply(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8'), patched);
  assert.equal(fs.readFileSync(path.join(dir, 'per-chat-usage.config.json'), 'utf8'), custom);

  fs.rmSync(path.join(dir, 'agent.cjs.before-per-chat.bak'));
  assert.throws(() => apply(dir), /already patched/);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8'), patched);

  // Put the backup back so uninstall has the original to restore.
  fs.writeFileSync(path.join(dir, 'agent.cjs.before-per-chat.bak'), originalAgent);
  uninstall(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8'), originalAgent);
  assert.equal(fs.existsSync(path.join(dir, 'agent.cjs.before-per-chat.bak')), false);
  assert.equal(fs.existsSync(path.join(dir, 'bridge.cjs.before-per-chat.bak')), false);
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-usage.cjs')), false);
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-metadata.cjs')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'per-chat-usage.config.json'), 'utf8'), custom);
});

test('a failed apply leaves the installed files unchanged', () => {
  const dir = installDir('not the supported badge');
  assert.throws(() => apply(dir), /not supported/);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8'), 'not the supported badge');
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-usage.cjs')), false);
});

test('the command exits before relaunching when the install is missing, and --no-reload patches a real one', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-missing-'));
  const rejected = spawnSync(process.execPath, [script, '--dir', missing, '--no-reload'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /No Codex Usage Badge/);

  const dir = installDir();
  fs.writeFileSync(path.join(dir, '.codex-usage-badge-owner'), 'someone-else');
  const wrong = spawnSync(process.execPath, [script, '--dir', dir, '--no-reload'], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /No Codex Usage Badge/);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8').includes('installPerChatUsage'), false);

  fs.writeFileSync(path.join(dir, '.codex-usage-badge-owner'), OWNER);
  const applied = spawnSync(process.execPath, [script, '--dir', dir, '--no-reload'], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Patched/);
  assert.match(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8'), /installPerChatUsage/);
  const removed = spawnSync(process.execPath, [script, '--dir', dir, '--uninstall', '--no-reload'], { encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Restored/);
  assert.equal(fs.readFileSync(path.join(dir, 'agent.cjs'), 'utf8').includes('installPerChatUsage'), false);
  assert.equal(fs.existsSync(path.join(dir, 'per-chat-usage.config.json')), true);
});
