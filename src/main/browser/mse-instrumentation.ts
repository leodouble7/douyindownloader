/** Runs only in the isolated target's JS realm. The one-way binding carries metadata,
 * never buffers. Instrumentation is best-effort and is not a trusted security oracle. */
export const MSE_INSTRUMENTATION = String.raw`(() => {
  const marker = Symbol.for('media-security-lab.mse');
  if (globalThis[marker]) return;
  Object.defineProperty(globalThis, marker, { value: true });
  const emitBinding = globalThis.__mslEmit;
  const ids = new WeakMap();
  const parents = new WeakMap();
  let nextId = 0;
  const id = (object) => {
    if (!ids.has(object)) ids.set(object, 'mse-' + (++nextId));
    return ids.get(object);
  };
  const emit = (value) => {
    try { emitBinding(JSON.stringify({ ...value, timestamp: performance.now() })); } catch {}
  };
  const wrap = (owner, name, after) => {
    if (!owner) return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const original = descriptor.value;
    try {
      Object.defineProperty(owner, name, { ...descriptor, value: function(...args) {
        const result = Reflect.apply(original, this, args);
        try { after(this, args, result); } catch {}
        return result;
      } });
    } catch {}
  };
  wrap(globalThis.URL, 'createObjectURL', (_owner, args, result) => {
    if (args[0] && typeof args[0] === 'object') emit({ type: 'object-url', objectId: id(args[0]), objectUrl: result });
  });
  wrap(globalThis.MediaSource?.prototype, 'addSourceBuffer', (source, args, buffer) => {
    parents.set(buffer, id(source));
    emit({ type: 'source-buffer', objectId: id(source), sourceBufferId: id(buffer), mimeType: String(args[0]) });
  });
  wrap(globalThis.SourceBuffer?.prototype, 'appendBuffer', (buffer, args) => {
    const buffered = [];
    try { for (let i = 0; i < Math.min(buffer.buffered.length, 64); i++) buffered.push([buffer.buffered.start(i), buffer.buffered.end(i)]); } catch {}
    emit({ type: 'append', objectId: parents.get(buffer) || id(buffer), sourceBufferId: id(buffer), byteLength: args[0].byteLength, buffered });
  });
})();`;
