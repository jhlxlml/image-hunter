/* ==========================================================================
 * ImageHunter — shared/zip.js
 * 零依赖 Store 模式 ZIP 打包器（UTF-8 文件名 + CRC-32）
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Zip) return;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function encodeUtf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const s = unescape(encodeURIComponent(str));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

  /**
   * 构建 ZIP 二进制（Store 无压缩模式，适合已压缩的图片格式）
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Uint8Array}
   */
  function build(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const item of (entries || [])) {
      const nameBytes = encodeUtf8(String(item.name || 'file'));
      const data = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data || 0);
      const crc = crc32(data);
      const size = data.length >>> 0;

      const localHeader = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04, // Local file header signature
        20, 0,                  // Version needed: 2.0
        0x00, 0x08,             // UTF-8 filename flag (bit 11)
        0, 0,                   // Compression: 0 (store)
        0, 0, 0, 0,             // Mod time / date
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(nameBytes.length),
        0, 0                    // Extra field length
      ]);

      locals.push(localHeader, nameBytes, data);

      const centralHeader = new Uint8Array([
        0x50, 0x4b, 0x01, 0x02, // Central directory signature
        20, 0,                  // Version made by
        20, 0,                  // Version needed
        0x00, 0x08,             // UTF-8 flag
        0, 0,                   // Compression: store
        0, 0, 0, 0,             // Mod time / date
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(nameBytes.length),
        0, 0,                   // Extra len
        0, 0,                   // Comment len
        0, 0,                   // Disk number
        0, 0,                   // Internal attrs
        0, 0, 0, 0,             // External attrs
        ...u32(offset)
      ]);

      centrals.push(centralHeader, nameBytes);
      offset += localHeader.length + nameBytes.length + size;
    }

    let cdSize = 0;
    for (const c of centrals) cdSize += c.length;
    const count = (entries || []).length;

    const eocd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,   // EOCD signature
      0, 0, 0, 0,               // Disk numbers
      ...u16(count),
      ...u16(count),
      ...u32(cdSize),
      ...u32(offset),
      0, 0                      // Comment length
    ]);

    const total = offset + cdSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of locals) { out.set(chunk, pos); pos += chunk.length; }
    for (const chunk of centrals) { out.set(chunk, pos); pos += chunk.length; }
    out.set(eocd, pos);
    return out;
  }

  IH.Zip = { build, crc32 };
})();
