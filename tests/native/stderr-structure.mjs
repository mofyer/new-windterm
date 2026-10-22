// Diagnostic-only recognizer for a deliberately limited CLIXML subset, not a
// general XML parser or a stderr safety classifier. No source strings escape.
export const STDERR_STRUCTURE_LIMIT = 16 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 512;
const MAX_ATTRIBUTES = 8;
const NAMESPACE = 'http://schemas.microsoft.com/powershell/2004/04';
const ELEMENTS = new Set('Obj S MS Props TN TNRef T Ref Nil SS B By SB U16 I16 U32 I32 U64 I64 Sg Db D DT TS C G URI Version XD SBK BA LST IE DCT En Key Value ToString PR AV AI PI PC SR SD'.split(' '));
const emptyStreams = () => ({ error: 0, warning: 0, verbose: 0, debug: 0, information: 0, progress: 0, output: 0, unknown: 0 });
const xmlCharacter = code => code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

// Validate entities without expanding any custom entity or returning text.
function validText(text) {
  if (text.includes(']]>')) return false;
  for (const char of text) if (!xmlCharacter(char.codePointAt(0))) return false;
  return !text.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:[0-9]+|x[0-9A-Fa-f]+);/g, entity => {
    if (!entity.startsWith('&#')) return '';
    const numeric = entity.slice(2, -1);
    return xmlCharacter(numeric.startsWith('x') ? Number.parseInt(numeric.slice(1), 16) : Number(numeric)) ? '' : '&';
  }).includes('&');
}

export function summarizeStderrStructure(bytes, { truncated = false, complete = true } = {}) {
  const captured = bytes.subarray(0, STDERR_STRUCTURE_LIMIT);
  const result = { status: 'unknown', capturedBytes: captured.length, truncated: truncated || bytes.length > STDERR_STRUCTURE_LIMIT || !complete, validUtf8: false, header: false, xml: false, root: false, nodes: 0, maxDepth: 0, streams: emptyStreams() };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(captured); result.validUtf8 = true; } catch { result.status = result.truncated ? 'truncated' : 'malformed'; return result; }
  result.header = /^#< CLIXML\r?\n/.test(text);
  if (result.truncated) { result.status = 'truncated'; return result; }
  if (!text) { result.status = 'empty'; return result; }
  if (!result.header) return result;
  text = text.replace(/^#< CLIXML\r?\n/, '');
  const invalid = () => { result.status = 'malformed'; return result; };
  const stack = [];
  const streams = emptyStreams();
  let position = 0;
  let nodes = 0;
  let maxDepth = 0;
  let rootClosed = false;
  let validRoot = false;
  while (position < text.length) {
    if (text[position] !== '<') {
      const end = text.indexOf('<', position);
      const value = text.slice(position, end < 0 ? text.length : end);
      if (!validText(value) || (stack.length <= 1 && !/^[\t\r\n ]*$/.test(value))) return invalid();
      position = end < 0 ? text.length : end;
      continue;
    }
    // Reject declarations, DTD, comments, CDATA and processing instructions.
    // The restricted grammar below consumes every byte of every tag.
    const close = /^<\/([A-Za-z][A-Za-z0-9]*)[\t\r\n ]*>/.exec(text.slice(position));
    if (close) {
      if (!stack.length || stack.pop() !== close[1]) return invalid();
      position += close[0].length;
      if (!stack.length) rootClosed = true;
      continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9]*)/.exec(text.slice(position));
    if (!opening || rootClosed) return invalid();
    const name = opening[1];
    position += opening[0].length;
    const attributes = new Map();
    let selfClosing = false;
    while (true) {
      const end = /^[\t\r\n ]*(\/?)>/.exec(text.slice(position));
      if (end) { selfClosing = end[1] === '/'; position += end[0].length; break; }
      const attribute = /^[\t\r\n ]+([A-Za-z][A-Za-z0-9]*)[\t\r\n ]*=[\t\r\n ]*(?:"([^"<]*)"|'([^'<]*)')/.exec(text.slice(position));
      if (!attribute || attributes.has(attribute[1]) || attributes.size >= MAX_ATTRIBUTES) return invalid();
      const value = attribute[2] ?? attribute[3];
      if (!validText(value)) return invalid();
      attributes.set(attribute[1], value);
      position += attribute[0].length;
    }
    if (++nodes > MAX_NODES || stack.length + 1 > MAX_DEPTH) return invalid();
    maxDepth = Math.max(maxDepth, stack.length + 1);
    if (!stack.length) {
      validRoot = name === 'Objs' && attributes.get('Version') === '1.1.0.1' && attributes.get('xmlns') === NAMESPACE && attributes.size === 2;
      if (!validRoot) return invalid();
    } else {
      if (!ELEMENTS.has(name) || [...attributes.keys()].some(key => !['N', 'S', 'RefId'].includes(key))) return invalid();
      if (attributes.has('S') && !['Obj', 'S'].includes(name)) return invalid();
      if (stack.length === 1 && attributes.has('S')) {
        const stream = attributes.get('S').toLowerCase();
        streams[Object.hasOwn(streams, stream) ? stream : 'unknown']++;
      }
    }
    if (!selfClosing) stack.push(name);
    else if (!stack.length) rootClosed = true;
  }
  if (!validRoot || !rootClosed || stack.length) return invalid();
  return { ...result, status: 'clixml', xml: true, root: true, nodes, maxDepth, streams };
}

export function createStderrStructure() {
  const chunks = [];
  let captured = 0;
  let truncated = false;
  return {
    push(chunk) {
      const remaining = STDERR_STRUCTURE_LIMIT - captured;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const value = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(value);
        captured += value.length;
      }
    },
    summarize(options = {}) {
      return summarizeStderrStructure(Buffer.concat(chunks, captured), { ...options, truncated });
    },
  };
}
