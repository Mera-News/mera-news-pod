# Limits

## A read finds nothing

A pick must be published in the last 48 hours and rated at least 0.40 for relevance, on a scale where 0.40 and above means the story touches your life. A feed that publishes rarely, or a profile far from the day's news, gives no picks while `get_status` shows reading on. That is normal. Add more facts or wait for the next read.

The status also says when reading has not started yet: with no facts, with topics still being made, or before the first read has finished. Its `hint` says which.

## A data server may lack features

A self-hosted data server may not answer every question the pod can ask. At start the pod asks which ones it does answer, and `get_status` lists what is missing under `limits`. If the server will not say, all are listed.

What each one means when it is missing:

- `followed stories`: new reports on a story followed from a profile are found only when your topics match them.
- `place lookup`: a place in a fact is not looked up, so `add_facts` says local coverage may be weaker after you add where you live.
- `story grouping refresh`: reports the data server groups into one story after the pod has saved them stay separate picks.
- `windowed headlines` and `world headlines`: the Mera News app uses these for its World page. A pod does not use them today, so nothing changes.

Run a current `mera-news-data-server` to have all of them.


## Tests

The test fakes need the data server's schema. Set `MERA_DATA_SERVER_SCHEMA` to `apps/mera-server-news-api/src/schema.gql` in a `mera-news-data-server` checkout, or put that checkout next to this repository. `npm test` builds first.
