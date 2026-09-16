/* Bundled filesystem actor. Mutations use relative basenames: verified OS cwd on POSIX, native directory handles on Windows. */
let fs = require('node:fs/promises');
let windows;
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
let directory, root, file, sequence = 0, slot = -1, cancelled = false;
const { basename } = require('./output-names.cjs');
const identity = info => ({ dev: String(info.dev), ino: String(info.ino), size: info.size, nlink: info.nlink, isFile: info.isFile() });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function statEntry(name) {
  try { return identity(await fs.lstat(basename(name))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertEntry(name, expected) {
  const info = await statEntry(name);
  if (!info || !info.isFile || !same(info, expected) || info.nlink < 1 || info.nlink > 2) throw new Error('unsafe-file-identity');
  return info;
}
async function syncDirectory() {
  try { await directory.sync(); } catch { throw new Error('directory-durability-unsupported'); }
}
async function readManifest() {
  const records = [];
  for (let index = 0; index < 2; index++) {
    let handle;
    try {
      handle = await fs.open(`resume.${index}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error('invalid-manifest');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || typeof record.payload !== 'string' || createHash('sha256').update(record.payload).digest('hex') !== record.sha256) continue;
      records.push({ ...record, index });
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    finally { await handle?.close(); }
  }
  records.sort((a, b) => b.sequence - a.sequence);
  if (!records.length) return null;
  sequence = records[0].sequence; slot = records[0].index;
  return JSON.parse(records[0].payload);
}
async function saveManifest(payload) {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 60000) throw new Error('manifest-too-large');
  const next = sequence + 1, target = next % 2;
  const temporary = `resume-${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify({ sequence: next, payload: encoded, sha256: createHash('sha256').update(encoded).digest('hex') })); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, `resume.${target}.json`);
  await syncDirectory(); sequence = next; slot = target;
}
async function execute(op, args) {
  switch (op) {
    case 'init': {
      if (process.platform === 'win32') {
        windows = await require('./windows-output.cjs').createWindowsStorage(process.cwd(), args.root, args.id, args.resume);
        fs = windows.fs; root = windows.root; directory = windows.directory;
        await syncDirectory(); return identity(await directory.stat());
      }
      if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error('anchored-workspace-unsupported');
      root = await fs.open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = identity(await root.stat());
      if (!same(info, args.root)) throw new Error('output-root-substituted');
      try { await root.sync(); } catch { throw new Error('directory-durability-unsupported'); }
      const name = basename(`.download-${args.id}`);
      if (!args.resume) { await fs.mkdir(name, { mode: 0o700 }); await root.sync(); }
      directory = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const expected = identity(await directory.stat());
      process.chdir(name);
      const current = identity(await fs.stat('.'));
      if (!same(expected, current)) throw new Error('output-directory-substituted');
      await syncDirectory();
      return current;
    }
    case 'openFile': {
      if (file) throw new Error('file-already-open');
      const name = basename(args.name);
      file = await fs.open(name, constants.O_RDWR | constants.O_NOFOLLOW | (args.create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
      const info = identity(await file.stat());
      if (!info.isFile || info.nlink < 1 || info.nlink > 2) throw new Error('unsafe-file-identity');
      if (args.create) await syncDirectory();
      return info;
    }
    case 'write': {
      const data = Buffer.from(args.data);
      if (data.length > 65536 || !Number.isSafeInteger(args.position) || args.position < 0) throw new Error('invalid-write');
      for (let offset = 0; offset < data.length;) {
        const result = await file.write(data, offset, data.length - offset, args.position + offset);
        if (!result.bytesWritten) throw new Error('write-failed'); offset += result.bytesWritten;
      }
      return null;
    }
    case 'read': {
      if (!Number.isSafeInteger(args.length) || args.length < 0 || args.length > 65536 || !Number.isSafeInteger(args.position) || args.position < 0) throw new Error('invalid-read');
      const data = Buffer.alloc(args.length); const result = await file.read(data, 0, data.length, args.position);
      return data.subarray(0, result.bytesRead);
    }
    case 'stat': return identity(await file.stat());
    case 'statEntry': return statEntry(args.name);
    case 'truncate': await file.truncate(args.length); return null;
    case 'sync': await file.sync(); return null;
    case 'closeFile': if (file) { await file.close(); file = undefined; } return null;
    case 'durability': return windows?.durability ?? 'directory-flush';
    case 'freeBytes': { const free = await fs.statfs('.', { bigint: true }); return String(free.bavail * free.bsize); }
    case 'readManifest': return readManifest();
    case 'saveManifest': await saveManifest(args.payload); return null;
    case 'publish': {
      if (cancelled) throw new Error('cancelled');
      const name = basename(args.name);
      await assertEntry('track.part', args.identity);
      if (cancelled) throw new Error('cancelled');
      // No await separates this final cancellation check from the atomic filesystem call.
      if (windows) await fs.link('track.part', name, args.identity, () => process.send({ committed: true }));
      else { await fs.link('track.part', name); process.send({ committed: true }); }
      if (windows) await fs.flushEntry(name, args.identity);
      await syncDirectory();
      await assertEntry(name, args.identity);
      return null;
    }
    case 'removePart': {
      if (await statEntry('track.part')) { await assertEntry('track.part', args.identity); await fs.unlink('track.part', ...(windows ? [args.identity] : [])); await syncDirectory(); }
      return null;
    }
    case 'cleanupManifest': {
      if (slot < 0) throw new Error('missing-manifest');
      await fs.unlink(`resume.${1 - slot}.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await syncDirectory(); return null;
    }
    case 'path': if (windows) return windows.current(); process.chdir('.'); return process.cwd();
    case 'dispose': await file?.close(); file = undefined; await directory?.close(); await root?.close(); return null;
    default: throw new Error('unknown-workspace-operation');
  }
}
let queue = Promise.resolve();
process.on('message', message => {
  if (message.cancel) { cancelled = true; return; }
  queue = queue.then(async () => {
    try { const value = await execute(message.op, message.args ?? {}); process.send({ id: message.id, value }); }
    catch (error) { process.send({ id: message.id, error: /^[a-z-]+$/.test(error.message) ? error.message : 'filesystem-operation-failed', code: error.code }); }
  });
});
process.on('disconnect', () => { process.exit(0); });
