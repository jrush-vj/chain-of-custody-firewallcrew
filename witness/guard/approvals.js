// Approver authentication for the guard API. API only: there is no UI here.
//
// APPROVERS is a JSON list of {"id": "<name>", "sha256": "<hex of sha256(token)>"}. Only hashes are
// configured, and nothing about approvers is stored on the protected box. With no approvers configured,
// every approval is refused (fail closed).
import { createHash, timingSafeEqual } from 'node:crypto';

export const parseApprovers = (raw) => {
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('APPROVERS must be a JSON list');
  }
  if (!Array.isArray(list)) throw new Error('APPROVERS must be a JSON list');
  return list.map((item) => {
    if (!item || !/^[A-Za-z0-9._-]{1,40}$/.test(item.id) || !/^[0-9a-f]{64}$/i.test(item.sha256 || '')) {
      throw new Error('each approver needs an id and a 64-hex sha256 of its token');
    }
    return { id: item.id, hash: Buffer.from(item.sha256, 'hex') };
  });
};

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// Returns the approver id, or null. Compares every configured hash so timing does not reveal which matched.
export const authenticateApprover = (headers, approvers) => {
  const auth = headers.authorization;
  const claimed = headers['x-approver'];
  if (!approvers.length || typeof auth !== 'string' || !auth.startsWith('Bearer ') || typeof claimed !== 'string') return null;
  const supplied = createHash('sha256').update(auth.slice(7)).digest();
  let found = null;
  for (const approver of approvers) {
    if (timingSafeEqual(approver.hash, supplied) && approver.id === claimed) found = approver.id;
  }
  return found;
};
