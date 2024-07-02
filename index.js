import { Database } from "bun:sqlite";
import { join, extname } from "bun:path";
import { validateEvent } from 'nostr-tools';
import { $ } from "bun";
import setup from './setup';

setup();

const db = new Database("relay.sqlite");
const blossomDir = Bun.env.BLOSSOM_DIR ?? '/tmp';

$.cwd(blossomDir);

// Keys uniquely identify a connection with `${wid}-${reqId}`,
// where `wid` is `ws.data.createdAt` and `reqId` the nostr request ID
const subIds = {};

const server = Bun.serve({
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
      return new Response('Welcome to relay.zap.store');
    }

    if (/^\/[0-9a-f]{64}(\.\S{1,}|$)/.test(pathname)) {
      const _filePath = await $`ls ${pathname.substring(0, 64)}*`.text();
      const filePath = _filePath.split('\n')[0];
      const file = Bun.file(join(blossomDir, filePath));

      if (['HEAD', 'GET'].includes(req.method)) {
        if (!await file.exists()) {
          return new Response(null, { status: 404, headers });
        }
        const _mimeType = await $`file -b --mime-type $FILE`.env({ FILE: filePath }).text();
        headers.append('Content-Type', _mimeType.trim());
        return new Response(req.method == 'GET' ? file : null, { status: 200, headers });
      }
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
      const [type, payload, filter] = parsed;
      switch (type) {
        case 'REQ': return _handleRequest(ws, payload, filter);
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

function _handleRequest(ws, reqId, filter) {
  try {
    const subId = ws && ws.data ? `${ws.data.createdAt}-${reqId}` : `${ws}-${reqId}`;
    const wheres = [];
    const params = {};
    var isLetterQuery = false;
    var beforeEose = false;

    if (!Object.keys(filter).every((k) => ['ids', 'authors', 'kinds', 'search', 'since', 'until', 'limit'].includes(k) || k.startsWith('#'))) {
      if (ws) {
        return ws.send(JSON.stringify(["NOTICE", `error: bad input`]));
      } else {
        throw 'bad input';
      }
    }

    // NOTE: for now excluding any requests unrelated to zap.store
    if (!filter.kinds || !filter.kinds.some(k => [1011, 1063, 30063, 32267, 30267].includes(k))) {
      if (ws) {
        server.publish(subId, JSON.stringify(["EOSE", reqId]));
        return;
      }
      return [];
    }

    // Set up subscription upon initial request (when ws is an object, not a string),
    // register filter in subIds
    if (ws && ws.data) {
      beforeEose = true;
      ws.subscribe(subId);
      subIds[subId] = filter;
    }

    for (const [filterKey, filterValue] of Object.entries(filter)) {
      if (Array.isArray(filterValue)) {
        // ids, authors, kinds
        if (filterMappings[filterKey]) {
          wheres.push(`${filterMappings[filterKey]} IN (${filterValue.map((_, i) => `$${filterKey}_${i}`)})`);
          // NOTE: passing an array<number> as param not possible as it replaces values as strings
          filterValue.forEach((e, i) => params[`$${filterKey}_${i}`] = e);
        }

        // #<single-letter (a-zA-Z)>
        if (slRegex.test(filterKey)) {
          const letter = filterKey[1];
          wheres.push(`t.value IN (${filterValue.map((_, i) => `$${letter}_${i}`)})`);
          filterValue.forEach((e, i) => params[`$${letter}_${i}`] = `${letter}:${e}`);
          isLetterQuery = true;
        }
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
    if (typeof filter.search == 'string') {
      wheres.push(`events.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH $search ORDER BY rank)`);
      params.$search = filter.search.replace(/[^\w\s]|_/gi, " ");
    }

    if (beforeEose && wheres.length == 0) {
      return server.publish(subId, JSON.stringify(["EOSE", reqId]));
    }

    let query = `SELECT events.id, pubkey, sig, kind, created_at, content, tags
      FROM events ${isLetterQuery ? "INNER JOIN tags_index as t ON t.fid = events.rowid" : ''}
      WHERE ${wheres.join(' AND ')} ${filter.search ? '' : 'ORDER BY created_at DESC'}`;

    // limit
    if (filter.limit) {
      query += ' limit $limit';
      params.$limit = filter.limit;
    }

    // server.publish(subId, `${query} ---- ${JSON.stringify(params)}`);
    const events = db.query(query).all(params);

    if (ws) {
      for (const e of events) {
        server.publish(subId, JSON.stringify(["EVENT", reqId, _deserialize(e)]));
      }

      if (beforeEose) {
        server.publish(subId, JSON.stringify(["EOSE", reqId]));
      }
    }

    // Remove ephemeral events after publishing
    const ephemeralIds = events.filter(e => e.kind >= 20000 && e.kind < 30000).map(e => e.id);
    if (ephemeralIds.length > 0) {
      db.query(`DELETE FROM events WHERE id IN (${ephemeralIds.map(() => '?')})`).run(ephemeralIds);
    }

    // Log request
    db.query(`INSERT INTO requests (payload) VALUES (?)`).run(JSON.stringify(filter));

    if (!ws) {
      return events.map(_deserialize);
    }

  } catch (e) {
    if (ws) {
      return ws.send(JSON.stringify(["NOTICE", `error: ${e}`]));
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
            const [wid, ...parts] = subId.split('-');
            const reqId = parts.join('-');
            const filter = subIds[subId];

            // The trick here is reusing _handleRequest with a modified filter
            // (we re-pass the original filter but limited to this new ID)
            const updateFilter = { ...filter, ids: [payload.id] };
            _handleRequest(wid, reqId, updateFilter);
          }
        }

        if (payload.kind === 1063) {
          _saveInBlossom(payload);
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
  if (!validateEvent(e)) return false;
  // for now, hardcoded zapstore public keys
  return ['78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'c86eda2daae768374526bc54903f388d9a866c00740ec8db418d7ef2dca77b5b'].includes(e.pubkey);
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

async function _saveInBlossom(payload) {
  const url = _getFirstTag(payload.tags, 'url');
  if (url) {
    const x = _getFirstTag(payload.tags, 'x');
    const ext = extname(url);

    const response = await fetch(url);
    const name = join(blossomDir, `${x}${ext}`);
    await Bun.write(name, response);
    const [computedHash, newName] = await _renameToHash(name);

    if (x !== computedHash) {
      // If hash doesn't match, remove garbage
      db.query(`DELETE FROM events WHERE id = $id`).run({ $id: payload.id });
      await $`rm $NAME'`.env({ NAME: newName }).quiet();
    }
  }
}

const _renameToHash = async (name) => {
  const ext = extname(name);
  const hash = await $`cat $NAME | shasum -a 256 | head -c 64`.env({ NAME: name }).text();
  const hashName = `${hash}${ext}`;
  await $`mv $SRC $DEST`.env({ SRC: name, DEST: hashName }).quiet();
  return [hash, hashName];
};

console.log(`Listening on localhost:${server.port} and blossom mounted on: ${blossomDir}`);
