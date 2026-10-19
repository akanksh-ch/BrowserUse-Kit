import type { Principal } from './leases.ts';

/** RFB 3.8 client stream gate. Upstream must offer SecurityType None only on its private path.
 * Only the validated 3.8/None handshake reaches upstream; ClientInit is forced shared.
 * Input-producing protocol extensions are not negotiated; use standard key/pointer/clipboard.
 * Unsupported extensions fail closed. One instance per WebSocket, binary messages only.
 */
export class RfbInputGate {
  private buffer = Buffer.alloc(0);
  private phase: 'version' | 'security' | 'init' | 'messages';
  private closed = false;
  constructor(private principal: Principal, private authorizeView: (p: Principal) => void,
    private authorizeInput: (p: Principal, clipboard: boolean) => void,
    private forward: (data: Buffer) => void, established = false) { this.phase = established ? 'messages' : 'version'; }
  push(chunk: Uint8Array) {
    if (this.closed) throw new Error('RFB gate closed');
    try {
      this.authorizeView(this.principal);
      if (this.buffer.length + chunk.length > 1024 * 1024) throw new Error('RFB buffer limit');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length) {
        let length: number; let input = false; let clipboard = false; let clientInit = false;
        if (this.phase === 'version') { length = 12; if (this.buffer.length < length) return; if (this.buffer.subarray(0, 12).toString() !== 'RFB 003.008\n') throw new Error('Only RFB 3.8 supported'); this.phase = 'security'; }
        else if (this.phase === 'security') { length = 1; if (this.buffer[0] !== 1) throw new Error('Unsupported RFB security'); this.phase = 'init'; }
        else if (this.phase === 'init') { length = 1; if (this.buffer[0] > 1) throw new Error('Invalid ClientInit'); clientInit = true; this.phase = 'messages'; }
        else {
          const type = this.buffer[0];
          if (type === 0) length = 20; // SetPixelFormat
          else if (type === 2) { if (this.buffer.length < 4) return; const count = this.buffer.readUInt16BE(2); if (count > 256) throw new Error('Too many encodings'); length = 4 + count * 4; }
          else if (type === 3) length = 10; // FramebufferUpdateRequest
          else if (type === 4) { length = 8; input = true; }
          else if (type === 5) { length = 6; input = true; }
          else if (type === 6) { if (this.buffer.length < 8) return; const size = this.buffer.readUInt32BE(4); if (size > 65536) throw new Error('Clipboard limit or unsupported extended clipboard'); length = 8 + size; input = true; clipboard = true; }
          else throw new Error('Unsupported RFB client message');
        }
        if (this.buffer.length < length) return;
        let message = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length);
        if (clientInit) message = Buffer.from([1]); // A viewer cannot evict other clients with exclusive ClientInit.
        else if (this.phase === 'messages' && message[0] === 2) {
          // noVNC advertises QEMU key, extended clipboard, resize, fence and continuous-update
          // extensions. Negotiating them would bypass this parser or break later input.
          const encodings: number[] = [];
          for (let offset = 4; offset < message.length; offset += 4) {
            const encoding = message.readInt32BE(offset);
            if ([0, 1, 2, 5, 6, 7, 16, -223, -224, -239, -240, -232].includes(encoding) ||
                (encoding >= -32 && encoding <= -23) || (encoding >= -256 && encoding <= -247)) encodings.push(encoding);
          }
          if (!encodings.includes(0)) encodings.push(0);
          message = Buffer.alloc(4 + encodings.length * 4); message[0] = 2; message.writeUInt16BE(encodings.length, 2);
          encodings.forEach((encoding, i) => message.writeInt32BE(encoding, 4 + i * 4));
        }
        this.authorizeView(this.principal);
        if (input) { try { this.authorizeInput(this.principal, clipboard); } catch { continue; } }
        this.forward(Buffer.from(message));
      }
    } catch (error) { this.closed = true; this.buffer = Buffer.alloc(0); throw error; }
  }
  close() { this.closed = true; this.buffer = Buffer.alloc(0); }
}
