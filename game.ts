import { getStore } from '@netlify/blobs';
import { createGameHandler } from '../../src/server/game-core.js';

// All room reads are strongly consistent. State transitions use ETag CAS writes
// (onlyIfMatch / onlyIfNew), so overlapping requests cannot silently overwrite.
const handler = createGameHandler({
  getStore: () => getStore({ name: 'quiz-battle-state', consistency: 'strong' })
});

export default async (request: Request) => handler(request);
