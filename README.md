# relay.zap.store

WIP

### export

 - `sqlite3 relay.sqlite ".dump events" > dump.sql`

### import

 - `rm relay.sqlite*`
 - `bun setup.js`
 - remove create statement from dump.sql
 - `sqlite3 relay.sqlite < dump.sql`