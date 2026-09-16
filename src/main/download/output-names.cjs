/* One basename contract for the downloader and both filesystem adapters. */
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
function basename(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,150}$/.test(value) || value === '.' || value === '..' || /\.$/.test(value) || reserved.test(value)) throw new Error('unsafe-basename');
  return value;
}
function safeFilename(value = 'track.mp4') {
  const result = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100).replace(/\.+$/, '');
  return !result || reserved.test(result) || /\.(part|json)$/i.test(result) ? 'track.mp4' : basename(result);
}
module.exports = { basename, safeFilename };
