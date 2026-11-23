# Writing a plugin

A plugin is a Node module the pod loads into its own process. It gets your profile, your picks and the pod's reading state, and serves them however you like: a page in your browser, a tool for your own AI app, a bot, a feed reader. The pod's own MCP server is a plugin too.

Plugins you write are yours. Share them as you like.

## Start from the starter

The quickest start is to copy the `starter` package from [mera-news-pod-plugins](https://github.com/Mera-News/mera-news-pod-plugins/tree/main/packages/starter). It is one file. It serves a local page that lists your picks, and three JSON routes (`/picks`, `/profile`, `/status`) behind a token file, on `127.0.0.1` only. Read it top to bottom, then change it.

## Publishers' content

Each pick links to an article on its publisher's site, and `/picks` returns that link as `url`. Show the headline and the link, and send the reader to the publisher's site. Do not fetch, scrape, copy or summarise article text from a publisher's site: that may breach the publisher's copyright. A plugin that helps readers subscribe to publishers they value is welcome.

## What a plugin exports

```js
exports.podApi = 2;          // the plugin API version it speaks: 1 or 2
exports.name = 'my-plugin';  // lower case letters, digits and dashes, starting with a letter
exports.createPlugin = (ctx) => ({
  async start() {},          // open whatever you serve
  async stop() {},           // close it again
  describe() { return []; }, // optional: lines that mera-news-pod check prints, such as your address
});
```

`name` must be unique among your plugins: it names the plugin's own folder, `<home>/data/plugins/<name>`.

## What a plugin is given

`ctx` holds:

- `config`: the plugin's own section of `pod.json`, as written.
- `dataDir`: a folder only this plugin writes. Keep tokens and state here.
- `log`: `debug`, `info`, `warn` and `error`, each taking a message. They go to the pod's log, so never log a token or a key.
- `estimateTokens(text)`: the token estimate the pod uses for its own prompts, for keeping replies within a client's limit.
- `services`: what the pod offers, below.
- `meraNewsApp`: the Mera News app notifier's origin, or `null` (version 2 only). That notifier is not available yet.

The types are in `mera-news-pod/plugin-api`. Import types only: a plugin never imports the pod's code.

## The services

| Service | What it does |
|---|---|
| `profile` | `get({ offset })` pages through the saved facts and their topics. `addFacts`, `removeFacts` and `editTopics` change them. |
| `suggestions` | `get({ since, limit, peek })` returns picks, oldest first, with a `cursor` for the next page. See [reading picks](#reading-picks-without-taking-them). |
| `reading` | `status()` is the pod's state: when it reads, what it found, and any problem with a fix. `set({ paused })` pauses or resumes reading; `readNow()` starts a read. |
| `model` | `chatCompletions(body, signal)` sends an OpenAI-style chat request to the pod's AI service. |
| `news` | `graphql(body)` asks the data server, for the news operations the pod allows. |
| `display`, `commands` | The tables the Mera News app shows, and the named changes it makes. The sync plugin uses them; pairing the app with a pod is not available yet. |
| `events` | `on('changed', listener)` after a change to what the app's tables hold (the profile and the picks among them) or to the pick history, at most every two seconds. `on('notify', listener)` with each new `emergency` and `high` pick. Both return a function that stops listening. |

`display`, `commands`, `events` and `reading.readNow` are in version 2 only. A pod error carries a `code`, a `message` and a `next` step you can show as they are.

## Reading picks without taking them

The pod hands each pick out once. `suggestions.get` without `since` returns the picks after the last one delivered, and every call moves that point, whoever makes it. So a plugin that only shows picks must pass `peek: true`:

```js
const reply = await ctx.services.suggestions.get({ since: 'all', limit: 20, peek: true });
```

Without `peek`, the picks your page shows are marked as delivered, and your AI app's `get_suggestions` no longer gets them.

## Outbound requests

Inside the pod, `fetch` reaches only the origins `pod.json` names: the data server, the AI service and the notifiers. A request anywhere else is refused, and the pod logs `blocked request to <origin>` once. This guards against mistakes. It is not a sandbox: a plugin runs with the pod's full access, so only run plugins you trust.

## Installing a plugin

By the path of its folder, after building it:

```json
"plugins": [
  { "package": "/home/you/my-plugin", "config": { "port": 8790 } }
]
```

Or by package name, after installing it into the pod's home folder (`~/.mera-news-pod`, or `MERA_POD_HOME`) from git or a local path, for example `npm install --prefix ~/.mera-news-pod git+https://github.com/you/my-plugin.git`, then `{ "package": "my-plugin" }`.

Restart the pod after a change, and run `node build/cli.js check` to see each plugin's `describe()` lines.

## Testing a plugin

Add the pod as a development dependency (`"mera-news-pod": "git+https://github.com/Mera-News/mera-news-pod.git#main"`). `mera-news-pod/testing` holds the fakes the pod tests itself with, each a local server:

- `startFakeDataServer({ articles, topics })`: a data server that answers the public news schema with the articles you give it.
- `startFakeModel({ responder })`: an AI service that answers the same input with the same reply. `defaultResponder` makes topics from a fact's words and rates articles from their text.
- `recordedOrigins(...fakes)`: every origin the fakes were asked, to check a plugin reached nothing else.

Start a real pod against them, as the plugins in mera-news-pod-plugins do in their tests, or give your plugin hand-made `services` in a unit test.

## What a plugin may see early on

- **While the data server's search indexes are being built**, in the first minutes after it starts, a read fails. `reading.status()` lists the problem `read_failing` and `suggestions.get` says `problem`. The next read, at most `reading.everyMinutes` later, succeeds once the indexes are ready.
- **Publication names are shown as the feeds give them.** The data server you run does not hold the tidied names Mera's own server keeps, so a pick's `publication` is the feed's own name for itself.

## Sharing a plugin

Keep it in your own repository and point people at it, or add it to the [community list or this collection](https://github.com/Mera-News/mera-news-pod-plugins/blob/main/CONTRIBUTING.md#submitting-a-plugin).
