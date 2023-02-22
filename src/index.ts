/**
 *
 * - check ffmpeg install, if not found, abort
 * - "ssam:ffmpeg" received, set up ffmpeg encoder
 * - "ssam:ffmpeg-newframe" received, encode the frame, and when it's finished request next frame with "ssam:ffmpeg-reqframe".
 * - on client-side, it will wait until "ffmpeg-reqframe" is received and then advance time and send a new frame. (send/receive/encode is synched)
 * - when "ssam:ffmpeg-done" received, finish encoding
 *
 * FIX
 * - 4000x4000 results in pixelated video with libx264 codec.
 *   - is it codec limitation or settings?
 *   - stream chunks?
 *
 * REVIEW
 * - alternative: better handle streaming through pipe?
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
// const MAX_BUFFER_SIZE = 4;

let filename: string;
let format: string;
let framesRecorded = 0;
let totalFrames = 0;

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

      ({ filename, format, totalFrames } = data);

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
              "-f", "image2pipe", "-framerate", data.fps, "-c:v", "png", '-i', '-',
            ]
        //prettier-ignore
        const outputArgs = [
              "-c:v", "libx264", "-pix_fmt", "yuv420p", 
              "-preset", "slow", "-crf", "18", "-r", data.fps, 
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

      // write frame and when it's written, ask for next frame
      const buffer = Buffer.from(data.image.split(",")[1], "base64");
      stdin.write(buffer, () => {
        // request next frame
        client.send("ssam:ffmpeg-reqframe");
      });

      framesRecorded++;

      // send log to client
      const msg = `${prefix()} recording (mp4) frame... ${framesRecorded} of ${totalFrames}`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });

    server.ws.on("ssam:ffmpeg-done", (data, client) => {
      if (!isFfmpegInstalled) return;

      // handle remaining frames
      // while (frameBuffers.length > 0) {
      //   const frame = frameBuffers.shift();
      //   stdin.write(frame);
      // }

      // finish up recording
      stdin.end();

      // reset state
      isFfmpegReady = false;
      framesRecorded = 0;

      // send log to client
      const msg = `${prefix()} ${path.join(
        outDir,
        `${filename}.${format}`
      )} recording (mp4) complete`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });
  },
});
