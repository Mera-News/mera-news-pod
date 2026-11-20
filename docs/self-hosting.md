# Running your own pod

The pod keeps your news profile on your machine, reads the news on a schedule and keeps the stories that matter to you, each with a one-line reason. You reach it through a plugin, see [clients](clients.md).

It needs Node 22.13 or newer, a Mera News data server, and an AI service with an OpenAI-compatible API. The AI service can run on your own machine.

Run the data server first, with [its guide](https://github.com/Mera-News/mera-news-data-server/blob/dev/docs/self-host.md). The pod needs its search, which the data server offers only with a key, so set it up as its step 21 says: `NEWS_API_OPEN=false` and `MERA_NEWS_API_KEY` in the data server's `.env`, then the same key as `dataApiKey` in the pod's `secrets.json` and the data server's address as `dataServer.url` in its `pod.json` (both below). The data server's open mode, without a key, is for trying the data server alone.

## Install

```
git clone https://github.com/Mera-News/mera-news-pod
cd mera-news-pod
npm install
```

`npm install` builds the pod into `build/`. It runs under plain `node`, with no loader.

## Set up

```
node build/cli.js init
```

This writes `pod.json` and `secrets.json` in `~/.mera-news-pod`. Set `MERA_POD_HOME` to use another folder. The folder and both files are readable by you only. `init` never overwrites an existing `pod.json`.

Edit `pod.json`:

```json
{
  "dataServer": { "url": "http://127.0.0.1:3002" },
  "ai": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "your-model-name" },
  "reading": { "everyMinutes": 15 },
  "language": "en",
  "region": "NL",
  "notify": { "ntfy": { "enabled": false, "url": "https://ntfy.sh/your-topic" } },
  "plugins": []
}
```

| Key | Meaning |
|---|---|
| `dataServer.url` | The data server. `/graphql` is added when missing. |
| `ai.baseUrl`, `ai.model` | The AI service and the model it should use. Both are required. |
| `ai.concurrency` | Requests in flight at once, 1 to 16. Default 2. |
| `ai.callTimeoutSeconds` | How long one request may take, 10 to 3600. Default 300. |
| `reading.everyMinutes` | How often the pod reads, 5 to 1440. Default 15. |
| `reading.runTimeoutMinutes` | How long one read may take, 1 to 240. Default 30. |
| `language`, `region` | Taken from your machine by `init`. Change them if they are wrong. |
| `notify` | See [notifiers](#notifiers). |
| `plugins` | The plugins to run, see [clients](clients.md) and [writing a plugin](plugins.md). |

Keys go in `secrets.json`, which must not be readable by other users (`chmod 600`):

```json
{ "aiApiKey": "...", "dataApiKey": "..." }
```

`dataApiKey` is the data server's `MERA_NEWS_API_KEY`. `MERA_POD_AI_API_KEY` and `MERA_POD_DATA_API_KEY` override them. Leave `aiApiKey` out when your AI service needs none.

The settings are read when the pod starts. After an edit, restart it.

## Check and start

```
node build/cli.js check
node build/cli.js start
```

`check` sends one request to the data server and one to the model, loads the plugins and says in one sentence what to fix. `start` runs the same check, then runs the pod and prints how often it reads. Stop it with Ctrl-C or a stop signal. Only one pod can run on a home folder at a time.

The pod also says what is wrong while it runs. Ask your assistant for the status, or see [limits](limits.md). Problems you fix yourself:

| Problem | What to do |
|---|---|
| `ai_key_refused` | The AI service refuses the key. Set `aiApiKey`, restart. |
| `data_key_refused` | The data server refuses the key. Set `dataApiKey`, restart. |
| `read_failing` | The last read failed. Check that both servers run, then run `check`. |
| `picks_history_reset` | The pick list could not be read. It was moved to `data/picks.json.unreadable` and some picks may arrive a second time. |

`no_topics` and `topics_failed` are for the assistant: adding the fact again retries it.

## How reading works

A read fetches recent articles for your topics, rates each one and keeps the ones that matter, with a reason. When a new fact's topics are ready, a read starts right away. How soon the first picks arrive depends mostly on your AI service, since every new article is rated and every kept one gets its reason written. Otherwise the pod reads every `reading.everyMinutes`.

Your assistant can pause reading or change the interval. Both are kept in `data/control.json`. Once the assistant has changed the interval, that choice wins over `reading.everyMinutes` in `pod.json`; until then `pod.json` decides.

Reports that the data server groups into one story, or whose headlines and named people, places and organisations overlap strongly, come back as one pick, the way the Mera News app groups them in its Feed.

While the machine sleeps, the pod does nothing. After it wakes, the pod checks every few seconds whether a read is due and starts one once the interval has passed.

## Keep it running

Restart on failure, and set `MERA_POD_HOME` if you do not use the default. We have not run these two service files ourselves yet. The launchd file passes `plutil -lint`.

systemd, in `~/.config/systemd/user/mera-news-pod.service`:

```
[Unit]
Description=Mera News pod

[Service]
ExecStart=/usr/bin/node /home/you/mera-news-pod/build/cli.js start
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now mera-news-pod`. A user service stops when you log out unless lingering is on: `loginctl enable-linger`.

launchd, in `~/Library/LaunchAgents/news.mera.pod.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>news.mera.pod</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/mera-news-pod/build/cli.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
```

Then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/news.mera.pod.plist`. Use the paths of your own `node` and checkout.

## Notifiers

All three are off by default and are set in `notify` in `pod.json`. Each sends new picks at the levels `emergency` and `high`, and nothing else.

- `ntfy`: `{ "enabled": true, "url": "https://ntfy.sh/<topic>" }`. It gets the headline, the level and the link. Anyone who knows an ntfy topic name can read it, so `init` makes a long random name and the message carries no reason.
- `webhook`: `{ "enabled": true, "url": "https://..." }`. It gets one request with every new pick, `{ "picks": [{ "title", "url", "level", "reason" }] }`: the headline, link, level and the one-line reason.
- `meraNewsApp`: `{ "enabled": true, "url": "https://..." }`. It shows a new top story on the phone paired through the sync plugin, through Mera's sign-in service: the headline and the story's id, at most one every 15 minutes, emergency stories at once. See [notifications on the phone](sync.md#notifications-on-the-phone) for what Mera, Expo and Apple or Google receive.

A saved fact is never sent. Turning a notifier on later sends only picks that arrive after that. A send to ntfy or the webhook that fails is tried again; a notification to the phone is tried at most twice.

## Update

Stop the pod, then:

```
git pull
npm install
```

and start it again. A pod refuses to start on a database written by a newer version, so do not go back to an older version after updating.

## Back up

Stop the pod first, then copy the whole home folder (`~/.mera-news-pod`). It holds your config, your keys, the profile (`data/mera.db`) and the pick list. Copying while the pod runs can give a broken copy.

## Wipe

Stop the pod and delete `~/.mera-news-pod/data`. That removes the profile, the pick list and the plugin token. Delete the whole folder to remove the config and keys too.
