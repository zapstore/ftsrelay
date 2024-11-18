import { Database } from 'bun:sqlite';
import { join, extname } from 'bun:path';
import { verifyEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { $ } from 'bun';
import setup from './setup';

setup();

const db = new Database('relay.sqlite');
const blossomDir = Bun.env.BLOSSOM_DIR ?? '/tmp';

$.cwd(blossomDir);

const authorized = await Bun.file('./authorized.json').json();

// Keys uniquely identify a connection with `${wid}-${reqId}`,
// where `wid` is `ws.data.createdAt` and `reqId` the nostr request ID
const subIds = {};

const server = Bun.serve({
  maxRequestBodySize: 1024 * 1024 * 300,
  async fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization,*',
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE'
    });

    if (pathname === '/') {
      // REST API
      if (req.method == 'POST' && req.headers.get('content-type').startsWith('application/json')) {
        const body = await req.json();
        if (body.id && body.sig) {
          try {
            await _handleEvent(null, body);
            return new Response(null, { status: 204 });
          } catch (e) {
            return new Response(`Error: ${e}`, { status: e.toString().startsWith('bad input') ? 400 : 500 });
          }
        } else {
          try {
            const res = _handleRequest(null, '', body);
            return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } });
          } catch (e) {
            return new Response(`Error: ${e}`, { status: e == 'bad input' ? 400 : 500 });
          }
        }
      }

      // Upgrade connection for ws
      server.upgrade(req, {
        data: {
          createdAt: Date.now()
        }
      });
      // TODO NIP-11
      // see curl -i -H 'Accept: application/nostr+json' https://relay.damus.io
      // return new Response(Bun.file("./nip11.json"));
      return new Response('Welcome to relay.zapstore.dev');
    }

    // TODO: Require blossom authorization event
    if (pathname == '/upload' && req.method == 'POST') {
      const body = req.body;
      const filename = req.headers.get("X-Filename") || `${Date.now()}-tmp`;
      const temp = join(blossomDir, filename);
      const writer = Bun.file(temp).writer();
      for await (const chunk of body) {
        writer.write(chunk);
      }
      await writer.close();
      const uploaded = Math.floor(Date.now() / 1000);
      const _size = await $`wc -c < $FILE`.env({ FILE: temp }).text();
      const [sha256, name] = await _renameToHash(temp);
      return Response.json({
        url: `https://cdn.zapstore.dev/${name}`,
        sha256,
        size: +_size.trim(),
        type: req.headers.get("Content-Type"),
        uploaded,
      });
    }

    if (['HEAD', 'GET'].includes(req.method) && /^\/[0-9a-f]{64}(\.\S{1,}|$)/.test(pathname)) {
      let filePath;
      try {
        // Pathname starts with / , so do 1-65
        const hash = pathname.substring(1, 65);
        const _filePath = await $`ls ${hash}*`.text();
        filePath = _filePath.split('\n')[0].trim();
      } catch (_) {
        return new Response(null, { status: 404, headers });
      }

      const file = Bun.file(join(blossomDir, filePath));
      const _mimeType = await $`file -b --mime-type $FILE`.env({ FILE: filePath }).text();
      headers.append('Content-Type', _mimeType.trim());
      return new Response(req.method == 'GET' ? file : null, { status: 200, headers });
    } else {
      return Response('Not found', { status: 404 });
    }
  },

  websocket: {
    async message(ws, message) {
      let parsed;
      if (!message) {
        return ws.send(JSON.stringify(["NOTICE", `error: empty message`]));
      }
      try {
        parsed = JSON.parse(message);
      } catch (e) {
        console.error(`Error parsing ${message}`);
        return ws.send(JSON.stringify(["NOTICE", `error: ${e}`]));
      }
      if (!Array.isArray(parsed)) {
        return ws.send(JSON.stringify(["NOTICE", `error: please do not send garbage`]));
      }
      const [type, payload, ...filters] = parsed;
      switch (type) {
        case 'REQ': return _handleRequest(ws, payload, filters);
        case 'EVENT': return _handleEvent(ws, payload);
        case 'CLOSE': return _handleClose(ws, payload);
        default: return _handleError(ws, type);
      }
    },
    async close(ws) {
      // When socket is closed, remove all it reqId subscriptions
      for (const subId of Object.keys(subIds)) {
        if (subId.startsWith(ws.data.createdAt)) {
          delete subIds[subId];
        }
      }
    },
    // Necessary to send data back to the socket when using server.publish!
    publishToSelf: true,
  },
});

