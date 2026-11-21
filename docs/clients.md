# Connecting a client

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

## Which setups we have run

The pod's own tests drive the plugin with an MCP client over Streamable HTTP and the bearer token, the way the Claude Code setup below connects, and run the stdio bridge against a test server. A client with the right token connects and lists the seven tools; a missing or wrong token gets 401. The client setups below follow each client's current documentation and have not been run against a pod yet.

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

`get_profile`, `add_facts`, `remove_facts`, `edit_topics`, `get_suggestions`, `get_status` and `set_reading`. There are also two prompts: `set_up_profile`, which interviews you and saves the answers as facts, and `daily_digest`, which shows new picks by level.

A pick is a headline, a link out and a one-line reason. The pod never returns a summary or the article text. The server asks your AI app to send you to the publisher's site to read each article, and never to fetch, copy or summarise it there, since that may breach the publisher's copyright.
