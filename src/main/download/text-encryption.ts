/** Bounded lexical parser: no entity expansion, and every input byte is consumed before state compaction. */
export class TextEncryptionClassifier {
  encrypted = false;
  private utf8 = Buffer.alloc(0);
  private mode: 'initial' | 'xml' | 'hls' | 'lab' | 'other' = 'initial';
  private state = 'text';
  private token = '';
  private quote = '';
  private depth = 0;
  private closing = false;
  private hlsHeader = false;
  private keyLine = false;
  private attribute = '';
  private value = '';
  private elements: string[] = [];
  private elementName = '';
  private selfClosing = false;
  private rootSeen = false;
  private lexicalLength = 0;
  copy(): TextEncryptionClassifier {
    const next = new TextEncryptionClassifier();
    Object.assign(next, this); next.utf8 = Buffer.from(this.utf8); next.elements = [...this.elements];
    return next;
  }
  push(bytes: Buffer): void {
    const input = Buffer.concat([this.utf8, bytes]);
    let end = input.length;
    // Retain only an unfinished UTF-8 code point. The state is explicitly copyable.
    let start = end - 1;
    while (start >= 0 && (input[start] & 0xc0) === 0x80 && end - start <= 4) start--;
    if (start >= 0) {
      const lead = input[start];
      const length = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
      if (end - start < length) end = start;
    }
    this.utf8 = Buffer.from(input.subarray(end));
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.subarray(0, end)); }
    catch { throw new Error('invalid-media-structure'); }
    for (const char of decoded) {
      if (this.encrypted || this.mode === 'other') break;
      if (this.mode === 'initial') {
        if (/\s/.test(char) || char === '\ufeff') continue;
        this.mode = char === '<' ? 'xml' : char === '#' ? 'hls' : char === 'l' ? 'lab' : 'other';
        this.state = this.mode === 'hls' ? 'tag' : 'text';
      }
      if (this.mode === 'xml') this.xml(char);
      else if (this.mode === 'hls') this.hls(char);
      else if (this.mode === 'lab') {
        this.token += char;
        if (!'local-lab-encrypted-placeholder-v1'.startsWith(this.token)) this.mode = 'other';
        else if (this.token === 'local-lab-encrypted-placeholder-v1') this.encrypted = true;
      }
    }
  }
  finish(): void {
    if (this.encrypted) return;
    if (this.utf8.length || (this.mode === 'xml' && (this.state !== 'text' || this.elements.length || !this.rootSeen))) throw new Error('invalid-media-structure');
    if (this.mode === 'hls') {
      if (this.quote || this.state === 'before-value') throw new Error('invalid-media-structure');
      if (this.state === 'value' || this.state === 'after-value') this.commitMethod();
    }
  }
  private closeTag(): void {
    if (this.closing) {
      if (this.selfClosing || this.elements.pop() !== this.elementName) throw new Error('invalid-media-structure');
    } else {
      if (!this.elements.length) { if (this.rootSeen) throw new Error('invalid-media-structure'); this.rootSeen = true; }
      if (!this.selfClosing) { if (this.elements.length >= 64) throw new Error('invalid-media-structure'); this.elements.push(this.elementName); }
      const localName = this.elementName.split(':').at(-1);
      if (localName === 'ContentProtection' || localName === 'pssh') this.encrypted = true;
    }
    this.state = 'text'; this.elementName = ''; this.selfClosing = false;
  }
  private xml(char: string): void {
    if (this.state === 'text') { if (char === '<') { this.state = 'lt'; this.lexicalLength = 0; } return; }
    if (this.state === 'comment' || this.state === 'declaration-comment' || this.state === 'cdata' || this.state === 'pi' || this.state === 'declaration-pi') {
      if (++this.lexicalLength > 64 * 1024) throw new Error('invalid-media-structure');
      this.token = (this.token + char).slice(-3);
      if (this.token.endsWith(this.state.endsWith('comment') ? '-->' : this.state === 'cdata' ? ']]>' : '?>')) { this.state = this.state.startsWith('declaration-') ? 'declaration' : 'text'; this.token = ''; }
      return;
    }
    if (this.state === 'lt') {
      this.token = ''; this.closing = false;
      if (char === '!') { this.state = 'bang'; return; }
      if (char === '?') { this.state = 'pi'; return; }
      if (char === '/') { this.closing = true; this.state = 'name'; return; }
      this.state = 'name';
    }
    if (this.state === 'bang') {
      this.token += char;
      if (this.token === '--') { this.state = 'comment'; this.token = ''; }
      else if (this.token === '[CDATA[') { this.state = 'cdata'; this.token = ''; }
      else if (!'--'.startsWith(this.token) && !'[CDATA['.startsWith(this.token)) {
        this.state = 'declaration'; this.depth = 0; this.quote = ''; this.token = ''; this.xml(char);
      }
      return;
    }
    if (this.state === 'name') {
      if (xmlNameChar(char)) {
        if (this.token.length >= 256) throw new Error('invalid-media-structure');
        this.token += char; return;
      }
      if (!/[\s/>]/.test(char) || !qualifiedName(this.token)) throw new Error('invalid-media-structure');
      this.elementName = this.token;
      this.state = 'attributes'; this.quote = ''; this.token = ''; this.selfClosing = false;
    }
    if (this.quote) { if (char === this.quote) this.quote = ''; return; }
    if (char === '"' || char === "'") { this.quote = char; return; }
    if (this.state === 'declaration') {
      this.token = (this.token + char).slice(-4);
      if (this.token.endsWith('<?')) { this.state = 'declaration-pi'; this.token = ''; this.lexicalLength = 0; return; }
      if (this.token === '<!--') { this.state = 'declaration-comment'; this.token = ''; this.lexicalLength = 0; return; }
      if (char === '[') { if (++this.depth > 64) throw new Error('invalid-media-structure'); }
      if (char === ']' && this.depth > 0) this.depth--;
    }
    if (this.state === 'attributes') {
      if (char === '/') this.selfClosing = true;
      else if (char === '>') this.closeTag();
      else if (this.selfClosing && !/\s/.test(char)) throw new Error('invalid-media-structure');
    } else if (char === '>' && this.depth === 0) this.state = 'text';
  }
  private commitMethod(): void {
    this.value = this.value.trim();
    if (this.attribute === 'METHOD' && /^[A-Z0-9-]+$/.test(this.value) && this.value !== 'NONE') this.encrypted = true;
    this.attribute = ''; this.value = '';
  }
  private hls(char: string): void {
    if (char === '\r' || char === '\n') {
      if (this.state === 'tag' && this.token === '#EXTM3U') this.hlsHeader = true;
      if (this.state === 'value' || this.state === 'after-value') this.commitMethod();
      this.state = 'tag'; this.token = ''; this.keyLine = false; this.quote = ''; this.attribute = ''; this.value = ''; return;
    }
    if (this.state === 'tag') {
      if (char === ':') {
        this.keyLine = this.hlsHeader && ['#EXT-X-KEY', '#EXT-X-SESSION-KEY'].includes(this.token);
        this.state = this.keyLine ? 'attribute' : 'ignore'; this.token = ''; return;
      }
      if (this.token.length < 32) this.token += char; else this.state = 'ignore';
      return;
    }
    if (this.state === 'ignore') return;
    if (this.state === 'attribute') {
      if (char === '=') { this.attribute = this.token.trim(); this.token = ''; this.state = 'before-value'; return; }
      if (char === ',') { this.token = ''; return; }
      if (this.token.length >= 128) throw new Error('invalid-media-structure');
      this.token += char; return;
    }
    if (this.state === 'before-value') {
      if (/\s/.test(char)) return;
      this.state = 'value'; this.value = '';
      if (char === '"') { this.quote = char; return; }
    }
    if (this.state === 'value') {
      if (this.quote) {
        if (char === this.quote) { this.quote = ''; this.state = 'after-value'; }
        else if (this.attribute === 'METHOD') this.appendMethod(char);
      } else if (char === ',') { this.commitMethod(); this.state = 'attribute'; }
      else if (this.attribute === 'METHOD') this.appendMethod(char);
      return;
    }
    if (this.state === 'after-value' && char === ',') { this.commitMethod(); this.state = 'attribute'; }
  }
  private appendMethod(char: string): void {
    if (this.value.length >= 128) throw new Error('invalid-media-structure');
    this.value += char;
  }
}

