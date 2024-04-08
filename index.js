import { Database } from "bun:sqlite";
import { join, extname } from "bun:path";
import { validateEvent } from 'nostr-tools';
import { $ } from "bun";

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
      // upgrade connection for ws
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

    if (/\/^[0-9a-f]{64}(\.\S{1,}|$)/.test(pathname)) {
      const actualPath = await $`ls ${pathname.substring(0, 64)}*'`.text();
      const file = Bun.file(join(blossomDir, actualPath.trim()));

      if (['HEAD', 'GET'].includes(req.method)) {
        const exists = await file.exists();
        const _mimeType = await $`file -b --mime-type $FILE`.env({ FILE: actualPath.trim() }).text();
        headers.append('Content-Type', _mimeType.trim());
        return new Response(req.method == 'GET' ? file : null, { status: exists ? 200 : 404, headers });
      }
    } else {
      return Response('Not found', { status: 404 });
    }
  },

  websocket: {
    async message(ws, message) {
      const [type, payload, filter] = JSON.parse(message);
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
  const subId = ws.data ? `${ws.data.createdAt}-${reqId}` : `${ws}-${reqId}`;
  const wheres = [];
  const params = {};

  // Set up subscription upon initial request (when ws is an object, not a string),
  // register filter in subIds
  if (ws.data) {
    ws.subscribe(subId);
    subIds[subId] = filter;
  }

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

  // Do not EOSE during updates (!ws.data)
  if (ws.data && wheres.length == 0) {
    return server.publish(subId, JSON.stringify(["EOSE", reqId]));
  }

  let query = `SELECT events.id, pubkey, sig, kind, created_at, content, tags
      FROM events ${params.$letter ? ", json_each(tags)" : ''}
      WHERE ${wheres.join(' AND ')}  ${filter.search ? '' : 'ORDER BY created_at DESC'}`;

  // limit
  if (filter.limit) {
    query += ' limit $limit';
    params.$limit = filter.limit;
  }

  // server.publish(subId, `${query} ---- ${JSON.stringify(params)}`);
  const events = db.query(query).all(params);

  for (const e of events) {
    server.publish(subId, JSON.stringify(["EVENT", reqId, _deserialize(e)]));
  }

  // Do not EOSE during updates (!ws.data)
  if (ws.data) {
    server.publish(subId, JSON.stringify(["EOSE", reqId]));
  }
}

async function _handleEvent(ws, payload) {
  try {
    const isValid = _validateEvent(payload);
    if (isValid) {
      const existsQuery = `SELECT EXISTS(SELECT 1 from events where id = $id) as result;`;
      const exists = db.query(existsQuery).get({ $id: payload.id });

      if (exists.result) {
        return ws.send(JSON.stringify(["OK", payload.id, false, "duplicate"]));
      } else {
        const [query, params] = _serialize(payload);
        db.query(query).run(params);

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
          await Bun.sleep(5); // wait 5ms betwen requests
        }

        _saveInBlossom(payload);
      }
    } else {
      ws.send(JSON.stringify(["OK", payload.id, false, `invalid: not accepted`]));
    }
  } catch (e) {
    ws.send(JSON.stringify(["OK", payload.id, false, `error: ${e}`]));
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

// 30063s and APK 1063s only accepted atm
const _validateEvent = (e) => {
  if (!validateEvent(e)) return false;
  if (e.kind == 1063) {
    return ['application/vnd.android.package-archive', 'application/pwa+zip'].includes(_getFirstTag(e.tags, 'm'))
      && !!_getFirstTag(e.tags, 'x');
  }
  return e.kind == 30063;
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
  if (payload.kind === 1063 && url) {
    const x = _getFirstTag(payload.tags, 'x');
    const ext = extname(url);

    const response = await fetch(url);
    const name = join(blossomDir, `${x}${ext}`);
    await Bun.write(name, response);
    const [computedHash, newName] = _renameToHash(name);

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
