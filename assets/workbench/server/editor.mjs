import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAt, TraceError } from './traceability.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fileExists(file) {
  try { return (await fs.stat(file)).isFile(); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

// On Windows code.cmd is a batch script; use Code.exe directly without a shell.
async function editorExecutable(editor, platform, env) {
  if (editor === 'notepad') {
    if (platform !== 'win32') throw new TraceError('记事本仅支持 Windows，请选择 VS Code。');
    const file = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe');
    if (!(await fileExists(file))) throw new TraceError('未找到 Windows 记事本，请选择 VS Code。', 503);
    return file;
  }
  const candidates = [];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (base) candidates.push(path.join(base, 'Microsoft VS Code', 'Code.exe'));
    for (const dir of (env.Path || env.PATH || '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, 'Code.exe'));
      if (path.basename(dir).toLowerCase() === 'bin') candidates.push(path.join(path.dirname(dir), 'Code.exe'));
    }
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, 'code'));
    if (platform === 'darwin') candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  }
  for (const file of candidates) if (await fileExists(file)) return file;
  throw new TraceError('未找到 VS Code。请安装 VS Code，或在设置中选择记事本。', 503);
}

function launchEditor(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openSource(body, { root = projectRoot, platform = process.platform, env = process.env, launch = launchEditor } = {}) {
  if (!body || !['vscode', 'notepad'].includes(body.editor)) throw new TraceError('请选择支持的编辑器。');
  await sourceAt(body.path, body.line, root);
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(path.resolve(root, body.path));
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new TraceError('源码位置不在项目目录内。', 403);
  const executable = await editorExecutable(body.editor, platform, env);
  const args = body.editor === 'vscode' ? ['--goto', `${realFile}:${body.line}`] : [realFile];
  try { await launch(executable, args); }
  catch (error) { throw new TraceError(`无法启动${body.editor === 'vscode' ? ' VS Code' : '记事本'}：${error.message}`, 503); }
  return { opened: true, editor: body.editor, lineJumped: body.editor === 'vscode', message: body.editor === 'vscode' ? `已请求 VS Code 打开第 ${body.line} 行。` : `已打开文件；请在记事本按 Ctrl+G 跳转到第 ${body.line} 行。` };
}
