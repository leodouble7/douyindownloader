import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { createMediaFixtures, fixtureName, readFixture, type MediaFixtures } from './media';
import {
  expectedProtection,
  hasValidSignature,
  isLabScenario,
  LAB_SECRET,
  LAB_SESSION_ID,
  RANGE_CAP_BYTES,
  SEGMENT_WINDOW_END,
  segmentIndex,
  type LabScenario
} from './scenarios';
import { signMediaRequest } from '../src/main/security/signature';

export interface LabServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface StartLabServerOptions {
  signal?: AbortSignal;
}

interface RangeSelection {
  start: number;
  end: number;
}

interface MultipleRangeSelection {
  kind: 'multiple';
  selected: RangeSelection;
}

const ENCRYPTED_PLACEHOLDER = Buffer.from('local-lab-encrypted-placeholder-v1');

/**
 * Starts one isolated, loopback-only lab instance. Every instance owns its temporary
 * fixture directory and can therefore run alongside other tests without shared state.
 */
export async function startLabServer(options: StartLabServerOptions = {}): Promise<LabServer> {
  throwIfAborted(options.signal);
  const fixtures = await createMediaFixtures(options.signal);
  try {
    throwIfAborted(options.signal);
    const staleValidator = { requests: 0 };
    const server = createServer((request, response) => {
      void handleRequest(request, response, fixtures, staleValidator).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        response.end('Local lab request failed');
      });
    });
    await listen(server, options.signal);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let closed: Promise<void> | undefined;
    return {
      baseUrl,
      close: () => {
        closed ??= closeServer(server, fixtures);
        return closed;
      }
    };
  } catch (error) {
    await fixtures.cleanup();
    throw error;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  fixtures: MediaFixtures,
  staleValidator: { requests: number }
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Only GET and HEAD are supported');
    return;
  }

  if (path === '/watch') {
    const scenario = isLabScenario(url.searchParams.get('scenario')) ? url.searchParams.get('scenario') : 'open-range';
    sendWatchPage(request, response, scenario as LabScenario);
    return;
  }

  if (path === '/stale-validator/video.mp4') {
    staleValidator.requests += 1;
    await sendMedia(request, response, fixtures.video, {
      etag: staleValidator.requests === 1 ? '"lab-v1"' : '"lab-v2"',
      lastModified: staleValidator.requests === 1
        ? 'Thu, 01 Jan 1970 00:00:00 GMT'
        : 'Fri, 02 Jan 1970 00:00:00 GMT'
    });
    return;
  }

  const match = path.match(/^\/([a-z-]+)\/(.+)$/);
  if (!match || !isLabScenario(match[1])) {
    sendText(response, 404, 'Unknown local lab resource');
    return;
  }

  const scenario = match[1];
  const resource = match[2];
  if (resource === 'watch') {
    sendWatchPage(request, response, scenario);
    return;
  }

  if (scenario === 'open-range' && sendCaptureSupport(request, response, resource)) {
    return;
  }

  if (scenario === 'open-range' && await sendDashResource(request, response, resource, fixtures)) {
    return;
  }

  if (scenario === 'encrypted-placeholder') {
    await sendEncryptedPlaceholder(request, response, resource, fixtures);
    return;
  }

  if (scenario === 'segment-token') {
    await sendSegmentResource(request, response, url, resource, fixtures);
    return;
  }

  const mediaPath = mediaPathFor(resource, fixtures);
  if (mediaPath === undefined) {
    sendText(response, 404, 'Unknown local lab media');
    return;
  }

  if (!allowsScenarioRequest(scenario, request, url, resource)) {
    sendText(response, 403, 'Local lab access control rejected the request');
    return;
  }

  await sendMedia(request, response, mediaPath, {
    rangeCap: scenario === 'range-capped' ? RANGE_CAP_BYTES : undefined
  });
}

