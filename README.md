# bun-relay

A simple relay with NIP-50 full-text search, written in Javascript.

Also functions as a basic Blossom server.

### export

 - `sqlite3 relay.sqlite ".dump events" > dump.sql`

### import

 - `rm relay.sqlite*`
 - `bun setup.js`
 - remove create statement from dump.sql
 - `sqlite3 relay.sqlite < dump.sql`