---
name: paddock-images
description: Generate or edit images (NeuralDeep / Qwen-Image) with the paddock-images shell command and show them inline. Use when the user asks to draw, generate, illustrate, render an image, or to change/edit a picture they attached.
---

# Images in Paddock

Images are made by a shell command. It works with any model. Do **not** draw images yourself (Python, SVG, ASCII) and do not call the NeuralDeep API by hand: the command already handles the key, proxy and waiting.

```bash
node {{BIN}} generate --prompt "what to draw" --save-to "$PWD/images" [--aspect 16:9] [--n 2]
node {{BIN}} edit --images /abs/a.png,/abs/b.png --prompt "what to change" --save-to "$PWD/images"
```

- Aspect: `1:1`, `4:3`, `3:4`, `16:9`, `9:16` (default comes from Paddock settings).
- It takes 10–60 s and prints `saved: /path.png` for each image. Run one generation at a time.
- The prompt can be in any language.
- User attachments are in `<working dir>/.paddock/uploads/`.
- `edit` works only if editing is enabled in Paddock settings; if the command says it is off, tell the user.

After it finishes, **always** show every image in your answer as markdown with the absolute path: `![short description](/absolute/path.png)`. Paddock renders it as a thumbnail.

If the command fails, show the error to the user as is. Do not substitute a hand-drawn picture.