const filterMappings = { ids: 'id', authors: 'pubkey', kinds: 'kind' };
const slRegex = /^#[A-Za-z]$/;

function _handleRequest(ws, reqId, filters, existingSubId) {
  try {
    // Validations
    for (const filter of filters) {
      // NOTE: for now excluding any requests unrelated to Zapstore
      if (!filter.kinds || !filter.kinds.some(k => [1011, 1063, 30063, 32267, 30267].includes(k))) {
        if (ws) {
          return ws.send(JSON.stringify(["CLOSED", reqId, '']));
        }
        return [];
      }
    }

    const subId = existingSubId ?? (ws && ws.data ? `${ws.data.createdAt}-${reqId}` : `${ws}-${reqId}`);
    const events = [];
    var beforeEose = false;

    // Set up subscription upon initial request (when ws is an object, not a string),
    // register filters in subIds
    if (ws && ws.data && !existingSubId) {
      beforeEose = true;

      ws.subscribe(subId);
      subIds[subId] = filters;
      if (filters.length == 0) {
        return server.publish(subId, JSON.stringify(["EOSE", reqId]));
      }
    }

    // Queries
    for (const filter of filters) {
      const wheres = [];
      const params = {};

      for (const [filterKey, filterValue] of Object.entries(filter)) {
        // ids, authors, kinds
        if (filterMappings[filterKey]) {
          wheres.push(`${filterMappings[filterKey]} IN (${filterValue.map((_, i) => `$${filterKey}_${i}`)})`);
          // NOTE: passing an array<number> as param not possible as it replaces values as strings
          filterValue.forEach((e, i) => params[`$${filterKey}_${i}`] = e);
        }

        // #<single-letter (a-zA-Z)>
        const subqueries = [];
        if (slRegex.test(filterKey)) {
          const letter = filterKey[1];
          subqueries.push(`SELECT fid FROM tags_index WHERE value IN (${filterValue.map((_, i) => `$${letter}_${i}`)})`);
          filterValue.forEach((e, i) => params[`$${letter}_${i}`] = `${letter}:${e}`);
        }
        if (subqueries.length > 0) {
          wheres.push(`rowid IN (${subqueries.join(' INTERSECT ')})`);
        }
      }

      if (typeof filter.since == 'number') {
        wheres.push(`created_at >= $since`);
        params.$since = filter.since;
      }
      if (typeof filter.until == 'number') {
        wheres.push(`created_at <= $until`);
        params.$until = filter.until;
      }

      // NIP-50
      if (Array.isArray(filter.search) && filter.search.length === 1) {
        filter.search = filter.search[0];
      }
      if (typeof filter.search == 'string') {
        if (filter.search.length == 2) {
          wheres.push(`events.tags like $name_search`);
          params.$name_search = `%["name","${filter.search}"]%`;
        } else {
          wheres.push(`events.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH $search ORDER BY rank)`);
          params.$search = filter.search.replace(/[^\w\s]|_/gi, " ");
        }
      }

      let query = `SELECT events.id, pubkey, sig, kind, created_at, content, tags
        FROM events WHERE ${wheres.join(' AND ')} ${filter.search ? '' : 'ORDER BY created_at DESC'}`;

      // limit
      if (filter.limit) {
        query += ' limit $limit';
        params.$limit = filter.limit;
      }

      // console.log(subId, `${query} ---- ${JSON.stringify(params)}`);
      const results = db.query(query).all(params);
      events.push(...results);

      console.log('Query', Object.keys(filter));
    }

    // Remove ephemeral events after publishing
    const ephemeralIds = events.filter(e => e.kind >= 20000 && e.kind < 30000).map(e => e.id);
    if (ephemeralIds.length > 0) {
      db.query(`DELETE FROM events WHERE id IN (${ephemeralIds.map(() => '?')})`).run(ephemeralIds);
    }

    // Response
    if (ws) {
      for (const e of events) {
        server.publish(subId, JSON.stringify(["EVENT", reqId, _deserialize(e)]));
      }

      if (beforeEose && !existingSubId) {
        server.publish(subId, JSON.stringify(["EOSE", reqId]));
      }
    } else {
      return events.map(_deserialize);
    }

  } catch (e) {
    if (ws) {
      return ws.send(JSON.stringify(["CLOSED", reqId, `error: ${e}`]));
    }
    throw e;
  }
}

