/* Electron utility process adapter: the filesystem actor keeps the same private protocol. */
const port = process.parentPort;
process.send = message => port.postMessage(message);
port.on('message', event => process.emit('message', event.data));
require('./output-worker.cjs');
