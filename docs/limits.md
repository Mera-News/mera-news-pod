# Limits

## A read finds nothing

A pick must be published in the last 48 hours and rated at least 0.40 for relevance, on a scale where 0.40 and above means the story touches your life. A feed that publishes rarely, or a profile far from the day's news, gives no picks while `get_status` shows reading on. That is normal. Add more facts or wait for the next read.

The status also says when reading has not started yet: with no facts, with topics still being made, or before the first read has finished. Its `hint` says which.

## A data server may lack features

A data server may not answer every question the pod can ask. At start the pod asks which ones it does answer, and `get_status` lists what is missing under `limits`. If the server will not say, all are listed.

A current `mera-news-data-server` lacks one:

- `world headlines`: the Mera News app uses it for its World page. A pod does not use it, so nothing changes.

A current data server answers place lookups, but it holds no places until they are loaded. Until then `get_status` lists `places_not_loaded` under `problems`, and `add_facts` says local coverage may be weaker after you add where you live. Load them with `npm run seed-places` in the data server (its README says which file to download), then restart the pod.

An older data server can also lack these. Update it to have them:

- `place lookup`: a place in a fact is not looked up, so `add_facts` says local coverage may be weaker after you add where you live.
- `followed stories`: new reports on a story followed from a profile are found only when your topics match them.
- `story grouping refresh`: reports the data server groups into one story after the pod has saved them stay separate picks.
- `windowed headlines`: headlines cannot be ranked by the last 6, 12 or 48 hours. A pod does not use this.

## Tests

The test fakes need the data server's schema. Set `MERA_DATA_SERVER_SCHEMA` to `apps/mera-server-news-api/src/schema.gql` in a `mera-news-data-server` checkout, or put that checkout next to this repository. `npm test` builds first.
