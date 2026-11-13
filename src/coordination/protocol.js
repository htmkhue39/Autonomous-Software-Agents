/**
 * Small, versioned application protocol carried through Deliveroo.js SDK chat.
 * Peers are hints, never authorities for SDK actions or objective completion.
 */
export const PREFIX = 'ASA-COOP/1:';
export const MAX_WIRE_BYTES = 2200;
export const MAX_MESSAGE_AGE_MS = 20_000;

/** @typedef {'HELLO'|'BELIEF'|'STATUS'|'CLAIM'|'RELEASE'} CoopType */
/** @typedef {{id:string,x:number,y:number,reward:number,ageMs:number}} SharedParcel */
/** @typedef {{type:CoopType,seq:number,at:number,data:any}} CoopMessage */

const plain = (/** @type {unknown} */ x) => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const name = (/** @type {unknown} */ x) => typeof x === 'string' && x.length > 0 && x.length <= 128 && /^[\w.:,-]+$/.test(x);
const pos = (/** @type {unknown} */ x) => Number.isInteger(x) && /** @type {number} */ (x) >= 0 && /** @type {number} */ (x) <= 1000;

/** @param {unknown} p */
export function isSharedParcel(p) {
  if (!plain(p)) return false;
  const x = /** @type {any} */ (p);
  return name(x.id) && pos(x.x) && pos(x.y) && finite(x.reward) && x.reward > 0 && x.reward <= 100000 &&
    Number.isInteger(x.ageMs) && x.ageMs >= 0 && x.ageMs <= 15000;
}

/** @param {CoopType} type @param {number} seq @param {number} at @param {object} data */
export function encodeMessage(type, seq, at, data) {
  const msg = { v: 1, type, seq, at, data };
  if (!validateMessage(msg)) throw new Error('Invalid cooperation message');
  const wire = PREFIX + JSON.stringify(msg);
  if (Buffer.byteLength(wire) > MAX_WIRE_BYTES) throw new Error('Cooperation message too large');
  return wire;
}

/** @param {unknown} input @param {number} [now] @returns {CoopMessage|null} */
export function decodeMessage(input, now = Date.now()) {
  if (typeof input !== 'string' || !input.startsWith(PREFIX) || Buffer.byteLength(input) > MAX_WIRE_BYTES) return null;
  try {
    const parsed = JSON.parse(input.slice(PREFIX.length));
    if (!validateMessage(parsed)) return null;
    if (parsed.at > now + 3000 || now - parsed.at > MAX_MESSAGE_AGE_MS) return null;
    return parsed;
  } catch { return null; }
}

/** @param {any} m */
function validateMessage(m) {
  if (!plain(m) || m.v !== 1 || !['HELLO','BELIEF','STATUS','CLAIM','RELEASE'].includes(m.type) ||
    !Number.isSafeInteger(m.seq) || m.seq < 1 || !finite(m.at) || !plain(m.data)) return false;
  const d = m.data;
  switch (m.type) {
    case 'HELLO': return name(d.agent) && name(d.id);
    case 'BELIEF': return Array.isArray(d.parcels) && d.parcels.length <= 8 && d.parcels.every(isSharedParcel);
    case 'STATUS': return (d.x === null || pos(d.x)) && (d.y === null || pos(d.y)) &&
      (d.intention === null || (typeof d.intention === 'string' && d.intention.length <= 128));
    case 'CLAIM': return name(d.parcelId) && Number.isInteger(d.cost) && d.cost >= 0 && d.cost < 10000 &&
      Number.isInteger(d.leaseMs) && d.leaseMs >= 300 && d.leaseMs <= 15000;
    case 'RELEASE': return name(d.parcelId) && ['completed','collected','failed','yielded','stopped'].includes(d.reason);
  }
  return false;
}
