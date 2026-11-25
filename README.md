# mera-news-pod

Mera News on your own machine. The pod keeps your news profile (the facts you give it and the topics made from them), reads the news for you on a schedule, and picks the stories that matter to your life, each with a short reason. A pick is a headline and a link to the publisher. The pod never summarises an article.

## The quickest way: Claude Desktop

For one person, the pod comes ready to run as the Mera News extension for Claude Desktop on macOS. Download `mera-news.mcpb` from the [plugins' latest release](https://github.com/Mera-News/mera-news-pod-plugins/releases/latest) and open it. Claude Desktop shows an install dialog that asks for your Mera News key (ask Mera Labs: message Mera on WhatsApp or write to contact@mera.news, and never paste the key into a chat) and whether to run the Mera News website (on by default). In Claude Code, add `Mera-News/mera-news-pod-plugins` as a plugin marketplace and install `mera-news`. The pod runs while the app is open, unless you turn on Keep running.

Then tell Claude about your life. Mera asks you to confirm each fact before it saves it. Ask Claude to "open Mera News" for the website: your Feed, the World's top stories, the stories you follow, and your profile and settings on You. See [connecting a client](docs/clients.md) for which apps work.

## How it works

You reach the pod through plugins: the MCP server for your AI app, the Mera News website, or one you write yourself.

The pod gets its news from a Mera News data server, which reads publishers' published RSS feeds. For picks made while you are away it uses an AI service you choose on the website, or any service with an OpenAI-compatible API, including one on your own machine. Without one, your assistant writes the topics and picks the news for you through the tools. Your profile stays on the machine that runs the pod. An AI service you choose sees your profile and the articles it scores.

This project is in development.

## Docs

- [Running your own pod](docs/self-hosting.md): the extension, or a pod you install yourself: set up, check, start, keep it running, update, back up.
- [Connecting a client](docs/clients.md): which AI apps work, the website, the MCP plugin and its token, and setups for Claude Code, Claude Desktop and claude.ai.
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
