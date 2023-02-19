# `vite-plugin-ssam-ffmpeg`

> ⚠️ This module is early in its development. Expect breaking changes to come.

## Set up

In `vite.config.js`:

```js
export default defineConfig({
  plugins: [ssamFfmpeg()],
});
```

<!-- ## Export an image

```js
window.addEventListener("keydown", (ev) => {
  if (ev.key === "s") {
    if (import.meta.hot) {
      import.meta.hot.send("ssam:ffmpeg", {
        format: "png",
      });
    }
  }
});
``` -->

## Export a video

```js
window.addEventListener("keydown", (ev) => {
  if (ev.key === "v") {
    if (import.meta.hot) {
      // start recording
      import.meta.hot.send("ssam:ffmpeg", {
        format: "mp4",
      });
      // internal state
      recording = true;
    }
  }
});

// in animation loop
if (recording) {
  if (import.meta.hot) {
    import.meta.hot.send("ssam:ffmpeg-newframe", {
      image: canvas.toDataURL(),
    });
  }
}
```
