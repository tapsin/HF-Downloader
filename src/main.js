const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { spawn } = require('child_process');

function createWindow() {
  const win = new BrowserWindow({ width: 1100, height: 760, minWidth: 820, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
function tokenFile(){return path.join(app.getPath('userData'),'hf-token.bin')}
ipcMain.handle('get-token',async()=>{try{return safeStorage.isEncryptionAvailable()&&(await fsp.readFile(tokenFile())).length?'*** veri saklanıyor':null}catch{return null}});
ipcMain.handle('save-token',async(_,token)=>{if(!token||!safeStorage.isEncryptionAvailable())return false;await fsp.mkdir(path.dirname(tokenFile()),{recursive:true});await fsp.writeFile(tokenFile(),safeStorage.encryptString(token));return true});
async function storedToken(){try{return safeStorage.decryptString(await fsp.readFile(tokenFile()))}catch{return ''}}

const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
function normalizeRepo(type, value) {
  let repo = String(value || '').trim().replace(/\/$/, '');
  const marker = type === 'dataset' ? '/datasets/' : '/models/';
  if (repo.startsWith('https://huggingface.co' + marker) || repo.startsWith('http://huggingface.co' + marker)) repo = repo.split(marker)[1].split('/tree/')[0].split('/blob/')[0];
  return repo;
}
async function api(url, token) {
  const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('inspect-repo', async (_, { type, repo, token }) => {
  token = token && token !== '*** veri saklanıyor' ? token : await storedToken();
  if (type === 'bucket') return { id: repo, private: true, files: ['Bucket klasörü hazır; indirme sırasında listelenecek.'] };
  repo = normalizeRepo(type, repo);
  if (!repo || !repo.includes('/')) throw new Error('Repo ID şu formatta olmalı: kullanıcı/repo');
  const data = await api(`https://huggingface.co/api/${type}s/${repo}`, token);
  return { id: data.id || repo, private: !!data.private, files: (data.siblings || []).map(x => x.rfilename).filter(Boolean) };
});

ipcMain.handle('download-repo', async (event, { type, repo, token, target, files }) => {
  token = token && token !== '*** veri saklanıyor' ? token : await storedToken();
  if (!target) throw new Error('Hedef klasör seçilmedi.');
  if (type === 'bucket') {
    const parts = repo.replace(/^https?:\/\/huggingface\.co\/buckets\//, '').split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('Bucket adresi geçersiz.');
    const marker = parts.indexOf('tree');
    const prefix = marker >= 0 ? parts.slice(marker + 1).join('/') : parts.slice(2).join('/');
    const source = `hf://buckets/${parts[0]}/${parts[1]}${prefix ? '/' + prefix : ''}`;
    await new Promise((resolve, reject) => {
      const args = ['buckets', 'sync', source, target];
      if (token) args.push('--token', token);
      const child = spawn(process.platform === 'win32' ? 'hf.exe' : 'hf', args, { windowsHide: true });
      const report = d => event.sender.send('download-progress', { message: d.toString().trim(), current: 0, total: 0 });
      child.stdout.on('data', report); child.stderr.on('data', report);
      child.on('error', () => reject(new Error('hf CLI bulunamadı. Kurmak için: pip install -U huggingface_hub')));
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`hf buckets sync başarısız oldu (kod ${code}).`)));
    });
    event.sender.send('download-progress', { message: 'Bucket indirme tamamlandı.', current: 1, total: 1 });
    return target;
  }
  repo = normalizeRepo(type, repo);
  const sender = (message, current = 0, total = files.length) => event.sender.send('download-progress', { message, current, total });
  const root = path.join(target, safe(repo.split('/')[1] || repo));
  await fsp.mkdir(root, { recursive: true });
  let done = 0;
  for (const file of files) {
    const clean = file.split('/').filter(p => p !== '..' && p !== '.').join(path.sep);
    const out = path.join(root, clean);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    sender(`İndiriliyor: ${file}`, done, files.length);
    const url = `https://huggingface.co/${type === 'model' ? '' : type + 's/'}${repo}/resolve/main/${file}?download=true`;
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok || !response.body) throw new Error(`${file}: ${response.status} ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(out));
    done += 1; sender(`Tamamlandı: ${file}`, done, files.length);
  }
  sender('İndirme tamamlandı.', done, files.length);
  return root;
});
