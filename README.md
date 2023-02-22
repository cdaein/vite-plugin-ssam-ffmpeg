# vite-plugin-ssam-ffmpeg

This plugin is created for [Ssam](https://github.com/cdaein/ssam) to export mp4 videos by using `ffmpeg` on the server side.

## Install

```sh
npm i -D vite-plugin-ssam-ffmpeg
```

> If you create a Ssam sketch using `npm create ssam@latest`, this plugin is already set up for you.

## How It Works

When the plugin is loaded, it will first check `ffmpeg` is available on the machine. When mp4 recording is initiated from Ssam (client side), the `ssam:ffmpeg` message is sent to the plugin. The ffmpeg process is spawned and `image2pipe` streaming is setup. The plugin then waits for `ssam:ffmpeg-newframe` message, which will be written to the output video. It then sends `ssam:ffmpeg-reqframe` to the client and this will go on until there's no more frame to be recorded. The client finally sends `ssam:ffmpeg-done` message to the plugin which will finalize the encoding process.

To not overwhelm the encoding process, `newframe` and `reqframe` cycle is used. Otherwise, the speed of the client sending new frames will clog up the stream.

## License

MIT