function allowsScenarioRequest(scenario: Exclude<LabScenario, 'segment-token' | 'encrypted-placeholder'>, request: IncomingMessage, url: URL, mediaId: string): boolean {
  switch (scenario) {
    case 'open-range':
    case 'range-capped':
      return true;
    case 'referer-only': {
      const referer = request.headers.referer;
      return referer === `${originFor(request)}/referer-only/watch`;
    }
    case 'signed-url':
      return hasValidSignature({ mediaId, expires: url.searchParams.get('expires') ?? '' }, url.searchParams.get('sig'))
        && isFutureExpiry(url.searchParams.get('expires'));
    case 'session-bound': {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      return sessionId === LAB_SESSION_ID
        && readCookie(request.headers.cookie, 'lab_session') === LAB_SESSION_ID
        && isFutureExpiry(url.searchParams.get('expires'))
        && hasValidSignature({ mediaId, expires: url.searchParams.get('expires') ?? '', sessionId }, url.searchParams.get('sig'));
    }
  }
}

async function sendSegmentResource(request: IncomingMessage, response: ServerResponse, url: URL, resource: string, fixtures: MediaFixtures): Promise<void> {
  if (resource === 'manifest.m3u8') {
    const manifest = await readFixture(fixtures.hlsManifest);
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const signedManifest = manifest.toString('utf8').replace(/segment-(\d+)\.ts/g, (fileName, numberText: string) => {
      const segmentId = String(Number(numberText));
      const signature = signMediaRequest({ mediaId: fileName, expires, segmentId }, LAB_SECRET);
      return `${fileName}?expires=${expires}&segmentId=${segmentId}&sig=${signature}`;
    });
    sendBuffer(request, response, Buffer.from(signedManifest), 'application/vnd.apple.mpegurl');
    return;
  }

  const match = resource.match(/^segment-(\d{3})\.ts$/);
  if (!match) {
    sendText(response, 404, 'Unknown local lab segment');
    return;
  }
  const numericId = String(Number(match[1]));
  const index = segmentIndex(numericId);
  const segmentPath = fixtures.hlsSegments.find((path) => fixtureName(path) === resource);
  const valid = index !== undefined
    && index <= SEGMENT_WINDOW_END
    && segmentPath !== undefined
    && isFutureExpiry(url.searchParams.get('expires'))
    && hasValidSignature({ mediaId: resource, expires: url.searchParams.get('expires') ?? '', segmentId: numericId }, url.searchParams.get('sig'));
  if (!valid) {
    sendText(response, 403, 'Local lab segment token rejected the request');
    return;
  }
  await sendMedia(request, response, segmentPath);
}

async function sendEncryptedPlaceholder(request: IncomingMessage, response: ServerResponse, resource: string, fixtures: MediaFixtures): Promise<void> {
  if (resource === 'manifest.mpd') {
    const dash = await readFixture(fixtures.dashManifest);
    const placeholderManifest = dash.toString('utf8').replace(
      '<Period',
      '<ContentProtection schemeIdUri="urn:uuid:local-lab-placeholder" value="classification-only"/>\n  <Period'
    );
    sendBuffer(request, response, Buffer.from(placeholderManifest), 'application/dash+xml');
    return;
  }
  if (resource === 'segment-000.m4s') {
    sendBuffer(request, response, ENCRYPTED_PLACEHOLDER, 'application/octet-stream', {
      'X-Lab-Encrypted-Placeholder': 'true',
      'Cache-Control': 'no-store'
    });
    return;
  }
  sendText(response, 404, 'Encrypted placeholder exposes no keys or additional resources');
}

function sendWatchPage(request: IncomingMessage, response: ServerResponse, scenario: LabScenario): void {
  const origin = originFor(request);
  const page = watchPage(scenario, origin);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(scenario === 'session-bound' ? { 'Set-Cookie': `lab_session=${LAB_SESSION_ID}; Path=/session-bound; SameSite=Strict` } : {})
  });
  response.end(page);
}

