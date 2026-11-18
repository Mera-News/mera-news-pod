# Changing the prompts

The pod rates and explains articles with prompts written for the models Mera News uses. If your model does better with other wording, you can replace them. Most people never need to.

Make a folder `harness` in the pod home (`~/.mera-news-pod/harness`). Without a `harness.json` in it, the folder is ignored.

`harness.json` can be as small as:

```json
{}
```

`extends` names the set to start from. It defaults to `cloud-base` and must be a cloud set.

Every other file is a prompt that replaces one of the base prompts. Its name is the prompt's name with `.md` added, in the same folder layout, for example `scoring/cloud-relevance-system-prompt.md`. The names are the files of `lib/harnesses/cloud-base` in the `mera-news-client` repository.

Rules for a prompt file:

- It ends with exactly one newline.
- A first line that is an HTML comment (`<!-- ... -->`) is a note for readers and is dropped.
- `{{> name}}` pastes in another prompt of the base.
- Some prompts are pasted into larger ones. Replacing one of those is refused, and the error names the larger prompts to replace instead.

The folder applies to the model set in `ai.model`. It is read when the pod starts, so restart after a change. A mistake stops the pod at start with a sentence naming the file or the prompt.
