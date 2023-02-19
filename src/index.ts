/**
 * TODO:
 * use buffer frames:
 * - when "ssam:ffmpeg-newframe" is received, first store in frameBuffer array.
 * - processFrames() will use recursion to process buffer frames.
 *   - but, would it block other operations?
 * - when "ssam:ffmpeg-done" is received, do not stdin.end().
 * - need to process any remaining buffer frames first.
 *
 * or, is there a better way to handle the pressure?
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
let frameBuffer: Buffer[] = [];

export const ssamFfmpeg = (opts: ExportOptions = {}): PluginOption => ({
  name: "vite-plugin-ssam-ffmpeg",
  apply: "serve",
  configureServer(server: ViteDevServer) {
    const { log, outDir } = { ...defaultOptions, ...opts };

    let stdin: Writable;
    let stdout: Readable;
    let stderr: Readable;

    const processFrames = () => {
      //
    };

    server.ws.on("ssam:ffmpeg", async (data, client) => {
      const { filename, format, fps } = data;

      // FIX: in Ssam, "ssam:ffmpeg" and "ssam:ffmpeg-newframe" are sent at the same time.
      //      b/c ffmpeg is not ready, first few frames are dropped.
      //      there's no way to control when new frame is ready,
      //      1. incoming frames will first need to be stored in buffer,
      //      and processed when it can.
      //      2. or, can "pipe" be a solution?
      if (format === "mp4") {
        // check for ffmpeg installation
        await execPromise(`ffmpeg -version`)
          .catch((err) => {
            // if no ffmpeg, warn and abort
            const msg = `${prefix()} ${yellow(err)}`;
            log &&
              client.send("ssam:warn", { msg: removeAnsiEscapeCodes(msg) });
            console.warn(`${msg}`);
          })
          .then(() => {
            isFfmpegInstalled = true;

            // if outDir not exist, create one
            // TODO: use promise
            if (!fs.existsSync(outDir)) {
              console.log(
                `${prefix()} creating a new directory at ${path.resolve(
                  outDir
                )}`
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
              '-movflags', 'faststart',
            ]
            const command = spawn("ffmpeg", [
              ...inputArgs,
              ...outputArgs,
              "-y",
              path.join(outDir, `${filename}.${format}`),
            ]);

            ({ stdin, stdout, stderr } = command);

            const msg = `${prefix()} recording (mp4) started`;
            log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
          });
      }
    });

    server.ws.on("ssam:ffmpeg-newframe", async (data, client) => {
      if (!isFfmpegInstalled) return;

      // record a new frame

      // 1. writing directly - this causes a few frames dropout at beginning
      const buffer = Buffer.from(data.image.split(",")[1], "base64");
      stdin.write(buffer);

      // send log to client
      const msg = `${prefix()} ${data.msg}`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });

    server.ws.on("ssam:ffmpeg-done", (data, client) => {
      if (!isFfmpegInstalled) return;

      // finish up recording
      stdin.end();

      // send log to client
      const msg = `${prefix()} ${data.msg}`;
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
    });
  },
});