async function _handleEvent(ws, payload) {
  try {
    const isValid = _validateEvent(payload);
    if (isValid) {
      const existsQuery = `SELECT EXISTS(SELECT 1 FROM events WHERE id = $id) as result`;
      const exists = db.query(existsQuery).get({ $id: payload.id });

      if (exists.result) {
        if (ws) {
          ws.send(JSON.stringify(["OK", payload.id, false, "duplicate"]));
        }
        return;
      } else {
        const n = payload.kind;
        const parameterizable = n >= 30000 && n < 40000;
        var idToRemove;

        if (n === 0 || n == 3 || (n >= 10000 && n < 20000) || parameterizable) {
          var idQuery = `SELECT id FROM events WHERE pubkey = $pubkey AND kind = $kind`;
          if (parameterizable) {
            idQuery = 'SELECT id FROM events INNER JOIN tags_index as t ON t.fid = events.rowid WHERE pubkey = $pubkey AND kind = $kind AND t.value = $d';
          }
          const dTag = _getFirstTag(payload.tags, 'd');
          const result = db.query(idQuery).get({ $pubkey: payload.pubkey, $kind: n, $d: `d:${dTag}` });
          idToRemove = result && result.id;
        }

        const [query, params] = _serialize(payload);
        if (idToRemove) {
          db.query('BEGIN').run();
        }
        db.query(query).run(params);
        if (idToRemove) {
          db.query('DELETE FROM events WHERE id = $id').run({ $id: idToRemove });
          db.query('COMMIT').run();
        }

        if (ws) {
          ws.send(JSON.stringify(["OK", payload.id, isValid, ""]));

          // For every new inserted event, notify all sockets with active requests
          for (const subId of Object.keys(subIds)) {
            const [_, ...parts] = subId.split('-');
            const reqId = parts.join('-');
            const filters = subIds[subId];

            // The trick here is reusing _handleRequest with modified filters
            // (we re-pass the original filters but limited to this new ID)

            const updatedFilters = filters.map(f => ({ ...f, ids: [payload.id] }));

            _handleRequest(ws, reqId, updatedFilters, subId);
          }
        }
      }
    } else {
      if (ws) {
        return ws.send(JSON.stringify(["OK", payload.id, false, `invalid: not accepted`]));
      }
      throw 'bad input (or your pubkey is restricted)';
    }
  } catch (e) {
    if (ws) {
      ws.send(JSON.stringify(["OK", payload.id, false, `error: ${e}`]));
    }
    throw e;
  }
}

function _handleClose(ws, reqId) {
  const subId = `${ws.data.createdAt}-${reqId}`;
  delete subIds[subId];
  ws.send(JSON.stringify(["CLOSED", reqId]));
}

function _handleError(ws, type) {
  ws.send(JSON.stringify(["NOTICE", `error: wtf you mean by ${type}`]));
}

const _validateEvent = (e) => {
  if (!verifyEvent(e)) return false;
  const npub = nip19.npubEncode(e.pubkey);
  const dTag = _getFirstTag(e.tags, 'd');

  if (authorized[npub] === undefined) {
    return false;
  }

  if (authorized[npub].length === 0) {
    return true;
  }

  if (e.kind == 30063) {
    return authorized[npub].length > 0 && authorized[npub].some((id) => dTag.startsWith(id));
  } else if (e.kind == 32267) {
    return authorized[npub].length > 0 && authorized[npub].some((id) => id == dTag);
  } else {
    return true;
  }
};

const _getFirstTag = (tags, name) => tags.find(t => t[0] == name)?.[1];

function _serialize(obj) {
  const keys = Object.keys(obj);
  const values = Object.values(obj).map((v) => typeof v == 'object' ? JSON.stringify(v) : v);
  return [`INSERT INTO events (${keys.join(', ')}) VALUES (${keys.map(_ => '?')});`, values];
}

function _deserialize(obj) {
  obj.tags = JSON.parse(obj.tags);
  return obj;
}

const _renameToHash = async (name) => {
  const ext = extname(name);
  const hash = await $`cat $NAME | shasum -a 256 | head -c 64`.env({ NAME: name }).text();
  const hashName = `${hash}${ext}`;
  await $`mv $SRC $DEST`.env({ SRC: name, DEST: hashName }).quiet();
  return [hash, hashName];
};

console.log(`Listening on localhost:${server.port} and blossom mounted on: ${blossomDir}`);
