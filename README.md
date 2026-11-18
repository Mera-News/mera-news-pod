# mera-news-pod

Mera News on your own machine. The pod keeps your news profile (the facts you give it and the topics made from them), reads the news for you on a schedule, and picks the stories that matter to your life, each with a short reason.

You reach the pod through plugins. The first one lets an MCP client set up your profile and ask for new picks.

The pod gets its news from a Mera News data server you run, and uses any AI service with an OpenAI-compatible API, including one on your own machine. Your profile stays on the machine that runs the pod. The AI service you choose sees your profile and the articles it scores.

This project is in development.

## Docs

- [Running your own pod](docs/self-hosting.md): install, set up, check, start, keep it running, update, back up.
- [Connecting a client](docs/clients.md): the MCP plugin, the token, and setups for Claude Code, Claude Desktop, claude.ai and ChatGPT.
- [Pairing the Mera News app](docs/sync.md): pairing, HTTPS, several phones, what a phone can do.
- [Privacy](docs/privacy.md): where information goes.
- [Choosing a model](docs/models.md) and [changing the prompts](docs/harness.md).
- [Limits](docs/limits.md): why a read can find nothing, and what a data server may lack.

## License

Copyright Mera Labs B.V. Licensed under the [AGPL-3.0-only](LICENSE). See [TRADEMARK.md](TRADEMARK.md) for the use of the Mera names and [COMMERCIAL.md](COMMERCIAL.md) for a commercial license.