function watchPage(scenario: LabScenario, origin: string): string {
  const expires = String(Math.floor(Date.now() / 1000) + 60);
  const direct = (path: string) => `<video controls preload="metadata" src="${path}"></video>`;
  let player: string;
  switch (scenario) {
    case 'open-range':
      player = `${direct('/open-range/video.mp4')}<iframe hidden src="/open-range/frame" title="Local lab frame"></iframe><script>
const labWorker = new Worker('/open-range/worker.js');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/open-range/service-worker.js');
</script>${dashPlayerPipeline()}`;
      break;
    case 'referer-only':
      player = `<video id="mse-player" controls></video><script>
const player = document.querySelector('#mse-player');
const source = new MediaSource();
player.src = URL.createObjectURL(source);
Promise.all([fetch('/referer-only/video-only.mp4'), fetch('/referer-only/audio-only.mp4')]).then(async ([video, audio]) => {
  const videoBytes = await video.arrayBuffer(); const audioBytes = await audio.arrayBuffer();
  source.addEventListener('sourceopen', () => {
    const videoBuffer = source.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
    const audioBuffer = source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    videoBuffer.appendBuffer(videoBytes); audioBuffer.appendBuffer(audioBytes);
  }, { once: true });
});
</script>`;
      break;
    case 'signed-url': {
      const sig = signMediaRequest({ mediaId: 'video.mp4', expires }, LAB_SECRET);
      player = direct(`/signed-url/video.mp4?expires=${expires}&sig=${sig}`);
      break;
    }
    case 'session-bound': {
      const sig = signMediaRequest({ mediaId: 'video.mp4', expires, sessionId: LAB_SESSION_ID }, LAB_SECRET);
      player = `<script>document.cookie = 'lab_session=${LAB_SESSION_ID}; Path=/session-bound; SameSite=Strict';</script>${direct(`/session-bound/video.mp4?expires=${expires}&sessionId=${LAB_SESSION_ID}&sig=${sig}`)}`;
      break;
    }
    case 'range-capped':
      player = direct('/range-capped/video.mp4');
      break;
    case 'segment-token':
      player = hlsPlayerPipeline();
      break;
    case 'encrypted-placeholder':
      player = `<video controls></video><script>
fetch('/encrypted-placeholder/manifest.mpd').then(() => fetch('/encrypted-placeholder/segment-000.m4s'));
</script>`;
      break;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Local Media Security Lab</title></head>
<body><main data-scenario="${scenario}"><h1>Local Media Security Lab: ${scenario}</h1>
<p>Expected protection: ${expectedProtection(scenario)}</p><p>Loopback target: ${origin}</p>${player}</main></body></html>`;
}

function hlsPlayerPipeline(): string {
  return `<section aria-label="HLS player"><video id="hls-player" controls></video><p id="hls-status" role="status">Preparing bounded HLS pipeline.</p></section><script>
const hlsVideo = document.querySelector('#hls-player');
const hlsStatus = document.querySelector('#hls-status');
function appendChunk(sourceBuffer, chunk) {
  return new Promise((resolve, reject) => {
    sourceBuffer.addEventListener('updateend', resolve, { once: true });
    sourceBuffer.addEventListener('error', reject, { once: true });
    sourceBuffer.appendBuffer(chunk);
  });
}
async function resolveHlsResources(manifestUrl) {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error('HLS manifest request failed');
  const manifest = await response.text();
  return manifest.split('\\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).slice(0, 2)
    .map((line) => new URL(line, new URL(manifestUrl, location.href)).toString());
}
async function appendSegmentPipeline(video, resources, mimeType, status, label) {
  const chunks = await Promise.all(resources.map(async (resource) => {
    const response = await fetch(resource);
    if (!response.ok) throw new Error(label + ' media request failed');
    return response.arrayBuffer();
  }));
  if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mimeType)) {
    status.textContent = label + ' media was requested; MSE cannot append this codec/container here.';
    return;
  }
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  source.addEventListener('sourceopen', async () => {
    try {
      const buffer = source.addSourceBuffer(mimeType);
      for (const chunk of chunks) await appendChunk(buffer, chunk);
      source.endOfStream();
      status.textContent = label + ' media appended through MSE.';
    } catch (error) {
      status.textContent = label + ' media was requested; MSE append was unavailable.';
    }
  }, { once: true });
}
resolveHlsResources('/segment-token/manifest.m3u8')
  .then((resources) => appendSegmentPipeline(hlsVideo, resources, 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"', hlsStatus, 'HLS'))
  .catch(() => { hlsStatus.textContent = 'HLS pipeline request failed.'; });
</script>`;
}

function dashPlayerPipeline(): string {
  return `<section aria-label="DASH player"><video id="dash-player" controls></video><p id="dash-status" role="status">Preparing bounded DASH pipeline.</p></section><script>
const dashVideo = document.querySelector('#dash-player');
const dashStatus = document.querySelector('#dash-status');
function appendDashChunk(sourceBuffer, chunk) {
  return new Promise((resolve, reject) => {
    sourceBuffer.addEventListener('updateend', resolve, { once: true });
    sourceBuffer.addEventListener('error', reject, { once: true });
    sourceBuffer.appendBuffer(chunk);
  });
}
function expandDashTemplate(template, representationId, number) {
  return template.replace(/\\$RepresentationID\\$/g, representationId)
    .replace(/\\$Number%0(\\d+)d\\$/g, (_, width) => String(number).padStart(Number(width), '0'))
    .replace(/\\$Number\\$/g, String(number));
}
async function resolveDashResources(manifestUrl) {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error('DASH manifest request failed');
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const representations = Array.from(xml.querySelectorAll('Representation')).slice(0, 2);
  return Promise.all(representations.map(async (representation) => {
    const adaptation = representation.parentElement;
    const template = representation.querySelector('SegmentTemplate') || adaptation.querySelector('SegmentTemplate');
    if (!template) throw new Error('DASH segment template missing');
    const representationId = representation.getAttribute('id');
    const initialization = template.getAttribute('initialization');
    const media = template.getAttribute('media');
    if (!representationId || !initialization || !media) throw new Error('DASH media reference missing');
    const number = Number(template.getAttribute('startNumber') || '1');
    const paths = [
      expandDashTemplate(initialization, representationId, number),
      expandDashTemplate(media, representationId, number)
    ];
    const chunks = await Promise.all(paths.map(async (path) => {
      const mediaResponse = await fetch(new URL(path, new URL(manifestUrl, location.href)));
      if (!mediaResponse.ok) throw new Error('DASH media request failed');
      return mediaResponse.arrayBuffer();
    }));
    const mime = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || 'video/mp4';
    const codecs = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || '';
    return { chunks, mimeType: codecs ? mime + '; codecs="' + codecs + '"' : mime };
  }));
}
async function appendSegmentPipeline(video, tracks, status) {
  if (!('MediaSource' in window) || tracks.some((track) => !MediaSource.isTypeSupported(track.mimeType))) {
    status.textContent = 'DASH media was requested; MSE cannot append one or more advertised codecs.';
    return;
  }
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  source.addEventListener('sourceopen', async () => {
    try {
      const buffers = tracks.map((track) => source.addSourceBuffer(track.mimeType));
      await Promise.all(tracks.map(async (track, index) => {
        for (const chunk of track.chunks) await appendDashChunk(buffers[index], chunk);
      }));
      source.endOfStream();
      status.textContent = 'DASH init and media segments appended through MSE.';
    } catch (error) {
      status.textContent = 'DASH media was requested; MSE append was unavailable.';
    }
  }, { once: true });
}
resolveDashResources('/open-range/manifest.mpd')
  .then((tracks) => appendSegmentPipeline(dashVideo, tracks, dashStatus))
  .catch(() => { dashStatus.textContent = 'DASH pipeline request failed.'; });
</script>`;
}

function mediaPathFor(resource: string, fixtures: MediaFixtures): string | undefined {
  const paths = [fixtures.video, fixtures.videoOnly, fixtures.audioOnly];
  return paths.find((path) => basename(path) === resource);
}

async function sendDashResource(request: IncomingMessage, response: ServerResponse, resource: string, fixtures: MediaFixtures): Promise<boolean> {
  if (resource === 'manifest.mpd') {
    sendBuffer(request, response, await readFixture(fixtures.dashManifest), 'application/dash+xml', { 'Cache-Control': 'no-store' });
    return true;
  }
  const segment = fixtures.dashSegments.find((path) => fixtureName(path) === resource);
  if (segment === undefined) {
    return false;
  }
  await sendMedia(request, response, segment);
  return true;
}

function sendCaptureSupport(request: IncomingMessage, response: ServerResponse, resource: string): boolean {
  if (resource === 'frame') {
    const frame = '<!doctype html><title>Local lab frame</title><video controls preload="metadata" src="/open-range/video.mp4"></video>';
    sendBuffer(request, response, Buffer.from(frame), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    return true;
  }
  if (resource === 'worker.js') {
    const worker = "const requestMedia = () => fetch('/open-range/video.mp4', { headers: { Range: 'bytes=0-127' } }); self.onmessage = requestMedia; requestMedia();";
    sendBuffer(request, response, Buffer.from(worker), 'application/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    return true;
  }
  if (resource === 'service-worker.js') {
    const serviceWorker = "self.addEventListener('install', (event) => event.waitUntil(fetch('/open-range/video.mp4', { headers: { Range: 'bytes=128-255' } }).then(() => self.skipWaiting())));";
    sendBuffer(request, response, Buffer.from(serviceWorker), 'application/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    return true;
  }
  return false;
}

async function sendMedia(request: IncomingMessage, response: ServerResponse, path: string, options: { rangeCap?: number; etag?: string; lastModified?: string } = {}): Promise<void> {
  const contents = await readFixture(path);
  const total = contents.byteLength;
  const requestedRange = parseRange(request.headers.range, total);
  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mediaTypeFor(path),
    'ETag': options.etag ?? '"lab-fixture-v1"',
    'Last-Modified': options.lastModified ?? 'Thu, 01 Jan 1970 00:00:00 GMT',
    'Cache-Control': 'no-store'
  };
  if (requestedRange === 'unsatisfiable') {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
    response.end();
    return;
  }
  if ((requestedRange === undefined || requestedRange === 'malformed' || isMultipleRange(requestedRange)) && options.rangeCap === undefined) {
    sendBuffer(request, response, contents, mediaTypeFor(path), headers);
    return;
  }
  const selected = isMultipleRange(requestedRange)
    ? requestedRange.selected
    : requestedRange === undefined || requestedRange === 'malformed'
      ? { start: 0, end: Math.min(total - 1, (options.rangeCap ?? total) - 1) }
      : requestedRange;
  const end = options.rangeCap === undefined ? selected.end : Math.min(selected.end, selected.start + options.rangeCap - 1);
  const body = contents.subarray(selected.start, end + 1);
  sendBuffer(request, response, body, mediaTypeFor(path), {
    ...headers,
    'Content-Range': `bytes ${selected.start}-${end}/${total}`
  }, 206);
}

function sendBuffer(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string | number> = {},
  status = 200
): void {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.byteLength, ...extraHeaders });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
}

function parseRange(header: string | undefined, total: number): RangeSelection | MultipleRangeSelection | 'malformed' | 'unsatisfiable' | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = header.match(/^bytes=(.+)$/);
  if (!match) {
    return 'malformed';
  }
  const ranges = match[1].split(',').map((value) => parseSingleRange(value.trim(), total));
  if (ranges.length === 0 || ranges.some((range) => range === 'malformed')) {
    return 'malformed';
  }
  const satisfiable = ranges.filter((range): range is RangeSelection => typeof range === 'object');
  if (satisfiable.length === 0) {
    return 'unsatisfiable';
  }
  return ranges.length === 1 ? satisfiable[0] : { kind: 'multiple', selected: satisfiable[0] };
}

function parseSingleRange(value: string, total: number): RangeSelection | 'malformed' | 'unsatisfiable' {
  const match = value.match(/^(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) {
    return 'malformed';
  }
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength)) return 'malformed';
    if (suffixLength <= 0) return 'unsatisfiable';
    return { start: Math.max(0, total - suffixLength), end: total - 1 };
  }
  const start = Number(match[1]);
  const suppliedEnd = match[2] === '' ? total - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(suppliedEnd) || start < 0) {
    return 'malformed';
  }
  if (suppliedEnd < start || start >= total) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(suppliedEnd, total - 1) };
}

function isMultipleRange(value: RangeSelection | MultipleRangeSelection | 'malformed' | 'unsatisfiable' | undefined): value is MultipleRangeSelection {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

function mediaTypeFor(path: string): string {
  if (path.endsWith('.ts')) return 'video/mp2t';
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.mpd')) return 'application/dash+xml';
  if (path.endsWith('.m4s')) return 'video/iso.segment';
  return 'video/mp4';
}

function isFutureExpiry(value: string | null): boolean {
  if (value === null || !/^\d+$/.test(value)) return false;
  const expires = Number(value);
  return Number.isSafeInteger(expires) && expires > Math.floor(Date.now() / 1000);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function originFor(request: IncomingMessage): string {
  const host = request.headers.host;
  return `http://${host && /^127\.0\.0\.1:\d+$/.test(host) ? host : '127.0.0.1'}`;
}

function listen(server: Server, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => server.close(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

async function closeServer(server: Server, fixtures: MediaFixtures): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING' ? resolve() : reject(error));
  });
  await fixtures.cleanup();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new DOMException('Local media lab startup was cancelled', 'AbortError');
}
