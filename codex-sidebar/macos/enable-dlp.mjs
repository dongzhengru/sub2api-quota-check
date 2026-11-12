import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { adaptDlpLauncher } from '../lib/dlp.mjs';

const home = homedir();
const bin = path.join(home, '.codex/safedisk-dev/dev/bin');
const backup = path.join(home, '.codex/share/codexNoProject/codex-quota-dlp', new Date().toISOString().replace(/[:.]/g, '-'));
const edits = [];
for (const name of ['gpt-safe', 'gpt-safe-detached']) {
  const file = path.join(bin, name);
  try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const original = await readFile(file, 'utf8');
  const updated = adaptDlpLauncher(original);
  if (updated !== original) edits.push({ name, file, updated });
}
if (edits.length) {
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const edit of edits) await copyFile(edit.file, path.join(backup, edit.name));
  for (const edit of edits) await writeFile(edit.file, edit.updated);
  console.log(`已适配 ${edits.length} 个 DLP 启动器。原文件备份：${backup}`);
  console.log('旧 GPT 尚未开启 9342 时需重开；已开启时，在原 DLP 终端运行 gpt-safe 即可连接额度助手。');
} else console.log('DLP 启动器无需修改，或当前机器未安装 gpt-safe。');
