'use strict';
// Adds per-chat usage to an installed Codex Usage Badge for Windows
// (https://github.com/jaykinhoo9/codex-usage-badge, tested with 0.10.1).
//
//   node apply.cjs              patch the install, turn its auto-update off, reload it
//   node apply.cjs --uninstall  restore the original files, turn auto-update back on
//   node apply.cjs --dir <path> --no-reload   another install folder; leave it running as is
//
// The badge's own agent.cjs and bridge.cjs are kept as *.before-per-chat.bak and
// every patch is built from those, so applying twice or after an update is safe.
// Backups are written only after both patches build, so a rejected layout
// leaves the install untouched.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OWNER = 'local.codexusagebadge.windows';
const MARK = 'installPerChatUsage';
const OURS = ['per-chat-usage.cjs', 'per-chat-metadata.cjs'];
const CONFIG = 'per-chat-usage.config.json';

function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  const preview = before.length > 60 ? before.slice(0, 60) + '…' : before;
  if (at < 0) throw new Error(`Not the tested Codex Usage Badge 0.10.1 layout (missing: ${preview}). No files were changed.`);
  if (at !== text.lastIndexOf(before)) throw new Error(`Not the tested Codex Usage Badge 0.10.1 layout (anchor appears more than once: ${preview}). No files were changed.`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

function patchAgent(code) {
  code = `const {installPerChatUsage,readMetadata:readPerChatMetadata,readConfig:readPerChatConfig}=require('./per-chat-usage.cjs');\n` + code;
  const begin = code.indexOf('function installThreadTokens() {');
  const end = code.indexOf('\nfunction isMainWindow(', begin);
  if (begin < 0 || end < 0) throw new Error('Not the tested Codex Usage Badge 0.10.1 layout (thread token component missing). No files were changed.');
  // The sidebar dot becomes a number: the chat's total tokens, subagents included.
  let component = code.slice(begin, end);
  component = replaceOnce(component, 'const VERSION = 7;', 'const VERSION = 8;');
  component = replaceOnce(component,
    'position: relative; display: inline-block; align-self: center; flex: 0 0 12px; width: 12px; height: 12px;',
    'position: relative; display: inline-flex; align-items: center; justify-content: center; align-self: center; flex: 0 0 auto; width: auto; min-width: 36px; height: 18px; padding: 0 4px; font: 10px/18px -apple-system, BlinkMacSystemFont, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--color-text-primary, inherit);');
  component = replaceOnce(component,
    'return { level: level(total), state: \'ready\', detail: `累计使用 ${formatTokens(total)} Token` };',
    'return { level: level(total), state: \'ready\', text: formatTokens(total), total, detail: `累计使用 ${formatTokens(total)} Token（含子智能体）` };');
  component = replaceOnce(component, "if (badge.textContent) badge.textContent = '';",
    "const text = value.text ?? '—';\n    if (badge.textContent !== text) badge.textContent = text;\n    const raw = value.total == null ? '' : String(value.total);\n    if (badge.dataset.totalTokens !== raw) badge.dataset.totalTokens = raw;");
  code = code.slice(0, begin) + component + code.slice(end);
  code = replaceOnce(code, '[installUsageBadge,installProjectColors,installProjectSizes,installThreadTokens]',
    '[installUsageBadge,installProjectColors,installProjectSizes,installThreadTokens,installPerChatUsage]');
  code = replaceOnce(code, 'const snapshot = reader.read(requests.flatMap(r => r.ids));',
    `const allIds = requests.flatMap(r => r.ids);
  const snapshot = reader.read(allIds);
  let perChatMetadata = [];
  try { perChatMetadata = readPerChatMetadata(allIds); } catch {}
  for (const row of perChatMetadata) if (row.tokens != null) snapshot.totals[row.thread_id] = row.tokens + row.descendant_tokens;`);
  code = replaceOnce(code,
    'await session.evaluate(`window.__codexThreadTokens?.update(${JSON.stringify({ ...snapshot, totals })})`);',
    'await session.evaluate(`window.__codexThreadTokens?.update(${JSON.stringify({ ...snapshot, totals })});window.__codexPerChatUsage?.updateMetadata(${JSON.stringify(perChatMetadata.filter(row => ids.includes(row.thread_id)))},${JSON.stringify(readPerChatConfig())})`);');
  return code;
}

function patchBridge(code) {
  return replaceOnce(code, 'window.__codexUsageBadge?.destroy?.();', 'window.__codexPerChatUsage?.destroy?.(); window.__codexUsageBadge?.destroy?.();');
}

function manage(dir, action) {
  const script = path.join(dir, 'manage-windows.ps1');
  if (!fs.existsSync(script)) throw new Error(`Missing ${script}. Reinstall Codex Usage Badge if that script is gone.`);
  const ran = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action], { stdio: 'inherit' });
  if (ran.error) throw new Error(`Could not start PowerShell (${ran.error.code || ran.error.message}) to run manage-windows.ps1 -Action ${action}.`);
  if (ran.status !== 0) throw new Error(`manage-windows.ps1 -Action ${action} failed (exit ${ran.status}).`);
}