// XML 1.0 (Fifth Edition) NameStartChar/NameChar; QName splits at one literal colon.
// Prefixes are Unicode-aware; local names are never normalized or case-folded.
function xmlNameStart(char: string): boolean {
  const cp = char.codePointAt(0)!;
  return /[A-Za-z_]/.test(char) || (cp >= 0xc0 && cp <= 0xd6) || (cp >= 0xd8 && cp <= 0xf6)
    || (cp >= 0xf8 && cp <= 0x2ff) || (cp >= 0x370 && cp <= 0x37d) || (cp >= 0x37f && cp <= 0x1fff)
    || (cp >= 0x200c && cp <= 0x200d) || (cp >= 0x2070 && cp <= 0x218f) || (cp >= 0x2c00 && cp <= 0x2fef)
    || (cp >= 0x3001 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfdcf) || (cp >= 0xfdf0 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0xeffff);
}
function xmlNameChar(char: string): boolean {
  const cp = char.codePointAt(0)!;
  return xmlNameStart(char) || /[0-9.:-]/.test(char) || cp === 0xb7 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x203f && cp <= 0x2040);
}
function qualifiedName(name: string): boolean {
  const parts = name.split(':');
  return parts.length <= 2 && parts.every(part => { const chars = [...part]; return !!chars.length && xmlNameStart(chars[0]) && chars.slice(1).every(char => char !== ':' && xmlNameChar(char)); });
}
