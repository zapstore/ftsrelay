import { Database } from "bun:sqlite";
import { join } from "bun:path";
import { validateEvent } from 'nostr-tools';

const db = new Database("relay.sqlite");
const blossomDir = Bun.env.BLOSSOM_DIR ?? '/tmp';

const server = Bun.serve({
  async fetch(req, server) {
    const pathname = new URL(req.url).pathname.substring(1);
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization,*',
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE'
    });

    if (/^[0-9a-f]{64}/.test(pathname)) {
      const file = Bun.file(join(blossomDir, pathname.substring(0, 64)));
      // TODO respond with actual mime type stored in db
      if (req.method == 'HEAD') {
        const exists = await file.exists();
        return new Response(null, { status: exists ? 200 : 404, headers });
      }
      if (req.method == 'GET') {
        return new Response(file, { headers });
      }
    } else { // upgrade connection for ws
      server.upgrade(req);
      return new Response('Welcome to relay.zap.store');
    }
  },
  websocket: {
    async message(ws, message) {
      const [type, payload, filter] = JSON.parse(message);
      switch (type) {
        // TODO implement subscriptions after EOSE
        case 'REQ': return _handleRequest(payload, filter, ws);
        case 'EVENT': return _handleEvent(payload, ws);
        case 'CLOSE': return ws.send(JSON.stringify(["CLOSED", payload]));
        default: return ws.send(JSON.stringify(["NOTICE", `error: wtf you mean by ${type}`]));
      }
    },
  },
});

const filterMappings = { ids: 'id', authors: 'pubkey', kinds: 'kind' };
const slRegex = /^#[A-Za-z]$/;

function _handleRequest(payload, filter, ws) {
  const wheres = [];
  const params = {};

  for (const [filterKey, filterValue] of Object.entries(filter)) {
    if (Array.isArray(filterValue)) {
      // ids, authors, kinds
      if (filterMappings[filterKey]) {
        wheres.push(`${filterMappings[filterKey]} IN (${filterValue.map((_, i) => `:${filterKey}_${i}`)})`);
        // NOTE: passing an array<number> as param not possible as it replaces values as strings
        filterValue.forEach((e, i) => params[`:${filterKey}_${i}`] = e);
      }

      // #<single-letter (a-zA-Z)>
      if (slRegex.test(filterKey)) {
        const letter = filterKey[1];
        wheres.push(`json_extract(json_each.value, '$[0]') = $letter
          AND json_extract(json_each.value, '$[1]')
          IN (${filterValue.map((_, i) => `:${letter}_${i}`)})`);
        params.$letter = letter;
        filterValue.forEach((e, i) => params[`:${letter}_${i}`] = e);
      }
    }
  }

  // since, until
  if (typeof filter.since == 'number') {
    wheres.push(`created_at >= $since`);
    params.$since = filter.since;
  }
  if (typeof filter.until == 'number') {
    wheres.push(`created_at <= $until`);
    params.$until = filter.until;
  }

  // NIP-50
  if (filter.search) {
    wheres.push(`events.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH $search ORDER BY rank)`);
    params.$search = filter.search.replace(/[^\w\s]|_/gi, " ");
  }

  let query = `SELECT events.id, pubkey, sig, kind, created_at, content, tags
      FROM events ${params.$letter ? ", json_each(tags)" : ''}
      WHERE ${wheres.join(' AND ')}  ${filter.search ? '' : 'ORDER BY created_at DESC'}`;

  // limit
  if (filter.limit) {
    query += ' limit $limit';
    params.$limit = filter.limit;
  }

  // ws.send(`${query} ---- ${JSON.stringify(params)}`);
  const events = db.query(query).all(params);

  for (const e of events) {
    ws.send(JSON.stringify(["EVENT", payload, _deserialize(e)]));
  }
  ws.send(JSON.stringify(["EOSE", payload]));
}

function _handleEvent(payload, ws) {
  try {
    const isValid = _validateEvent(payload);
    if (isValid) {
      const [query, params] = _serialize(payload);
      db.query(query).run(params);

      // keep file in local blossom
      const url = _getFirstTag(payload.tags, 'url');
      if (payload.kind === 1063 && url) {
        const x = _getFirstTag(payload.tags, 'x');
        fetch(url).then(file => Bun.write(join(blossomDir, x), file));
      }
    }
    ws.send(JSON.stringify(["OK", payload.id, isValid, ""]));
  } catch (e) {
    ws.send(JSON.stringify(["OK", payload.id, false, `error: ${e}`]));
  }
}

// 30063s and APK 1063s only accepted atm
const _validateEvent = (e) => {
  if (!validateEvent(e)) return false;
  if (e.kind == 1063) {
    return _getFirstTag(e.tags, 'm') == 'application/vnd.android.package-archive' && !!_getFirstTag(e.tags, 'x');
  }
  return e.kind == 30063;
};

const _getFirstTag = (tags, name) => tags.filter(t => t[0] == name)?.[0]?.[1];

function _serialize(obj) {
  const keys = Object.keys(obj);
  const values = Object.values(obj).map((v) => typeof v == 'object' ? JSON.stringify(v) : v);
  return [`INSERT INTO events (${keys.join(', ')}) VALUES (${keys.map(_ => '?')});`, values];
}

function _deserialize(obj) {
  obj.tags = JSON.parse(obj.tags);
  return obj;
}

console.log(`Listening on localhost:${server.port}`);
