import {createHash} from 'node:crypto';
import {get, put} from '@vercel/blob';

function marker(ticket) {
  return 'sessions/v2/' + createHash('sha256').update(ticket).digest('hex');
}

export function createBlobSessions(storage = {get, put}) {
  function write(ticket, value, overwrite) {
    return storage.put(marker(ticket), value, {
      access:'private', addRandomSuffix:false, allowOverwrite:overwrite, ttlDays:1,
      contentType:'text/plain', abortSignal:AbortSignal.timeout(10000)
    });
  }
  return {
    activate: ticket => write(ticket,'active',false),
    // A successful overwrite is visible to every subsequent origin read.
    revoke: ticket => write(ticket,'revoked',true),
    async active(ticket) {
      const result = await storage.get(marker(ticket), {
        access:'private', useCache:false, abortSignal:AbortSignal.timeout(10000)
      });
      return result?.statusCode === 200 && await new Response(result.stream).text() === 'active';
    }
  };
}

// The local development server is a single process. Restarting closes its sessions.
export function createLocalSessions() {
  const records = new Map();
  return {
    activate(ticket) {
      const now = Date.now();
      for (const [id, expiry] of records) if (expiry <= now) records.delete(id);
      records.set(marker(ticket),Number(ticket.split('.')[0]));
    },
    revoke: ticket => records.delete(marker(ticket)),
    active: ticket => records.get(marker(ticket)) > Date.now()
  };
}
