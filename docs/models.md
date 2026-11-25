# Choosing a model

Use any model your AI service offers through an OpenAI-compatible API, hosted or on your own machine. There is no list of supported models.

The prompts are tuned on the models the Mera News app uses. A small local model may fail to follow the reply format, and then reads fail or the picks are poor. If that happens, try a larger model, or change the prompts, see [harness](harness.md).

`node build/cli.js check` tells you whether the model answers and knows the name you gave. On the website, You > AI service tests both models before it saves them, see [running your own pod](self-hosting.md#set-the-ai-service-from-the-website).

The pod uses two models: `ai.model` for chat, your profile and topics, and `ai.relevanceModel` for deciding which stories are for you. The second runs many times per read, so a smaller, faster model works well there.

## What a read costs

Requests grow with the number of new articles, since they are rated in batches, and with how many are kept, since each kept one gets its reason written. In the end-to-end test, two facts and ten fresh articles took 10 to 14 model requests in all, counting the requests that make topics from the facts. Set `ai.concurrency` to what your service allows.