// Unpatched source of `file`: the backup once one exists, otherwise the live file.
// apply() writes the backup only after both patches have been built.
function original(dir, file) {
  const target = path.join(dir, file), backup = target + '.before-per-chat.bak';
  if (fs.existsSync(backup)) return fs.readFileSync(backup, 'utf8');
  if (!fs.existsSync(target)) throw new Error(`Missing ${target}. Reinstall Codex Usage Badge 0.10.1, then apply again.`);
  const current = fs.readFileSync(target, 'utf8');
  if (current.includes(MARK) || current.includes('__codexPerChatUsage')) {
    throw new Error(`${file} is already patched but ${path.basename(backup)} is missing. Reinstall Codex Usage Badge, then apply again.`);
  }
  return current;
}

function apply(dir) {
  const agent = patchAgent(original(dir, 'agent.cjs'));
  const bridge = patchBridge(original(dir, 'bridge.cjs'));
  for (const file of ['agent.cjs', 'bridge.cjs']) {
    const target = path.join(dir, file), backup = target + '.before-per-chat.bak';
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  }
  for (const file of OURS) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
  fs.writeFileSync(path.join(dir, 'agent.cjs'), agent);
  fs.writeFileSync(path.join(dir, 'bridge.cjs'), bridge);
  const config = path.join(dir, CONFIG);
  if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify(require('./per-chat-metadata.cjs').DEFAULT_CONFIG, null, 2) + '\n');
  console.log(`Patched ${dir}. Settings: ${config}`);
}

function uninstall(dir) {
  for (const file of ['agent.cjs', 'bridge.cjs']) {
    const target = path.join(dir, file), backup = target + '.before-per-chat.bak';
    if (fs.existsSync(backup)) { fs.copyFileSync(backup, target); fs.rmSync(backup); }
  }
  for (const file of OURS) fs.rmSync(path.join(dir, file), { force: true });
  console.log(`Restored ${dir} (settings file ${CONFIG} kept).`);
}

function main(argv) {
  const at = argv.indexOf('--dir');
  if (at >= 0 && (at + 1 >= argv.length || argv[at + 1].startsWith('--'))) {
    throw new Error('Pass a folder after --dir, for example --dir "%LOCALAPPDATA%\\CodexUsageBadge".');
  }
  if (at < 0 && !process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is not set. Pass --dir with the Codex Usage Badge install folder.');
  }
  const dir = path.resolve(at >= 0 ? argv[at + 1] : path.join(process.env.LOCALAPPDATA, 'CodexUsageBadge'));
  const owner = path.join(dir, '.codex-usage-badge-owner');
  if (!fs.existsSync(owner) || fs.readFileSync(owner, 'utf8').trim() !== OWNER) {
    throw new Error(`No Codex Usage Badge install at ${dir} (expected .codex-usage-badge-owner to contain ${OWNER}). Install it first: https://github.com/jaykinhoo9/codex-usage-badge`);
  }
  const reload = !argv.includes('--no-reload');
  if (reload && process.platform !== 'win32') {
    throw new Error('Reloading Codex Usage Badge needs Windows PowerShell. Re-run with --no-reload to patch files without reloading.');
  }
  if (argv.includes('--uninstall')) {
    uninstall(dir);
    if (reload) { manage(dir, 'UpdatesOn'); manage(dir, 'Launch'); }
    return;
  }
  apply(dir);
  // The badge's own updater would replace the patched files.
  if (reload) { manage(dir, 'UpdatesOff'); manage(dir, 'Launch'); }
}

module.exports = { patchAgent, patchBridge, apply, uninstall };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
