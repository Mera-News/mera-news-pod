// WatermelonDB's Node driver requires 'better-sqlite3'. This package answers that name with the
// node:sqlite driver the client ships, so the pod needs no native module.
module.exports = require('mera-news-client/node/sqlite-driver');
