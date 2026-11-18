# Privacy

Your profile stays on the machine that runs the pod. Nothing phones home: the pod and its client talk only to the data server, the AI service and the notifiers you configure in `pod.json`, and refuse any other address. These are the places information still goes.

1. **The MCP client's vendor.** Whatever your assistant reads from the pod goes to the company that runs the assistant: your facts, topics and picks. Use a local client if that matters to you.
2. **The AI service.** It sees your whole profile and the text of each article it rates. Point `ai.baseUrl` at a model on your own machine to keep that at home.
3. **The data server.** Your topics go to it as search queries. Run your own data server, as the pod expects, and they stay with you.
4. **Notifiers.** A public ntfy topic can be read by anyone who knows its name, and it gets the headline, the level and the link of each important pick. A webhook gets the same plus the one-line reason, at the address you give. A saved fact is never sent.
5. **Plugins.** A plugin is code that runs inside the pod with its full access, so only install plugins you trust.
6. **A tunnel.** If you reach the pod from outside your network, whoever runs the tunnel can read the traffic it carries, including the token.

See [clients](clients.md) for the capability address, which works as a password.
