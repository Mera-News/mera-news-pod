# Privacy

Your profile stays on the machine that runs the pod. Nothing phones home: the pod and its client talk only to the data server, the AI service if you set one, and the notifiers you configure in `pod.json`, and refuse any other address. These are the places information still goes.

1. **The MCP client's vendor.** Whatever your assistant reads from the pod goes to the company that runs the assistant: your facts, topics and picks. Use a local client if that matters to you.
2. **The AI service, if you set one.** It sees your whole profile and the text of each article it rates. You choose it on the website or in `pod.json`, and its key stays on this computer. Point `ai.baseUrl` at a model on your own machine to keep that at home. Without one, your assistant does the picking when you ask, and point 1 covers what it sees.
3. **The data server.** Your topics go to it as search queries, and the name of a place you add is looked up there. The text of a fact is never sent. With Mera News's data server (the Mera News plugin uses it), Mera Labs receives those topic texts and searches. Run your own data server and they stay with you.
4. **Notifiers.** A public ntfy topic can be read by anyone who knows its name, and it gets the headline, the level and the link of each important pick. A webhook gets the same plus the one-line reason, at the address you give. A saved fact is never sent.
5. **Plugins.** A plugin is code that runs inside the pod with its full access, so only install plugins you trust.
6. **A paired phone.** Pairing the Mera News app with a pod is not available yet. The phone paired through the `sync` plugin sees the whole profile, the chats sent through the pod and the reading. A pod is for one person and pairs with one phone; see [pairing the app](sync.md).
7. **The website.** It runs inside the pod on `127.0.0.1` and loads nothing from other sites except publishers' images. A tab signs in with a one-time link, and stays signed in across restarts until the session expires or you sign out on You.
8. **A tunnel.** If you reach the pod from outside your network, whoever runs the tunnel can read the traffic it carries, including the token. A phone that opens the website through `tailscale serve` or a tunnel sees your profile and news like the computer does.

See [clients](clients.md) for the capability address, which works as a password.
