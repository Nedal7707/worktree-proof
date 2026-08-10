const BEARER_TOKEN_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-';
const SECRET_KEY_MARKERS = Object.freeze([
  'secret',
  'token',
  'password',
  'passwd',
  'apikey',
  'privatekey',
  'cookie',
  'credential',
]);

function isAsciiLetterOrDigit(character) {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWhitespace(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function compactKey(value) {
  let compact = '';
  for (const character of String(value).toLowerCase()) {
    if (isAsciiLetterOrDigit(character)) compact += character;
    if (compact.length >= 256) break;
  }
  return compact;
}

function looksLikeSecretKey(value) {
  const compact = compactKey(value);
  if (!compact) return false;
  if (SECRET_KEY_MARKERS.some((marker) => compact.includes(marker))) return true;
  return compact === 'auth'
    || compact.endsWith('auth')
    || compact.includes('authentication')
    || compact.includes('authorization');
}

function firstAssignmentSeparator(line) {
  const equals = line.indexOf('=');
  const colon = line.indexOf(':');
  if (equals < 0) return colon;
  if (colon < 0) return equals;
  return Math.min(equals, colon);
}

function containsBearerToken(text) {
  const lower = text.toLowerCase();
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf('bearer', cursor);
    if (start < 0) return false;
    const before = start === 0 ? '' : lower[start - 1];
    let tokenStart = start + 6;
    if ((!before || !isAsciiLetterOrDigit(before)) && isWhitespace(lower[tokenStart])) {
      while (tokenStart < lower.length && isWhitespace(lower[tokenStart])) tokenStart += 1;
      let tokenEnd = tokenStart;
      while (tokenEnd < lower.length && BEARER_TOKEN_CHARACTERS.includes(text[tokenEnd])) tokenEnd += 1;
      if (tokenEnd > tokenStart) return true;
    }
    cursor = start + 6;
  }
  return false;
}

/** Linear-time secret-shape detection for untrusted text. */
export function containsSecretLikeValue(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const upper = value.toUpperCase();
  const privateKeyStart = upper.indexOf('-----BEGIN ');
  if (privateKeyStart >= 0 && upper.indexOf(' PRIVATE KEY-----', privateKeyStart + 11) >= 0) return true;
  if (containsBearerToken(value)) return true;

  for (const rawLine of value.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const separator = firstAssignmentSeparator(line);
    if (separator <= 0) continue;
    let key = line.slice(0, separator).trim();
    if (key.toLowerCase().startsWith('export ')) key = key.slice(7).trim();
    const assigned = line.slice(separator + 1).trim();
    if (assigned && !assigned.startsWith('#') && looksLikeSecretKey(key)) return true;
  }
  return false;
}

/** Produce a bounded filesystem/prompt identifier without regex backtracking. */
export function toSafeIdentifier(value, maxLength = 80) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 80;
  let result = '';
  let separatorPending = false;
  for (const character of String(value)) {
    const allowed = isAsciiLetterOrDigit(character) || character === '.' || character === '_' || character === '-';
    if (allowed) {
      if (separatorPending && result && !result.endsWith('-')) result += '-';
      result += character;
      separatorPending = false;
    } else {
      separatorPending = true;
    }
    if (result.length >= limit) break;
  }
  result = result.slice(0, limit);
  while (result.startsWith('-')) result = result.slice(1);
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result;
}

function skipControlString(text, cursor) {
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 7) return cursor + 1;
    if (code === 27 && text[cursor + 1] === '\\') return cursor + 2;
    cursor += 1;
  }
  return cursor;
}

function skipCsi(text, cursor) {
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return cursor;
}

/** Strip ANSI/OSC control sequences in one forward pass. */
export function stripAnsiSequences(value) {
  const text = value == null ? '' : String(value);
  const parts = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 0x1b && code !== 0x9b) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) parts.push(text.slice(plainStart, cursor));
    if (code === 0x9b) {
      cursor = skipCsi(text, cursor + 1);
    } else {
      const introducer = text[cursor + 1];
      if (introducer === '[') cursor = skipCsi(text, cursor + 2);
      else if (introducer === ']' || introducer === 'P' || introducer === '^' || introducer === '_') cursor = skipControlString(text, cursor + 2);
      else cursor = Math.min(text.length, cursor + 2);
    }
    plainStart = cursor;
  }
  if (plainStart < text.length) parts.push(text.slice(plainStart));
  return parts.join('');
}
