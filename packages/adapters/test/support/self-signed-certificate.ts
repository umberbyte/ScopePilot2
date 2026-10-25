import { generateKeyPairSync, sign } from 'node:crypto';

function lengthBytes(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

function sequence(...items: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(items));
}

function set(item: Buffer): Buffer {
  return tagged(0x31, item);
}

function integer(value: number): Buffer {
  return tagged(0x02, Buffer.from([value]));
}

function encodeBase128(value: number): Buffer {
  const bytes = [value % 128];
  for (let remaining = Math.floor(value / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
    bytes.unshift((remaining % 128) | 0x80);
  }
  return Buffer.from(bytes);
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split('.').map(Number);
  const encoded = [encodeBase128(40 * parts[0]! + parts[1]!)];
  for (const part of parts.slice(2)) {
    encoded.push(encodeBase128(part));
  }
  return tagged(0x06, Buffer.concat(encoded));
}

function utcTime(value: Date): Buffer {
  const year = value.getUTCFullYear().toString().slice(-2);
  const fields = [
    year,
    String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0'),
    String(value.getUTCHours()).padStart(2, '0'),
    String(value.getUTCMinutes()).padStart(2, '0'),
    String(value.getUTCSeconds()).padStart(2, '0'),
  ];
  return tagged(0x17, Buffer.from(`${fields.join('')}Z`, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ''].join('\n');
}

/** Runtime-generated localhost certificate keeps the TLS fixture independent of external binaries and expiry dates. */
export function selfSignedLocalhostCertificate(): { readonly cert: string; readonly key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signatureAlgorithm = sequence(objectIdentifier('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = sequence(set(sequence(objectIdentifier('2.5.4.3'), tagged(0x0c, Buffer.from('localhost', 'utf8')))));
  const now = Date.now();
  const validity = sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 365 * 86_400_000)));
  const subjectPublicKeyInfo = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = sequence(
    tagged(0xa0, integer(2)),
    integer(1),
    signatureAlgorithm,
    name,
    validity,
    name,
    subjectPublicKeyInfo,
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, signatureAlgorithm, tagged(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
}
