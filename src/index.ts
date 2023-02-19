/**
 *
 * - check ffmpeg install, if not round, abort
 * - "ssam:ffmpeg" received, set up ffmpeg encoder
 * - "ssam:ffmpeg-newframe" received, store in frameBuffers[] and start encoding from first frame
 * - "ssam:ffmpeg-done" received, encode remaining buffer frames and end.
 *
 * it used to be "ssam:ffmpeg" will both check ffmpeg --version and set up encoder. that resulted in first few frames missing.
 * so now, install check is done when plugin is first loaded.
 *
 * FIX
 * - encoding is very slow during "ffmpeg-newframe" event as it needs to store and process at the same time.
 * - when video is very long and large, video file is not playable. buffer array gets very large.
 * - 4000x4000 results in pixelated video with libx264 codec. is it codec limitation or settings?
 *
 * REVIEW
 * - better handle streaming
 * - one option is to sync the client recordLoop() and ffmpeg encoding speed.
 *   - this method will not need a big buffer
 *   - send a message to client that it's okay to move to next frame
 */

import type { PluginOption, ViteDevServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { Readable, Writable } from "stream";
import kleur from "kleur";
import ansiRegex from "ansi-regex";

type ExportOptions = {
  log?: boolean;
  outDir?: string;
};

const defaultOptions = {
  log: true,
  outDir: "./output",
};

const { gray, green, yellow } = kleur;

const execPromise = (cmd: string) => {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(stderr);
      }
      resolve(stdout);
    });
  });
};

const prefix = () => {
  return `${gray(new Date().toLocaleTimeString())} ${green(`[ssam-ffmpeg]`)}`;
};

const removeAnsiEscapeCodes = (str: string) => {
  return str.replace(ansiRegex(), "");
};

let isFfmpegInstalled = false;
let isFfmpegReady = false; // ready to receive a new frame?
let frameBuffers: Buffer[] = [];

export const ssamFfmpeg = (opts: ExportOptions = {}): PluginOption => ({
  name: "vite-plugin-ssam-ffmpeg",
  apply: "serve",
  async configureServer(server: ViteDevServer) {
    const { log, outDir } = { ...defaultOptions, ...opts };

    // check for ffmpeg install first when plugin is loaded
    await execPromise(`ffmpeg -version`)
      .catch((err) => {
        // if no ffmpeg, warn and abort
        const msg = `${prefix()} ${yellow(err)}`;
        log && server.ws.send("ssam:warn", { msg: removeAnsiEscapeCodes(msg) });
        console.warn(`${msg}`);
      })
      .then(() => {
        isFfmpegInstalled = true;
      });

    let stdin: Writable;
    let stdout: Readable;
    let stderr: Readable;

    server.ws.on("ssam:ffmpeg", async (data, client) => {
      if (!isFfmpegInstalled) {
        const msg = `${prefix()} ffmpeg was not found`;
        log && client.send("ssam:warn", { msg: removeAnsiEscapeCodes(msg) });
        console.warn(msg);
      }

      const { filename, format, fps } = data;

      if (format === "mp4") {
        // if outDir not exist, create one
        // TODO: use promise
        if (!fs.existsSync(outDir)) {
          console.log(
            `${prefix()} creating a new directory at ${path.resolve(outDir)}`
          );
          fs.mkdirSync(outDir);
        }

        //prettier-ignore
        const inputArgs = [
              "-f", "image2pipe", "-framerate", fps, "-c:v", "png", '-i', '-',
            ]
        //prettier-ignore
        const outputArgs = [
              "-c:v", "libx264", "-pix_fmt", "yuv420p", 
              "-preset", "slow", "-crf", "18", "-r", fps, 
              // '-movflags', 'faststart',
              '-movflags', '+faststart',
            ]
        const command = spawn("ffmpeg", [
          "-y",
          ...inputArgs,
          ...outputArgs,
          path.join(outDir, `${filename}.${format}`),
        ]);

        ({ stdin, stdout, stderr } = command);

        isFfmpegReady = true;

        const msg = `${prefix()} streaming (mp4) started`;
        log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
        console.log(msg);
      }
    });

    server.ws.on("ssam:ffmpeg-newframe", async (data, client) => {
      if (!isFfmpegInstalled) return;

      // record a new frame

      // 1. writing directly - this causes a few frames dropout at beginning
      // const buffer = Buffer.from(data.image.split(",")[1], "base64");
      // stdin.write(buffer);

      // 2. add to buffers first
      frameBuffers.push(Buffer.from(data.image.split(",")[1], "base64"));
      if (isFfmpegReady) {
        while (frameBuffers.length > 0) {
          const frame = frameBuffers.shift();
          frame && stdin.write(frame);
        }
      }

      // send log to client
      const msg = `${prefix()} ${data.msg}`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });

    server.ws.on("ssam:ffmpeg-done", (data, client) => {
      if (!isFfmpegInstalled) return;

      // handle remaining frames
      while (frameBuffers.length > 0) {
        const frame = frameBuffers.shift();
        stdin.write(frame);
      }

      // finish up recording
      stdin.end();

      // reset state
      isFfmpegReady = false;

      // send log to client
      const msg = `${prefix()} ${data.msg}`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });
  },
});
