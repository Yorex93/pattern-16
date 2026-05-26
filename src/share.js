// Pattern-16 share-link encoder: deflate-raw + base64url.
//
// The encoded payload is just the v3 JSON, so the existing parser and the
// v1/v2 migrations apply automatically when a link is opened.
//
// Forward-compat convention: the hash param is named "p" for "pattern v1
// encoding (deflate-raw + base64url)". If we ever change the wire format
// (brotli, encryption, alternate serialization), bump the key to "p2",
// "p3", … so links from old/new versions remain distinguishable.
// Don't add a prefix inside the payload — keep the payload pure JSON.

import { serializePattern, parsePattern } from './json-io.js';

const HASH_KEY = 'p';

function bytesToBase64Url(bytes) {
  // String.fromCharCode(...bytes) blows the call stack on large arrays;
  // chunk to stay safe.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encodeShare(state) {
  const json = JSON.stringify(serializePattern(state));
  const input = new TextEncoder().encode(json);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64Url(compressed);
}

export function buildShareUrl(encoded) {
  return `${location.origin}${location.pathname}#${HASH_KEY}=${encoded}`;
}

// Read the share param from the current URL without modifying the URL.
export function readShareFromHash() {
  const h = window.location.hash;
  if (!h || h.length < 2) return null;
  const raw = h.slice(1);
  // Hand-parse rather than URLSearchParams so an opaque base64url payload
  // never gets percent-decoded or mis-parsed if it contains characters like
  // "+" (it shouldn't, but defense in depth).
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key === HASH_KEY) return eq < 0 ? '' : pair.slice(eq + 1);
  }
  return null;
}

// Clear the share param from the address bar without a page reload.
export function clearShareHash() {
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}

// Backwards-compatible combined read+clear (kept for callers that want both).
export function consumeShareFromHash() {
  const enc = readShareFromHash();
  if (enc) clearShareHash();
  return enc;
}

// Decompress + parse + validate. Resolves to a parsePattern result-like
// object: { ok, value?, errors?, warnings? }.
export async function decodeShare(encoded) {
  try {
    const bytes = base64UrlToBytes(encoded);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const json = await new Response(stream).text();
    return parsePattern(json);
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `Decode failed: ${e.message}` }], warnings: [] };
  }
}
