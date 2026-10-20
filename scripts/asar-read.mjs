// Read-only asar reader: lists and extracts files from an Electron asar.
//
// The asar format is a JSON header followed by a file blob. The header is at
// offset 8: four bytes of framing, then a JSON directory tree whose entries
// carry { offset, size } into the blob.
//
//   node scripts/asar-read.mjs <asar> list [prefix]
//   node scripts/asar-read.mjs <asar> read <path-in-asar>
//   node scripts/asar-read.mjs <asar> grep <pattern> [prefix]
//
// Only the header is read up front, and file bodies are read by range, so a
// 180MB asar costs a few kilobytes to index.
//
// Nothing is written; nothing outside the asar is touched.

import { openSync, readSync, closeSync, existsSync, fstatSync } from 'node:fs';

function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r');
  const size = fstatSync(fd).size;
  // The header is a nested Pickle:
  //   0-3   UInt32  size of the next field (always 4)
  //   4-7   UInt32  size of the header pickle
  //   8-11  UInt32  size of the header JSON string
  //   12..  the header JSON
  const head = Buffer.alloc(12);
  readSync(fd, head, 0, 12, 0);
  const headerPickleSize = head.readUInt32LE(4);
  const headerStringSize = head.readUInt32LE(8);
  const headerBuf = Buffer.alloc(headerStringSize);
  // The header string is padded to a 4-byte boundary inside the pickle.
  const padding = (4 - (headerStringSize % 4)) % 4;
  readSync(fd, headerBuf, 0, headerStringSize, 12 + padding);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const base = 8 + headerPickleSize;
  const files = new Map();

  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, path);
      else if (!entry.unpacked) {
        files.set(path, { offset: base + Number(entry.offset), size: entry.size });
      }
    }
  };
  walk(header, '');

  return {
    files,
    read(path) {
      const entry = files.get(path);
      if (entry === undefined) return null;
      const buf = Buffer.alloc(entry.size);
      readSync(fd, buf, 0, entry.size, entry.offset);
      return buf.toString('utf8');
    },
    close() {
      closeSync(fd);
    },
  };
}

const [asarPath, command, arg, prefix] = process.argv.slice(2);
if (!asarPath || !command) {
  process.stderr.write('usage: asar-read.mjs <asar> list|read|grep ...\n');
  process.exit(1);
}
if (!existsSync(asarPath)) {
  process.stderr.write(`no such asar: ${asarPath}\n`);
  process.exit(1);
}

const arasar = openAsar(asarPath);

if (command === 'list') {
  for (const path of [...arasar.files.keys()].sort()) {
    if (!prefix || path.includes(prefix)) process.stdout.write(`${path}\n`);
  }
} else if (command === 'read') {
  const text = arasar.read(arg);
  if (text === null) {
    process.stderr.write(`not found: ${arg}\n`);
    process.exit(1);
  }
  process.stdout.write(text);
} else if (command === 'grep') {
  const re = new RegExp(arg, 'i');
  for (const path of [...arasar.files.keys()].sort()) {
    if (!path.endsWith('.js')) continue;
    if (prefix && !path.includes(prefix)) continue;
    const text = arasar.read(path);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) process.stdout.write(`${path}:${i + 1}: ${line.trim().slice(0, 200)}\n`);
    });
  }
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(1);
}

arasar.close();
