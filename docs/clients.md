# Connecting a client

## Which AI apps work

| App | State | How |
|---|---|---|
| Claude Desktop (Chat tab) | Tested by Mera Labs | The Mera News extension, below |
| Claude Code | Tested by Mera Labs | The Mera News plugin, below |
| ChatGPT | Not supported | It needs a public HTTPS connector with OAuth. The pod runs on your computer with a token, so there is no easy way today. |
| Grok | Built, not tested by Mera Labs | `.grok-plugin/plugin.json` in the plugin folder |
| Codex and apps that read OpenAI's plugin format | Built, not tested by Mera Labs | `plugin.json` and `.agents/plugins/marketplace.json` |
| OpenClaw | Built, not tested by Mera Labs | The Claude plugin from the same marketplace |
| Any other MCP client | Works with the token | The stdio bridge or Streamable HTTP, below |

If you try one of the untested apps, open an issue in [mera-news-pod-plugins](https://github.com/Mera-News/mera-news-pod-plugins/issues) with what you find.

## The Mera News plugin

The plugin is the pod, the MCP plugin and the website in one program that your AI app starts and stops. It needs no clone and no terminal. It writes `~/.mera-news-pod/pod.json` on its first run, pointed at Mera News (`https://api.mera.news`) or at the news server in its "News server address" setting, and connects to a pod already running for that folder instead of starting another. The pod runs while the app is open, unless you turn on Keep running (see [running your own pod](self-hosting.md#from-the-mera-news-plugin-on-macos)).

- **Claude Desktop on macOS:** download `mera-news.mcpb` from the [plugins' latest release](https://github.com/Mera-News/mera-news-pod-plugins/releases/latest) and open it. Claude Desktop shows an install dialog with the settings below. It keeps the key in the system's secure store. The tools work in the Chat tab.
- **Claude Code:** `/plugin marketplace add Mera-News/mera-news-pod-plugins`, then `/plugin install mera-news@mera-news`. The repository's `.claude-plugin/marketplace.json` lists the plugin. It asks for the same settings.
- **Grok, Codex, OpenClaw:** add `Mera-News/mera-news-pod-plugins` as a marketplace in the app, then install `mera-news`. Put a key in `~/.mera-news-pod/secrets.json` as `{ "dataApiKey": "<your key>" }`, then run `chmod 600 ~/.mera-news-pod/secrets.json`; the pod refuses the file otherwise. For your own news server, set `dataServer.url` in `~/.mera-news-pod/pod.json`, which the plugin writes on its first run. These follow each app's published plugin format and are not tested by Mera Labs.

The settings, where the first two decide where the news comes from:

| Setting | Meaning |
|---|---|
| News key | Optional. For Mera News, a key from the form at https://mera.news/en/api-key, sent by email: it is a test key, 2,000 requests a day, for your own use, and it may be turned off without notice. Never paste it into a chat. For your own news server, the key you set on it (`MERA_NEWS_API_KEY`), or nothing for the one-computer setup. The server setup refuses search in open mode, so give the pod a key there. |
| News server address | Optional. Empty uses Mera News. An address, such as `http://127.0.0.1:3002`, uses a [news data server](https://github.com/Mera-News/mera-news-data-server/blob/main/docs/self-host.md) you run, with no key from Mera Labs. A later change applies the next time the app starts. |
| Also run the Mera News website on this computer | On by default. |

Your assistant adds facts as you talk to it, and asks you to confirm each one before it saves it. The website has no box for adding a fact; you review each fact's topics on its You tab.

## The Mera News website

The website is how you see your news. The MCP plugin only hands data to your assistant. The website runs inside the pod on `127.0.0.1`. Ask your assistant to "open Mera News" (the `open_news_site` tool gives a link that works once, for 10 minutes), or run `npx mera-news-pod-web link` in the `mera-news-pod-plugins` folder.

- **Feed:** one lane per fact, each loading and scrolling on its own. It shows the picks and the stories left out, each with its reason and level, and the totals at the top.
- **World:** the top stories by country, each with its full coverage.
- **Following:** the stories you follow and their timelines.
- **You:** your facts and their topics, your digest times, the AI service, Mera News on this computer, Appearance (light, dark or system), Keep running, Your phone, and Sign out.

A headline opens the article page with the story's other reports. Read on the publisher's site from there. Every headline shows in English, marked as translated when it is, with the original under it. Open tabs stay signed in when the pod restarts; Sign out on You ends every one.

**On your phone:** reach the same website through [Tailscale](https://tailscale.com) (`tailscale serve`) or another HTTPS tunnel, and pair the phone with the QR code under You > Your phone. The website itself listens on `127.0.0.1` only. A phone cannot change the AI service.

**Your digest:** tell your assistant when you want your news, any number of times a day. Two or three suit most people. A digest missed while the app was closed runs once when it opens.

## A pod you run yourself

The pod serves an MCP client through the `mcp` plugin, which lives in the `mera-news-pod-plugins` repository, in `packages/mcp`. Build it once:

```
git clone https://github.com/Mera-News/mera-news-pod-plugins
cd mera-news-pod-plugins
npm install
npm run build
```

Then name it in `pod.json`, by the path of the package:

```json
"plugins": [
  { "package": "/home/you/mera-news-pod-plugins/packages/mcp", "config": {} }
]
```

Restart the pod. `node build/cli.js check` prints the plugin's address. Plugins run inside the pod with its full access to your profile, so only run ones you trust.

For the website, add `packages/web` from the same checkout the same way, after `mcp`. Then `npx mera-news-pod-web link` prints a link that opens it in one browser tab and works once, for 10 minutes. Add `--home <folder>` when the pod does not use the default home.

## Plugin settings

All optional, inside `config`:

| Key | Default | Meaning |
|---|---|---|
| `port` | 8787 | The port to listen on. |
| `host` | `127.0.0.1` | The interface to listen on. |
| `publicHost` | none | The name a remote client reaches the pod at, such as `pod.example.com`. Requests for any other name than localhost are refused until it is set. |
| `capabilityUrl` | off | Turns on the address with the token in it, see below. |

The address is `http://127.0.0.1:8787/mcp`.

## The token

Every request needs a token. The pod never prints it. It is in `~/.mera-news-pod/data/plugins/mcp/token`, made on first start, readable by you only. Run the commands below in the `mera-news-pod-plugins` folder.

- `npx mera-news-pod-mcp token --rotate` makes a new token and prints it once. The old one stops working at once.
- Add `--home <folder>` when the pod does not use the default home.

## Which setups have been run

Mera Labs runs the Mera News extension in Claude Desktop's Chat tab and the plugin in Claude Code. The pod's own tests drive the MCP plugin with an MCP client over Streamable HTTP and the bearer token, the way the Claude Code setup below connects, and run the stdio bridge against a test server. A client with the right token connects and lists the tools; a missing or wrong token gets 401. The hand setups below follow each client's current documentation; the claude.ai connector has not been run against a pod yet.

## Claude Code

```
claude mcp add --transport http mera http://127.0.0.1:8787/mcp --header "Authorization: Bearer $(cat ~/.mera-news-pod/data/plugins/mcp/token)"
```

Or in `.mcp.json`, which Claude Code expands `${MERA_POD_TOKEN}` in:

```json
{
  "mcpServers": {
    "mera": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${MERA_POD_TOKEN}" }
    }
  }
}
```

with `MERA_POD_TOKEN` set to the token.


## Claude Desktop, pod on the same machine

Claude Desktop starts local servers as commands, so it goes through a small bridge that reads the token and forwards to the running pod. Open Settings, then Developer, then Edit Config, and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mera": {
      "command": "/usr/local/bin/node",
      "args": ["/home/you/mera-news-pod-plugins/packages/mcp/build/bin/cli.js", "bridge", "--url", "http://127.0.0.1:8787/mcp"]
    }
  }
}
```

Use full paths: your own `node` (`which node` prints it) and your checkout. Add `"--home", "<folder>"` to `args` when the pod does not use the default home. Quit and reopen Claude Desktop after the edit. The pod must be running.

## A remote pod

A connector in claude.ai is called from the vendor's servers, so the pod must be reachable at a public HTTPS address that you provide, for example through your own tunnel. Tell the plugin that name:

```json
{ "publicHost": "pod.example.com" }
```

### claude.ai

Add a custom connector (Customize, then Connectors, then Add custom connector) with the address `https://pod.example.com/mcp`. Choose no sign in, and under request headers add `Authorization` with the value `Bearer <token>`.

### ChatGPT

ChatGPT is not supported yet. It connects to custom servers with OAuth, and the pod offers no OAuth sign in.

### The capability address

For a client that can send neither a header nor OAuth, the plugin can serve the token as part of the address. Turn it on in the plugin's config:

```json
{ "capabilityUrl": true, "publicHost": "pod.example.com" }
```

Print the address in the `mera-news-pod-plugins` folder with:

```
npx mera-news-pod-mcp url --base https://pod.example.com
```

It looks like `https://pod.example.com/mcp/<token>`. Anyone who holds that address can read your profile and change it, because the address is the token. That is why it is off by default. Keep it out of chat and screenshots, and run `npx mera-news-pod-mcp token --rotate` if it leaks.

## What the assistant can do

`get_profile`, `add_facts`, `remove_facts`, `edit_topics`, `get_suggestions`, `news_for_profile`, `rate_stories`, `top_stories`, `search_news`, `latest_news`, `get_status`, `set_reading`, `digest_done` and `open_news_site`. `search_news` and `latest_news` read the stored news directly, so they work without an AI service and without waiting for picks. Without an AI service the pod makes no picks of its own: your assistant writes the topics for each fact, reads `news_for_profile` and saves a verdict on each story with `rate_stories`. Its picks reach the website and your notifications like the pod's own. There are also two prompts: `set_up_profile`, which interviews you and saves the answers as facts, and `daily_digest`, which shows new picks by level.

A pick is a headline, a link out and a one-line reason. The pod never returns a summary or the article text. The server asks your AI app to send you to the publisher's site to read each article, and never to fetch, copy or summarise it there, since that may breach the publisher's copyright.
