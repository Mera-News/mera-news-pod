# Pairing the Mera News app

**Pairing the Mera News app with a pod is not available yet.** This page describes the sync plugin's design.

The Mera News app can show a pod's news, profile and picks instead of reading the news on the phone. The phone then stops reading the news itself: the pod reads, and the phone shows what the pod holds and sends your changes to it. This works through the `sync` plugin, which lives in the `mera-news-pod-plugins` repository, in `packages/sync`.

## One pod, one person, one phone

A pod is for one person, and it pairs with one phone at a time. A paired phone sees everything the pod holds: the whole profile, the chats sent through the pod and the reading. A second person on the same pod would see all of it, so the pod refuses a second pairing while a phone is paired.

An assistant connected through the `mcp` plugin is not a paired phone. The same person can use an assistant and one phone on one pod.

## Install the plugin

If you have not built the plugins yet:

```
git clone https://github.com/Mera-News/mera-news-pod-plugins
cd mera-news-pod-plugins
npm install
npm run build
```

Name it in `pod.json`, by the path of the package:

```json
"plugins": [
  { "package": "/home/you/mera-news-pod-plugins/packages/sync", "config": { "publicHost": "pod.example.com" } }
]
```

Restart the pod. All settings are optional:

| Key | Default | Meaning |
|---|---|---|
| `port` | 8788 | The port to listen on. |
| `host` | `127.0.0.1` | The interface to listen on. |
| `publicHost` | none | The name the phone reaches the pod at, such as `pod.example.com`. |
| `podName` | the machine's name | The name the app shows for this pod. |

## HTTPS only

The app talks to a pod only over HTTPS, and refuses a plain `http://` address. Every request carries the phone's device token, and anyone who can read the traffic could use it. Phones also refuse unencrypted connections by default.

The plugin itself speaks plain HTTP on `127.0.0.1`. Put a reverse proxy with a certificate, or a tunnel you run, in front of it, and set `publicHost` to the name it answers at. A phone on the same Wi-Fi still needs that HTTPS address.

## Pair a phone

Run this in the `mera-news-pod-plugins` folder, on the pod's machine:

```
npx mera-news-pod-sync pair --base https://pod.example.com
```

Add `--home <folder>` when the pod does not use the default home. It prints a code and a link that starts with `meraapp://pod-pair`. Open the link on the phone, or point the phone's camera at it if you show it as a QR code. In the app, pairing starts from Settings.

The code has 10 characters, works once and lasts 10 minutes. After 10 wrong codes in all, or 5 tries in one minute, pairing stops until you print a new code.

**Pairing erases the phone's own data.** The app warns you first. It keeps only your sign-in, your display choices, tutorial progress and backup settings; your chats on the phone are erased too. After pairing, the phone shows only what the pod holds. Nothing from the phone is merged into the pod, and a phone's profile cannot be moved to a pod yet. If the pod has no profile, add facts from the app or through an assistant.

## Change or remove the paired phone

To see the paired phone, and to revoke it:

```
npx mera-news-pod-sync devices
npx mera-news-pod-sync devices --revoke <id>
```

While a phone is paired, `pair` prints no code and says which phone to revoke. Revoke it, then run `pair` again for the new phone. A revoked phone is refused on its next request. Logging out of the app also revokes the phone, when the pod can be reached.

## What a paired phone can do

A paired phone holds a device token. With it the phone can read your profile, feed and picks, change your profile, pause or resume reading, and use the pod's AI service and news server through the pod. That is the same reach as the MCP token. Revoke a phone you no longer use.

The AI service's key and the news server's key stay on the pod. The phone never sees them.

## Settings

The language, Skip notes, the 24-hour filter, the Explore choices and the topics you rejected are the pod's settings: the phone changes them on the pod. The language is also the language the pod writes reasons in. Where you are in the feed stays on the phone.

## Backups

The app's iCloud and Google Drive backups are off while the phone is paired, since the data is on the pod. Backing up the pod is up to you: stop it and copy its home folder, as in [back up](self-hosting.md#back-up).

## Notifications on the phone

**Notifications on the phone are not available yet.**

The pod can show a new top story on the paired phone as a notification. Tapping it opens that story in the Mera News app. This is off unless you turn it on in `pod.json`:

```json
"notify": { "meraNewsApp": { "enabled": true, "url": "https://relay.example.org" } }
```

`url` is the address of the Mera sign-in service your Mera News app uses: `https://` and a host name, nothing after it. If it does not match, the Mera News app does not use the pod for notifications and shows the address it expects.

Only Mera can send notifications to the Mera News app, so the pod sends each one through Mera's sign-in service. It serves only the Mera News app. If you build your own app, use [ntfy or the webhook](self-hosting.md#notifiers), or a plugin with your own push service: Mera relays nothing for other apps.

The phone gives the pod a pass, which lasts at most 14 days, and the app renews it. When the pod finds a new story at the level `emergency` or `high`, it sends the pass, the story's headline and the story's id to Mera's sign-in service, which sends the phone one notification showing the headline.

How often:

- At most one notification every 15 minutes. Emergency stories go at once.
- Each story is sent once. When Mera's service does not answer, the pod tries once more, so now and then a notification can arrive twice.
- A headline with a web address in it is not sent.
- Mera also limits each phone to 10 notifications an hour and 40 a day.

What leaves the pod, for each notification:

- Mera's sign-in service receives the headline, the story's id (the article id Mera's news data uses), which Mera account it is for (from the pass), and your pod's network address. It does not store or log the headline or the id. It keeps a count per phone for the limit, for at most two days.
- Expo, and then Apple or Google, receive the headline and the story's id, addressed to your phone, and keep them under their own rules.
- Nothing else is sent: no reason, facts, link or topic.

The pass is a secret. It is kept in `push-pass.json` in the sync plugin's folder, readable only by you. Every plugin the pod runs, and every backup of the pod's home folder, holds a pass that works until it is revoked or expires. Starting the pod with this notifier off deletes the pass. Turning notifications off in the app, unpairing or signing out ends the pass at Mera when the phone is online.

**A lost phone keeps getting notifications until you revoke it** with `mera-news-pod-sync devices --revoke <id>`, which deletes its pass at once.

## What the phone still sends to Mera

While paired, the phone sends Mera only requests about your Mera News account: signing in, your subscription, notifications and feedback requests. Your profile, your feed and your chats go to your pod.

## When the versions differ

The phone and the pod must run the same version to share data. If they do not, the app says which side is older. Update that side: the app from the store, or the pod with `git pull` and `npm install`, then restart it.
