# mera-news-pod

Mera News on your own machine. The pod keeps your news profile (the facts you give it and the topics made from them), reads the news for you on a schedule, and picks the stories that matter to your life, each with a short reason.

You reach the pod through plugins: an MCP server for your AI tools, a local page, or one you write yourself.

The pod gets its news from a Mera News data server you run, and uses any AI service with an OpenAI-compatible API, including one on your own machine. Your profile stays on the machine that runs the pod. The AI service you choose sees your profile and the articles it scores.

This project is in development.

## Docs

- [Running your own pod](docs/self-hosting.md): install, set up, check, start, keep it running, update, back up.
- [Connecting a client](docs/clients.md): the MCP plugin, the token, and setups for Claude Code, Claude Desktop and claude.ai.
- [Writing a plugin](docs/plugins.md): build your own page, tool or app on top of the pod, starting from the starter plugin.
- [Pairing the Mera News app](docs/sync.md): not available yet.
- [Privacy](docs/privacy.md): where information goes.
- [Choosing a model](docs/models.md) and [changing the prompts](docs/harness.md).
- [Limits](docs/limits.md): why a read can find nothing, and what a data server may lack.

## Licence

Copyright Mera Labs B.V.

Required Notice: Copyright Mera Labs B.V. (https://mera.news)

This code is source-available under the PolyForm Shield License 1.0.0. See `LICENSE`.

In short: you may run it, change it and build on it for any purpose, except to provide a product
that competes with this software or with a product Mera Labs provides using it, such as Mera News.
This summary is not the licence. The `LICENSE` file is.

Mera News and Mera Protocol are trademarks. See `TRADEMARK.md`.
For a use the licence does not allow, see `COMMERCIAL.md`.
To contribute, see `CONTRIBUTING.md`.
