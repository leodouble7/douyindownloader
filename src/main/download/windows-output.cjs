/* Windows uses N-API-owned HANDLEs; paths are display/initial-selection input only. */
const { constants } = require('node:fs');
const path = require('node:path');
function loadNative() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('unsupported-native-platform');
  // Build copies the addon adjacent to this actor, outside asar. Development uses the same binary.
  const adjacent = path.join(__dirname, 'windows-output.node');
  if (require('node:fs').existsSync(adjacent)) return require(adjacent);
  if (__dirname.endsWith(path.join('src', 'main', 'download'))) return require(path.join(__dirname, '../../../native/windows-output/build/Release/windows_output.node'));
  throw new Error('native-addon-unavailable');
}
const { basename } = require('./output-names.cjs');
function checked(api, handle) {
  const info = api.stat(handle);
  if (info.reparse) throw new Error('unsafe-reparse-point');
  return info;
}
function compatible(api, handle) {
  checked(api, handle);
  const caps = api.capabilities(handle);
  if (!caps.hardLinks || !caps.stableIds || caps.filesystem !== 'NTFS' || !['directory-flush', 'write-through-file-flush'].includes(caps.durability)) throw new Error('unsupported-filesystem');
  return caps;
}
function wrap(api, handle, directory = false) {
  return {
    async stat() { const info = checked(api, handle); return { ...info, isFile: () => info.isFile, isDirectory: () => !info.isFile }; },
    async read(buffer, offset, length, position) { const bytes = api.read(handle, position, length); bytes.copy(buffer, offset); return { bytesRead: bytes.length }; },
    async write(buffer, offset, length, position) { return { bytesWritten: api.write(handle, position, buffer.subarray(offset, offset + length)) }; },
    async readFile(encoding) { const size = checked(api, handle).size; if (size > 65536) throw new Error('invalid-manifest'); return api.read(handle, 0, size).toString(encoding); },
    async writeFile(value) { const bytes = Buffer.from(value); if (bytes.length > 65536) throw new Error('manifest-too-large'); let offset = 0; while (offset < bytes.length) { const wrote = api.write(handle, offset, bytes.subarray(offset)); if (!wrote) throw new Error('write-failed'); offset += wrote; } },
    async truncate(length) { api.truncate(handle, length); },
    async sync() { return api.flush(handle, directory); },
    async close() { api.close(handle); }
  };
}
function openWindowsRoot(selected, api = loadNative()) {
  const handle = api.openRoot(selected);
  try { compatible(api, handle); const info = checked(api, handle); return { path: api.path(handle), dev: info.dev, ino: info.ino, close: () => api.close(handle) }; }
  catch (error) { api.close(handle); throw error; }
}
async function createWindowsStorage(selected, expected, id, resume, api = loadNative()) {
  const rootHandle = api.openRoot(selected);
  let directoryHandle;
  try {
    const caps = compatible(api, rootHandle), info = checked(api, rootHandle);
    if (info.dev !== expected.dev || info.ino !== expected.ino) throw new Error('output-root-substituted');
    directoryHandle = api.open(rootHandle, basename(`.download-${id}`), 'directory', !resume);
    checked(api, directoryHandle); api.flush(rootHandle, true);
    const open = (name, flags = 0) => {
      const handle = api.open(directoryHandle, basename(name), 'file', !!(flags & constants.O_CREAT));
      try { checked(api, handle); return handle; } catch (error) { api.close(handle); throw error; }
    };
    const withEntry = (name, expectedIdentity, operation) => {
      const handle = open(name);
      try { const info = checked(api, handle); if (expectedIdentity && (info.dev !== expectedIdentity.dev || info.ino !== expectedIdentity.ino)) throw new Error('unsafe-file-identity'); return operation(handle); }
      finally { api.close(handle); }
    };
    return {
      root: wrap(api, rootHandle, true), directory: wrap(api, directoryHandle, true), durability: caps.durability,
      current: () => api.path(directoryHandle),
      fs: {
        async open(name, flags) { return wrap(api, open(name, flags)); },
        async lstat(name) { return withEntry(name, null, handle => { const value = checked(api, handle); return { ...value, isFile: () => value.isFile }; }); },
        async rename(from, to) { return withEntry(from, null, handle => api.rename(handle, directoryHandle, basename(to))); },
        async link(from, to, expectedIdentity, committed = () => undefined) { return withEntry(from, expectedIdentity, handle => { api.link(handle, directoryHandle, basename(to)); committed(); }); },
        async flushEntry(name, expectedIdentity) { return withEntry(name, expectedIdentity, handle => api.flush(handle, false)); },
        async unlink(name, expectedIdentity) { return withEntry(name, expectedIdentity, handle => api.remove(handle)); },
        async statfs() { return { bavail: BigInt(api.freeBytes(directoryHandle)), bsize: 1n }; }
      }
    };
  } catch (error) { if (directoryHandle) api.close(directoryHandle); api.close(rootHandle); throw error; }
}
module.exports = { createWindowsStorage, openWindowsRoot };
